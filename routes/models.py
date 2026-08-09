import os
from flask import Blueprint, request, jsonify
from model_logic.model_manager import (
    get_model_type, get_llm, get_image_pipe,
    select_and_load_llm, select_and_load_sd,
    unload_llm_only, unload_sd_only, check_vram_fit
)
from settings import cfg, get_model_configs, get_model_cfg, save_model_cfg, get_all, get_active_llm_cfg

import threading

model_management_lock = threading.Lock()

models_bp = Blueprint('models', __name__)

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")

def _scan_models():
    if not os.path.exists(MODELS_DIR):
        return []
    result = []
    for fname in os.listdir(MODELS_DIR):
        fpath = os.path.join(MODELS_DIR, fname)
        if not os.path.isfile(fpath):
            continue
        ext = os.path.splitext(fname)[1].lower()
        if ext == ".gguf":
            mtype = "llm"
        elif ext == ".safetensors":
            mtype = "sd"
        else:
            continue
        result.append({
            "filename": fname,
            "type": mtype,
            "size_gb": round(os.path.getsize(fpath) / (1024 ** 3), 2)
        })
    return result

@models_bp.route('/get_models', methods=['GET'])
def get_models():
    models = _scan_models()
    configs = get_model_configs()
    s = get_all()
    selected_llm = s["models"].get("selected_llm")
    selected_sd = s["models"].get("selected_sd")
    for m in models:
        m["config"] = configs.get(m["filename"], {})
        m["selected"] = (m["filename"] == selected_llm) or (m["filename"] == selected_sd)
        m["loaded"] = (
            (m["type"] == "llm" and get_llm()) or
            (m["type"] == "sd" and get_image_pipe() is not None)
        )
    return jsonify({
        "models": models,
        "selected_llm": selected_llm,
        "selected_sd": selected_sd
    })

@models_bp.route('/select_model', methods=['POST'])
def select_model():
    with model_management_lock:  
        data = request.json
        filename = data.get('filename')
        force = data.get('force', False)
        if not filename:
            return jsonify({'success': False, 'error': 'filename required'}), 400
            
        if filename == "none_llm":
            unload_llm_only()
            s = get_all()
            s["models"]["selected_llm"] = None
            from settings import save
            save(s)
            return jsonify({'success': True})
            
        if filename == "none_sd":
            unload_sd_only()
            s = get_all()
            s["models"]["selected_sd"] = None
            from settings import save
            save(s)
            return jsonify({'success': True})

        models = _scan_models()
        model = next((m for m in models if m["filename"] == filename), None)
        
        if not model:
            return jsonify({'success': False, 'error': 'Model not found'}), 404

        if model["type"] == "llm":
            result = select_and_load_llm(filename, force=force)
        else:
            result = select_and_load_sd(filename, force=force)

        return jsonify(result)

@models_bp.route('/unload_model', methods=['POST'])
def unload_model():
    data = request.json
    mtype = data.get('type')
    if mtype == "llm":
        unload_llm_only()
    elif mtype == "sd":
        unload_sd_only()
    else:
        return jsonify({'success': False, 'error': 'type must be llm or sd'}), 400
    return jsonify({'success': True})

@models_bp.route('/get_model_config/<filename>', methods=['GET'])
def get_model_config(filename):
    return jsonify(get_model_cfg(filename))

@models_bp.route('/get_model_type', methods=['GET'])
def get_model_type_route():
    # Legacy single-value field kept for backward compat during transition,
    # but llm_loaded/sd_loaded below are the source of truth now that both
    # models can be resident in VRAM simultaneously.
    return jsonify({
        'model_type': get_model_type(),
        'llm_loaded': get_llm(),
        'sd_loaded': get_image_pipe() is not None
    })

@models_bp.route('/get_config', methods=['GET'])
def get_config():
    from settings import get_active_llm_cfg
    llm_cfg = get_active_llm_cfg()
    return jsonify({'context_size': llm_cfg.get('context_size', 4096)})