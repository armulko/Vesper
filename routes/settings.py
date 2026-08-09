from flask import Blueprint, request, jsonify
from settings import get_all, save, get_model_configs, get_model_cfg, save_model_cfg, cfg
from model_logic.model_manager import get_vram_free_gb, get_model_type, LLM_KV_CACHE_TYPE
from model_logic.model_autoconfig import validate_model_cfg, autodetect_llm_cfg
import os
import math

settings_bp = Blueprint('settings', __name__)

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")

# mirror of SETTINGS_SCHEMA from static/js/settings.js — keep in sync when adding fields.
# format: (section, field): type ('number' | 'text' | 'textarea')
_SETTINGS_FIELD_TYPES = {
    ("system", "INACTIVITY_TIMEOUT_HOURS"): "number",
    ("system", "LLAMA_SERVER_URL"): "text",
    ("generation", "DEFAULT_CONTEXT_SIZE"): "number",
    ("generation", "TEMPERATURE"): "number",
    ("generation", "TOP_P"): "number",
    ("generation", "TOP_K"): "number",
    ("generation", "REPEAT_PENALTY"): "number",
    ("generation", "FREQUENCY_PENALTY"): "number",
    ("generation", "PRESENCE_PENALTY"): "number",
    ("prompts", "DEFAULT_SYSTEM_RULES"): "textarea",
    ("prompts", "SUMMARIZE_PROMPT"): "textarea",
    ("prompts", "META_SUMMARIZE_PROMPT"): "textarea",
    ("prompts", "SUGGEST_SYSTEM_PROMPT"): "textarea",
}


def _validate_settings_payload(data):
    """Only validates fields that actually arrived in the payload (save_settings
    does a partial merge per section) — we don't require all fields to be present at once."""
    problems = []
    for section, values in data.items():
        if not isinstance(values, dict):
            problems.append(f"bad_section:{section}")
            continue
        for field, val in values.items():
            expected = _SETTINGS_FIELD_TYPES.get((section, field))
            if expected != "number":
                continue
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                problems.append(f"not_a_number:{section}.{field}")
                continue
            if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
                problems.append(f"not_finite:{section}.{field}")
    return problems


@settings_bp.route('/get_settings', methods=['GET'])
def get_settings():
    return jsonify(get_all())

@settings_bp.route('/save_settings', methods=['POST'])
def save_settings():
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'no data'}), 400

    problems = _validate_settings_payload(data)
    if problems:
        return jsonify({'success': False, 'error': 'invalid_settings', 'problems': problems}), 400

    save(data)
    return jsonify({'success': True})

@settings_bp.route('/get_model_configs', methods=['GET'])
def get_model_configs_route():
    return jsonify(get_model_configs())

@settings_bp.route('/save_model_config/<filename>', methods=['POST'])
def save_model_config(filename):
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'no data'}), 400

    model_type = request.args.get('type', 'llm')
    is_valid, problems = validate_model_cfg(data, model_type)
    if not is_valid:
        return jsonify({'success': False, 'error': 'invalid_config', 'problems': problems}), 400

    save_model_cfg(filename, data)
    return jsonify({'success': True})

@settings_bp.route('/check_model_cfg/<filename>', methods=['GET'])
def check_model_cfg(filename):
    model_type = request.args.get('type', 'llm')
    existing = get_model_cfg(filename)
    is_valid, problems = validate_model_cfg(existing, model_type)

    if is_valid:
        return jsonify({'valid': True})

    if model_type != 'llm':
        return jsonify({'valid': False, 'problems': problems, 'suggested_cfg': None})

    path = os.path.join(MODELS_DIR, filename)
    default_ctx = cfg('generation', 'DEFAULT_CONTEXT_SIZE') or 4096
    vram_free = get_vram_free_gb()

    # kv_cache_type is pulled from model_manager's LLM_KV_CACHE_TYPE constant
    # rather than hardcoded here — that constant is what actually gets
    # passed to llama-server.exe's --cache-type-k/-v flags, so the estimate
    # stays truthful to what will really run instead of silently assuming
    # fp16 while the server runs turbo3.
    suggested_cfg, warnings = autodetect_llm_cfg(
        path,
        vram_free_gb=vram_free,
        default_context_size=default_ctx,
        kv_cache_type=LLM_KV_CACHE_TYPE,
    )

    return jsonify({
        'valid': False,
        'problems': problems,
        'suggested_cfg': suggested_cfg,
        'warnings': warnings,
        'reason': 'missing_config' if not existing else 'broken_config'
    })