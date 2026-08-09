# model_autoconfig.py
#
# Validation of per-model config + auto-parsing of GGUF metadata
# for initial population of model settings with dynamic KV-cache calculation.

import os
from gguf import GGUFReader

from .layer_weight_cache import get_layer_weights
from .layer_weights import best_fit_layers_for_target

REQUIRED_LLM_KEYS = {
    "context_size": int,
    "max_answer_tokens": int,
    "gpu_layers": int,
    "cpu_threads": int,
    "batch_size": int,
    "generation_timeout": (int, float),
    "lock_acquire_timeout": (int, float),
    "tokenize_timeout": (int, float),
    "summarize_n_predict": int,
    "summarize_temperature": (int, float),
}

# valid ranges for numeric fields [min, max]. gpu_layers is separate — -1 is legit there.
VALUE_RANGES = {
    "context_size": (128, 1_048_576),       # reasonable ceiling for any gguf context_length
    "max_answer_tokens": (1, 32_768),
    "cpu_threads": (1, 256),                 # no real hardware goes higher than this
    "batch_size": (1, 8192),
    "generation_timeout": (1, 3600),
    "lock_acquire_timeout": (1, 3600),
    "tokenize_timeout": (1, 600),
    "summarize_n_predict": (1, 32_768),
    "summarize_temperature": (0, 5),
}

# gpu_layers: -1 (all layers on GPU) is a legit special case, otherwise 0..MAX_GPU_LAYERS
MAX_GPU_LAYERS = 1024

# kept for backward compatibility in case it's imported from elsewhere
MIN_VALUES = {k: v[0] for k, v in VALUE_RANGES.items()}

REQUIRED_CHAT_TEMPLATE_KEYS = {
    "prompt_template": str,
    "system_start": str,
    "system_end": str,
    "inst_start": str,
    "inst_end": str,
    "stop_tokens": list,
}

REQUIRED_SD_KEYS = {
    "image_height": int,
    "image_width": int,
    "guidance_scale": (int, float),
    "avatar_steps": int,
    "avatar_base_prompt": str,
    "avatar_portrait_prompt": str,
    "avatar_fullbody_prompt": str,
}


def _check_keys(cfg, schema):
    """Returns a list of problems (empty = ok). Bulletproof check: type,
    range, empty strings/lists — nothing invalid should ever reach disk."""
    problems = []
    for key, expected_type in schema.items():
        if key not in cfg:
            problems.append(f"missing:{key}")
            continue
        val = cfg[key]

        # bool is a subclass of int in Python, but we have no checkboxes in the schema,
        # so True/False in a numeric field is always garbage from the frontend
        if isinstance(val, bool) and expected_type is not bool:
            problems.append(f"bad_type:{key}")
            continue

        if not isinstance(val, expected_type):
            problems.append(f"bad_type:{key}")
            continue

        # NaN/inf are formally floats, but isinstance would let them through silently
        if isinstance(val, float) and (val != val or val in (float("inf"), float("-inf"))):
            problems.append(f"not_finite:{key}")
            continue

        if key == "gpu_layers":
            # -1 = all layers on GPU (legit special case), otherwise 0..MAX_GPU_LAYERS
            if val != -1 and not (0 <= val <= MAX_GPU_LAYERS):
                problems.append(f"out_of_range:{key}")
            continue

        if isinstance(val, (int, float)):
            rng = VALUE_RANGES.get(key)
            if rng is not None and not (rng[0] <= val <= rng[1]):
                problems.append(f"out_of_range:{key}")
            continue

        if isinstance(val, str):
            if val.strip() == "":
                problems.append(f"empty_string:{key}")
            continue

        if isinstance(val, list):
            if len(val) == 0:
                problems.append(f"empty_list:{key}")
                continue
            if not all(isinstance(item, str) and item.strip() != "" for item in val):
                problems.append(f"bad_list_items:{key}")
            continue

    return problems


def validate_model_cfg(cfg, model_type):
    """model_type: 'llm' | 'sd'. Returns (is_valid: bool, problems: list[str])."""
    if not cfg:
        return False, ["empty_config"]

    if model_type == "llm":
        problems = _check_keys(cfg, REQUIRED_LLM_KEYS)
        tmpl = cfg.get("chat_template")
        if not isinstance(tmpl, dict):
            problems.append("missing:chat_template")
        else:
            problems += [f"chat_template.{p}" for p in _check_keys(tmpl, REQUIRED_CHAT_TEMPLATE_KEYS)]
    elif model_type == "sd":
        problems = _check_keys(cfg, REQUIRED_SD_KEYS)
    else:
        return False, ["unknown_model_type"]

    return (len(problems) == 0), problems


# --- Autodetect from GGUF metadata (LLM only) ---

def _read_gguf_meta(path):
    reader = GGUFReader(path)
    meta = {}
    for key, field in reader.fields.items():
        try:
            # for most text fields, data is an array of bytes/numbers — assemble into a string if it's a STRING-type KV
            if field.types and field.types[0].name == "STRING":
                meta[key] = str(field.parts[field.data[0]], encoding="utf-8", errors="ignore")
            else:
                val = field.parts[-1].tolist() if hasattr(field.parts[-1], "tolist") else field.parts[-1]
                
                # FIX: if the library returned a single-element list/array, unwrap it
                if isinstance(val, list) and len(val) == 1:
                    val = val[0]
                    
                meta[key] = val
        except Exception:
            continue
    return meta


def _detect_template_profile(chat_template_str):
    """Rough heuristic based on the jinja template: ChatML vs Mistral/INST-style vs unknown."""
    if not chat_template_str:
        return "unknown"
    s = chat_template_str
    if "<|im_start|>" in s:
        return "chatml"
    if "[INST]" in s or "[/INST]" in s:
        return "mistral"
    if "<|start_header_id|>" in s:
        return "llama3"
    return "unknown"


_PROFILE_TEMPLATES = {
    "mistral": {
        "prompt_template": "{system_start}{system}{system_end}{inst_start}{instruction}{inst_end}{char_name}:",
        "system_start": "[SYSTEM_PROMPT]",
        "system_end": "[/SYSTEM_PROMPT]",
        "inst_start": "[INST]",
        "inst_end": "[/INST]",
        "stop_tokens": ["[INST]", "[/INST]", "[SYSTEM_PROMPT]", "</s>"],
    },
    "chatml": {
        "prompt_template": "{system_start}{system}{system_end}\n{inst_start}{instruction}{inst_end}\n{char_name}:",
        "system_start": "<|im_start|>system\n",
        "system_end": "<|im_end|>",
        "inst_start": "<|im_start|>user\n",
        "inst_end": "<|im_end|>",
        "stop_tokens": ["<|im_start|>", "<|im_end|>"],
    },
    "llama3": {
        "prompt_template": "{system_start}{system}{system_end}{inst_start}{instruction}{inst_end}{char_name}:",
        "system_start": "<|start_header_id|>system<|end_header_id|>\n\n",
        "system_end": "<|eot_id|>",
        "inst_start": "<|start_header_id|>user<|end_header_id|>\n\n",
        "inst_end": "<|eot_id|>",
        "stop_tokens": ["<|eot_id|>", "<|start_header_id|>"],
    },
}


# --- KV-cache byte cost per element, by llama.cpp --cache-type-k/-v value ---
#
# fp16 baseline: 2 bytes/element per K or V tensor (4 total for K+V combined,
# which is what the old hardcoded "* 4" assumed unconditionally).
#
# turbo3/turbo4 compression ratios sourced from the TurboQuant KV cache
# implementation discussions (ggml-org/llama.cpp#20969 and related forks):
# turbo3 ~4.3-4.9x vs fp16, turbo4 ~3.8x vs fp16. Using the lower/more
# conservative end of each published range so the estimate stays a safe
# UNDER-estimate of savings (better to leave a bit of VRAM unclaimed than
# to promise gpu_layers that don't actually fit).
KV_CACHE_BYTES_PER_ELEMENT = {
    "f16": 2.0,
    "f32": 4.0,
    "q8_0": 1.0625,   # llama.cpp q8_0: 1 byte/val + small per-block scale overhead
    "turbo4": 2.0 / 3.8,
    "turbo3": 2.0 / 4.3,
}
DEFAULT_KV_CACHE_TYPE = "f16"


def debug_dump_keys(gguf_path):
    """Debug helper: dump all metadata keys to figure out what block_count is called."""
    meta = _read_gguf_meta(gguf_path)
    for k, v in meta.items():
        print(k, "=", v if not isinstance(v, list) or len(v) < 5 else f"[list len={len(v)}]")


def autodetect_llm_cfg(gguf_path, vram_free_gb=None, default_context_size=4096,
                        kv_cache_type=DEFAULT_KV_CACHE_TYPE):
    """Tries to assemble a sensible config based on the user's default context,
    dynamic KV-cache calculation, and available VRAM.
    
    default_context_size: taken from Vesper's global settings.
    kv_cache_type: the --cache-type-k/-v value model_manager.py will actually
        launch llama-server.exe with (e.g. "turbo3"). Passed in explicitly
        rather than hardcoded here so model_manager.py stays the single
        source of truth for what cache type is really running — if that
        ever changes, callers update one call site instead of this module
        drifting out of sync with the real launch command.
    """
    warnings = []
    meta = {}
    try:
        meta = _read_gguf_meta(gguf_path)
    except Exception as e:
        warnings.append(f"gguf_parse_failed: {e}")

    # --- Dynamic parsing of architecture params for KV-cache ---
    n_layers = None
    max_model_ctx = 4096   # Safe base fallback for the context limit
    head_count = None
    head_count_kv = None
    head_dim = None

    for k, v in meta.items():
        if k.endswith(".block_count"):
            try: n_layers = int(v)
            except: pass
        elif k.endswith(".context_length"):
            try: max_model_ctx = int(v)
            except: pass
        elif k.endswith(".attention.head_count"):
            try: head_count = int(v)
            except: pass
        elif k.endswith(".attention.head_count_kv"):
            try: head_count_kv = int(v)
            except: pass
        elif k.endswith(".attention.key_length"):
            try: head_dim = int(v)
            except: pass

    # FIX: Logical inference of attention structure. If this is pure MHA, 
    # there won't be a head_count_kv key in the metadata, but if head_count is present, that's legit.
    if head_count_kv is None and head_count is not None:
        head_count_kv = head_count

    # --- Determining and validating context size ---
    context_size = min(int(default_context_size), max_model_ctx)
    if context_size < int(default_context_size):
        warnings.append(f"requested_context_{default_context_size}_exceeds_model_limit_capped_to_{context_size}")

    # --- Determining the prompt template ---
    chat_template_str = meta.get("tokenizer.chat_template")
    profile = _detect_template_profile(chat_template_str)
    
    is_template_fallback = False
    if profile == "unknown":
        warnings.append("chat_template_profile_unrecognized_using_mistral_fallback")
        profile = "mistral"
        is_template_fallback = True

    template_cfg = dict(_PROFILE_TEMPLATES[profile])
    if is_template_fallback:
        template_cfg["is_unknown_fallback"] = True

    # --- Calculating GPU layers and KV-Cache overhead ---
    gpu_layers = -1
    kv_cache_gb = 0.0

    bytes_per_element = KV_CACHE_BYTES_PER_ELEMENT.get(kv_cache_type)
    if bytes_per_element is None:
        warnings.append(f"unknown_kv_cache_type_{kv_cache_type}_assuming_f16")
        bytes_per_element = KV_CACHE_BYTES_PER_ELEMENT["f16"]

    # FIX: Full symmetric protection against incomplete/exotic architecture metadata
    if n_layers is None or head_count_kv is None or head_dim is None:
        warnings.append("architecture_parameters_incomplete_layer_split_calculation_skipped")
    else:
        # K and V are each independently quantized to bytes_per_element,
        # hence "* 2" for the pair — this replaces the old fixed "* 4",
        # which silently assumed fp16 (2 bytes/element * 2 for K+V) even
        # when the server was actually launched with turbo3/turbo4/q8_0.
        kv_cache_bytes = context_size * n_layers * head_count_kv * head_dim * 2 * bytes_per_element
        kv_cache_gb = kv_cache_bytes / (1024 ** 3)

        if vram_free_gb is not None:
            # Layers aren't uniform in size (embed/output tensors skew the
            # naive file_size/n_layers average, and attention vs FFN width
            # varies by architecture) — get_layer_weights() reads the real
            # per-tensor byte sizes from the GGUF tensor directory instead
            # of assuming an even split. Cached by (path, size, mtime) so
            # repeated calls for the same file don't re-walk the tensor
            # list every time.
            try:
                layer_info = get_layer_weights(gguf_path)

                # Hard floor on VRAM headroom left unclaimed after fitting
                # layers — not a "CUDA runtime overhead" constant, and not
                # a soft aim-for-this target anymore. best_fit_layers_for_target()
                # below never lets leftover VRAM drop below this value; it
                # greedily takes layers up to the floor and stops the
                # instant the next one would breach it. 1GB default
                # (driver/runtime allocations, other apps, general OOM
                # safety margin).
                target_free_vram_gb = 1.0

                # non_layer_bytes (embeddings, output head, norms) are
                # always resident — not optional the way blk.N layers are —
                # so they come off the top before layer-fitting runs at all.
                vram_free_for_layers_bytes = (
                    (vram_free_gb - kv_cache_gb) * (1024 ** 3) - layer_info.non_layer_bytes
                )
                vram_free_for_layers_bytes = max(vram_free_for_layers_bytes, 0)
                target_free_bytes = target_free_vram_gb * (1024 ** 3)

                # best_fit_layers_for_target() guarantees the floor only
                # relative to the layers IT chooses to take — it can't
                # conjure headroom that wasn't there to begin with. If
                # non-layer weights + KV-cache alone already eat past the
                # floor, it'll correctly return 0 layers, but leftover
                # VRAM will still be under target_free_bytes. That's a
                # real "this won't fit with any margin" situation, not a
                # function bug — flag it so it doesn't look like a silent
                # miscalculation downstream.
                if vram_free_for_layers_bytes < target_free_bytes:
                    warnings.append(
                        f"vram_insufficient_for_{target_free_vram_gb}gb_floor_even_before_layers"
                    )

                fit_layers = best_fit_layers_for_target(
                    layer_info, vram_free_for_layers_bytes, target_free_bytes
                )

                if fit_layers < layer_info.n_layer:
                    gpu_layers = max(fit_layers, 0)
                    warnings.append(f"model_may_not_fully_fit_vram_layers_{gpu_layers}_of_{layer_info.n_layer}")
            except Exception as e:
                # Tensor-directory parsing failed (corrupt file, exotic
                # format) — fall back to the old file_size/n_layers average
                # rather than leaving gpu_layers at -1 (== "load everything")
                # and risking an OOM the caller didn't ask for.
                warnings.append(f"layer_weight_parse_failed_using_linear_estimate: {e}")
                file_size_gb = os.path.getsize(gguf_path) / (1024 ** 3)
                if file_size_gb > 0:
                    per_layer_gb = file_size_gb / n_layers
                    target_free_vram_gb = 1.0
                    usable_vram_for_weights = max(vram_free_gb - kv_cache_gb - target_free_vram_gb, 0)
                    fit_layers = int(usable_vram_for_weights / per_layer_gb) if per_layer_gb > 0 else n_layers
                    if fit_layers < n_layers:
                        gpu_layers = max(fit_layers, 0)
                        warnings.append(f"model_may_not_fully_fit_vram_layers_{gpu_layers}_of_{n_layers}")

    # --- Picking optimal batch_size based on VRAM tiers ---
    if vram_free_gb is None:
        batch_size = 128
    elif vram_free_gb < 6:
        batch_size = 32
    elif vram_free_gb <= 8:
        batch_size = 64
    elif vram_free_gb <= 12:
        batch_size = 128
    elif vram_free_gb <= 20:
        batch_size = 256
    else:
        batch_size = 512

    # --- Building the resulting config ---
    cfg = {
        "context_size": context_size,
        "max_answer_tokens": 300,
        "gpu_layers": gpu_layers,
        "cpu_threads": os.cpu_count() or 4,
        "batch_size": batch_size,
        "generation_timeout": 60,
        "lock_acquire_timeout": 30,
        "tokenize_timeout": 10,
        "summarize_n_predict": 2000,
        "summarize_temperature": 0.3,
        "chat_template": template_cfg,
        
        "detected": {
            "architecture": meta.get("general.architecture", "unknown"),
            "name": meta.get("general.name", "unknown"),
            "quantization_version": meta.get("general.quantization_version"),
            "file_type": meta.get("general.file_type"),
            "block_count": n_layers,
            "context_length": max_model_ctx,
            "split_count": meta.get("general.split_count", 1),
            "kv_cache_overhead_gb": round(kv_cache_gb, 2),
            "kv_cache_type": kv_cache_type
        }
    }
    return cfg, warnings