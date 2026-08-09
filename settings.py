import json
import os
import threading

_SETTINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "settings.json")
_MODEL_CONFIGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "model_configs.json")
_settings = {}
_model_configs = {}
_file_lock = threading.Lock()  # Protection of config files from concurrent overwrite

def _load():
    global _settings
    os.makedirs(os.path.dirname(_SETTINGS_PATH), exist_ok=True)
    if os.path.exists(_SETTINGS_PATH):
        try:
            with open(_SETTINGS_PATH, "r", encoding="utf-8") as f:
                _settings = json.load(f)
        except Exception:
            _settings = {"system": {"LLAMA_SERVER_URL": "http://127.0.0.1:8080"}}
    else:
        _settings = {"system": {"LLAMA_SERVER_URL": "http://127.0.0.1:8080"}}

def _load_model_configs():
    global _model_configs
    os.makedirs(os.path.dirname(_MODEL_CONFIGS_PATH), exist_ok=True)
    if os.path.exists(_MODEL_CONFIGS_PATH):
        try:
            with open(_MODEL_CONFIGS_PATH, "r", encoding="utf-8") as f:
                _model_configs = json.load(f)
        except Exception:
            _model_configs = {}
    else:
        _model_configs = {}

def save(data):
    global _settings
    with _file_lock:
        for section, values in data.items():
            if section not in _settings:
                _settings[section] = {}
            _settings[section].update(values)
        os.makedirs(os.path.dirname(_SETTINGS_PATH), exist_ok=True)
        with open(_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(_settings, f, ensure_ascii=False, indent=2)

def get_all():
    with _file_lock:
        return _settings

def cfg(section, key):
    with _file_lock:
        return _settings.get(section, {}).get(key)

def get_model_configs():
    with _file_lock:
        return _model_configs

def get_model_cfg(filename):
    with _file_lock:
        return _model_configs.get(filename, {})

def save_model_cfg(filename, data):
    global _model_configs
    with _file_lock:
        _model_configs[filename] = data
        os.makedirs(os.path.dirname(_MODEL_CONFIGS_PATH), exist_ok=True)
        with open(_MODEL_CONFIGS_PATH, "w", encoding="utf-8") as f:
            json.dump(_model_configs, f, ensure_ascii=False, indent=2)

def get_active_llm_cfg():
    with _file_lock:
        filename = _settings.get("models", {}).get("selected_llm")
        if not filename:
            return {}
        return _model_configs.get(filename, {})

def get_active_sd_cfg():
    with _file_lock:
        filename = _settings.get("models", {}).get("selected_sd")
        if not filename:
            return {}
        return _model_configs.get(filename, {})

# Safe initialization on module import
_load()
_load_model_configs()