"""
layer_weight_cache.py — persists parse_layer_weights() results so a model's
tensor directory isn't re-walked on every load.

Cache key: filename -> {size, mtime, n_layer, layer_bytes, non_layer_bytes}
Invalidation: if the file's current (size, mtime) don't match what's
stored, the file was replaced/updated -> re-parse and overwrite.

Suggested location: data/model_layer_cache.json (kept separate from
model_configs.json — that file is user-editable generation settings,
this one is derived/computed data with a completely different
invalidation trigger. Mixing them means a manual settings edit could
accidentally sit next to stale parse data, or vice versa).
"""

from __future__ import annotations

import json
from pathlib import Path

from .layer_weights import LayerWeightInfo, parse_layer_weights

# Anchored to project root (one level up from model_logic/), not to
# whatever the process's current working directory happens to be. A
# relative Path("data/...") only resolves correctly if the app is always
# launched from the project root — true today, but moving this module
# into a subfolder is exactly the kind of change that later makes someone
# run it from elsewhere (a script in a different folder, a test runner,
# etc.) and get a silently-wrong cache location instead of an error.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_PATH = _PROJECT_ROOT / "data" / "model_layer_cache.json"


def _file_signature(path: Path) -> dict:
    st = path.stat()
    return {"size": st.st_size, "mtime": st.st_mtime}


def _load_cache() -> dict:
    if not CACHE_PATH.exists():
        return {}
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        # Corrupt cache file shouldn't be fatal — treat as empty, rebuild.
        return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    tmp.replace(CACHE_PATH)  # atomic on POSIX and Windows


def get_layer_weights(gguf_path: str | Path, *, force: bool = False) -> LayerWeightInfo:
    """
    Cached wrapper around parse_layer_weights(). Keyed by absolute path
    so two models with the same filename in different folders don't collide.
    """
    path = Path(gguf_path).resolve()
    key = str(path)
    sig = _file_signature(path)

    cache = _load_cache()
    entry = cache.get(key)

    if not force and entry and entry.get("size") == sig["size"] and entry.get("mtime") == sig["mtime"]:
        return LayerWeightInfo(
            n_layer=entry["n_layer"],
            layer_bytes=entry["layer_bytes"],
            non_layer_bytes=entry["non_layer_bytes"],
            total_bytes=entry["total_bytes"],
        )

    # Miss, or file changed since it was cached — reparse.
    info = parse_layer_weights(path)
    cache[key] = {
        **sig,
        "n_layer": info.n_layer,
        "layer_bytes": info.layer_bytes,
        "non_layer_bytes": info.non_layer_bytes,
        "total_bytes": info.total_bytes,
    }
    _save_cache(cache)
    return info