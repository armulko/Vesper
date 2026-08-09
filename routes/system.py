# system.py

import os
import json
import platform
import subprocess
import signal
import requests
from flask import Blueprint, request, jsonify
from settings import cfg
# system.py

import os
import json
import platform
import subprocess
import signal
import time
import requests
from flask import Blueprint, request, jsonify
from settings import cfg
import threading

file_lock = threading.Lock()

system_bp = Blueprint('system', __name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
STATE_FILE = os.path.join(DATA_DIR, 'app_state.json')

# ─── Inactivity watchdog (server-side, doesn't die with the browser tab) ───
_last_activity = time.time()
_activity_lock = threading.Lock()
_watchdog_started = False

def touch_activity():
    global _last_activity
    with _activity_lock:
        _last_activity = time.time()

def _do_shutdown():
    system = platform.system()
    try:
        if system == "Windows":
            subprocess.Popen(['shutdown', '/s', '/t', '0'])
        elif system == "Linux":
            subprocess.Popen(['systemctl', 'poweroff'])
        elif system == "Darwin":
            subprocess.Popen(['osascript', '-e', 'tell app "System Events" to shut down'])
    except Exception:
        pass

def _watchdog_loop():
    while True:
        time.sleep(60)
        try:
            timeout_hours = cfg('system', 'INACTIVITY_TIMEOUT_HOURS')
        except Exception:
            timeout_hours = 0
        # A tiny-but-nonzero value (typo like 0.01 instead of 0) is
        # indistinguishable from "meant to disable this" for basically
        # every real use case, and the failure mode is the PC turning
        # itself off within a minute of the user stepping away. Treat
        # anything under 5 minutes as effectively "off" rather than a
        # deliberately short timeout.
        MIN_TIMEOUT_HOURS = 5 / 60
        if not timeout_hours or timeout_hours < MIN_TIMEOUT_HOURS:
            continue
        with _activity_lock:
            idle_seconds = time.time() - _last_activity
        if idle_seconds >= timeout_hours * 3600:
            _do_shutdown()

def start_inactivity_watchdog():
    global _watchdog_started
    if _watchdog_started:
        return
    _watchdog_started = True
    touch_activity()
    threading.Thread(target=_watchdog_loop, daemon=True).start()

@system_bp.before_app_request
def _mark_activity():
    # Any request to the server counts as activity — chat, settings, model
    # switches, whatever. No reliance on a browser tab staying open/focused.
    touch_activity()

def load_state():
    with file_lock:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {'currentCharacterId': None, 'currentPersonaId': None}

def save_state(state):
    with file_lock:
        with open(STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)

@system_bp.route('/get_state', methods=['GET'])
def get_state():
    try:
        return jsonify(load_state())
    except Exception:
        return jsonify({'currentCharacterId': None, 'currentPersonaId': None}), 500

@system_bp.route('/save_state', methods=['POST'])
def save_state_route():
    incoming = request.json or {}
    current = load_state()
    merged = {**current, **incoming}
    save_state(merged)
    return jsonify({'success': True})

@system_bp.route('/shutdown_pc', methods=['POST'])
def shutdown_pc():
    try:
        _do_shutdown()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    

@system_bp.route('/restart_server', methods=['POST'])
def restart_server():
    from model_logic.model_manager import unload_llm
    try:
        unload_llm()
    except Exception:
        pass
    os.kill(os.getpid(), signal.SIGTERM)
    return jsonify({'ok': True})


@system_bp.route('/ready', methods=['GET'])
def ready():
    try:
        r = requests.get(f"{cfg('system', 'LLAMA_SERVER_URL')}/health", timeout=2)
        if r.status_code == 200:
            return jsonify({'ready': True})
        return jsonify({'ready': False}), 503
    except Exception:
        return jsonify({'ready': False}), 503