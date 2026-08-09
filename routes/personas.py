# personas.py

import os
import json
import base64
from flask import Blueprint, request, jsonify, send_file
import threading
from routes.default_avatars import ensure_default_avatar

file_lock = threading.Lock()

personas_bp = Blueprint('personas', __name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
PERSONAS_FILE = os.path.join(DATA_DIR, 'personas.json')
AVATARS_DIR = os.path.join(DATA_DIR, 'avatars', 'personas')


def ensure_dirs():
    os.makedirs(AVATARS_DIR, exist_ok=True)


def load_personas():
    with file_lock:
        if os.path.exists(PERSONAS_FILE):
            with open(PERSONAS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return []


def save_personas(personas):
    with file_lock:
        with open(PERSONAS_FILE, 'w', encoding='utf-8') as f:
            json.dump(personas, f, ensure_ascii=False, indent=2)


def get_avatar_path(persona_id):
    return os.path.join(AVATARS_DIR, f'{persona_id}.jpg')


def save_avatar(persona_id, image_data):
    if not image_data:
        return
    ensure_dirs()
    if ',' in image_data:
        image_data = image_data.split(',', 1)[1]
    with open(get_avatar_path(persona_id), 'wb') as f:
        f.write(base64.b64decode(image_data))


def delete_avatar(persona_id):
    path = get_avatar_path(persona_id)
    if os.path.exists(path):
        os.remove(path)


@personas_bp.route('/get_personas', methods=['GET'])
def get_personas():
    try:
        personas = load_personas()
        needs_save = False
        for p in personas:
            p.pop('image', None)
            p['has_avatar'] = os.path.exists(get_avatar_path(p['id']))
            # Backfill for personas saved before default_avatar existed —
            # same permanent-once-assigned fallback as characters. Personas
            # don't have a `vesper` wrapper, so default_avatar lives at the
            # root here instead.
            if not p.get('default_avatar'):
                ensure_default_avatar(p)
                needs_save = True
        if needs_save:
            save_personas(personas)
        return jsonify(personas)
    except Exception:
        return jsonify([]), 500


@personas_bp.route('/persona_avatar/<int:persona_id>', methods=['GET'])
def persona_avatar(persona_id):
    path = get_avatar_path(persona_id)
    if os.path.exists(path):
        return send_file(path, mimetype='image/jpeg')
    return '', 404


@personas_bp.route('/save_persona', methods=['POST'])
def save_persona():
    try:
        ensure_dirs()
        data = request.json
        image_data = data.pop('image', None)
        ensure_default_avatar(data)
        personas = load_personas()
        personas.append(data)
        save_personas(personas)
        if image_data:
            save_avatar(data['id'], image_data)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@personas_bp.route('/update_persona/<int:persona_id>', methods=['PUT'])
def update_persona(persona_id):
    try:
        data = request.json
        image_data = data.pop('image', None)
        personas = load_personas()
        for i, p in enumerate(personas):
            if p['id'] == persona_id:
                # The frontend sends the persona object without
                # default_avatar (it doesn't know about that field), and
                # this assignment fully replaces the stored record — so
                # carry the existing one over instead of letting it get
                # silently wiped on every edit. Same permanent-once logic
                # as everywhere else: only assign fresh if somehow missing.
                if p.get('default_avatar'):
                    data['default_avatar'] = p['default_avatar']
                else:
                    ensure_default_avatar(data)
                personas[i] = data
                break
        save_personas(personas)
        if image_data:
            save_avatar(persona_id, image_data)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@personas_bp.route('/delete_persona/<int:persona_id>', methods=['DELETE'])
def delete_persona(persona_id):
    try:
        personas = load_personas()
        personas = [p for p in personas if p['id'] != persona_id]
        save_personas(personas)
        delete_avatar(persona_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500