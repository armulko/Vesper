"""
layer_weights.py — per-layer VRAM cost from GGUF tensor metadata.

Drop-in for model_autoconfig.py. Reads only the GGUF header + tensor
directory (mmap'd, no weight data touched), so this is fast and cheap
even on 30GB+ files.

Layer numbering: llama.cpp names transformer-block tensors
"blk.<N>.<component>.weight" (e.g. blk.0.attn_q.weight, blk.31.ffn_down.weight).
Everything NOT matching "blk.<N>." — token_embd, output_norm, output.weight,
etc. — is bucketed separately as "non_layer" since it's always resident
(can't be selectively offloaded the way blk.N. layers can via n_gpu_layers).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import gguf

_BLK_RE = re.compile(r"^blk\.(\d+)\.")


@dataclass
class LayerWeightInfo:
    n_layer: int
    # bytes per transformer block, index == layer index (0-based)
    layer_bytes: list[int]
    # everything that isn't a blk.N.* tensor (embeddings, output head, norms)
    non_layer_bytes: int
    total_bytes: int

    @property
    def avg_layer_bytes(self) -> float:
        return sum(self.layer_bytes) / len(self.layer_bytes) if self.layer_bytes else 0.0


def parse_layer_weights(gguf_path: str | Path) -> LayerWeightInfo:
    """
    Parse a GGUF file's tensor directory and return per-layer byte sizes.

    Raises FileNotFoundError / gguf.GGUFReader's own errors on bad files —
    caller (model_autoconfig.py) already handles those paths for header
    parsing, so this follows the same contract.
    """
    reader = gguf.GGUFReader(str(gguf_path))

    # n_layer from metadata, e.g. "llama.block_count" / "<arch>.block_count"
    n_layer = _get_block_count(reader)

    layer_bytes = [0] * n_layer
    non_layer_bytes = 0
    seen_layers = set()

    for tensor in reader.tensors:
        m = _BLK_RE.match(tensor.name)
        if m:
            idx = int(m.group(1))
            if idx >= n_layer:
                # Metadata said n_layer but tensor directory disagrees —
                # trust the tensor directory, extend rather than drop data.
                layer_bytes.extend([0] * (idx - len(layer_bytes) + 1))
                n_layer = len(layer_bytes)
            layer_bytes[idx] += tensor.n_bytes
            seen_layers.add(idx)
        else:
            non_layer_bytes += tensor.n_bytes

    total_bytes = sum(layer_bytes) + non_layer_bytes

    return LayerWeightInfo(
        n_layer=n_layer,
        layer_bytes=layer_bytes,
        non_layer_bytes=non_layer_bytes,
        total_bytes=total_bytes,
    )


def _get_block_count(reader: "gguf.GGUFReader") -> int:
    """
    block_count lives under a per-architecture key, e.g. 'llama.block_count',
    'qwen2.block_count', 'phi3.block_count'. Rather than hardcode every
    architecture string, scan fields for the suffix.
    """
    for key, f in reader.fields.items():
        if key.endswith(".block_count"):
            return int(f.parts[f.data[0]][0])
    raise ValueError(
        "Could not find '<arch>.block_count' in GGUF metadata — "
        "unrecognized or malformed file."
    )


def layers_fitting_budget(info: LayerWeightInfo, vram_budget_bytes: int) -> int:
    """
    Prefix-sum greedy fit: llama.cpp's n_gpu_layers offloads the FIRST N
    transformer blocks to GPU, so this is NOT a general knapsack — it's a
    running-sum stop-at-first-overflow, O(n_layer).

    non_layer_bytes (embeddings/output head) are always resident on
    whichever device layer 0 or the output stage lands on — for a
    "how many blk.N layers fit in the remaining GPU budget" question,
    caller should have already subtracted non_layer_bytes (and any
    KV-cache reservation) from vram_budget_bytes before calling this.

    NOTE: this stops at the first layer that doesn't fit and never looks
    back. With large, non-uniform layers (e.g. ~330MB/layer on a 24B
    model) that can leave a gigabyte or more of budget unclaimed even
    though the actual best-fit answer was one layer fewer or short by a
    hair. See best_fit_layers_for_target() below for the version that
    actually optimizes for a target leftover instead of just "doesn't
    overflow".
    """
    remaining = vram_budget_bytes
    fit = 0
    for layer_size in info.layer_bytes:
        if layer_size <= remaining:
            remaining -= layer_size
            fit += 1
        else:
            break
    return fit


def best_fit_layers_for_target(
    info: LayerWeightInfo, vram_free_bytes: int, target_free_bytes: int
) -> int:
    """
    Pick the number of leading blk.N layers to offload such that leftover
    free VRAM is maximized WITHOUT EVER dropping below target_free_bytes.

    target_free_bytes is now a hard floor, not an "aim for, but may land
    on either side" target. The old version compared the two candidates
    straddling the crossover and could pick the one that dipped under
    target_free_bytes if it happened to be numerically closer — that's
    exactly the behavior we no longer want (a 300MB layer could eat
    into the safety margin down to a few hundred MB free). This version
    greedily takes layers while remaining leftover stays >= floor and
    stops the instant the next layer would breach it, full stop.

    Equivalent to layers_fitting_budget(info, vram_free_bytes -
    target_free_bytes) — kept as a separate function so call sites and
    semantics (floor, not raw budget) stay explicit and self-documenting.
    """
    budget = vram_free_bytes - target_free_bytes
    if budget <= 0:
        return 0

    remaining = budget
    fit = 0
    for layer_size in info.layer_bytes:
        if layer_size <= remaining:
            remaining -= layer_size
            fit += 1
        else:
            break
    return fit