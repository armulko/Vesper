import os
import json
import base64
import requests
from flask import Blueprint, request, jsonify, send_file
import threading
from routes.default_avatars import ensure_default_avatar

characters_bp = Blueprint('characters', __name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CHARACTERS_FILE = os.path.join(DATA_DIR, 'characters.json')
HISTORIES_DIR = os.path.join(DATA_DIR, 'histories')
AVATARS_DIR = os.path.join(DATA_DIR, 'avatars', 'characters')
NOTES_DIR = os.path.join(DATA_DIR, 'notes')

file_lock = threading.Lock()

def ensure_dirs():
    os.makedirs(HISTORIES_DIR, exist_ok=True)
    os.makedirs(AVATARS_DIR, exist_ok=True)


def load_characters():
    with file_lock:
        if os.path.exists(CHARACTERS_FILE):
            with open(CHARACTERS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return []

def save_characters(characters):
    with file_lock:
        with open(CHARACTERS_FILE, 'w', encoding='utf-8') as f:
            json.dump(characters, f, ensure_ascii=False, indent=2)

def get_avatar_path(character_id):
    return os.path.join(AVATARS_DIR, f'{str(character_id)}.jpg')


def save_avatar(character_id, image_data):
    if not image_data:
        return
    ensure_dirs()
    if ',' in image_data:
        image_data = image_data.split(',', 1)[1]
    with open(get_avatar_path(character_id), 'wb') as f:
        f.write(base64.b64decode(image_data))


def delete_avatar(character_id):
    path = get_avatar_path(character_id)
    if os.path.exists(path):
        os.remove(path)


def get_notes_path(character_id):
    return os.path.join(NOTES_DIR, f'{str(character_id)}.txt')


def load_notes(character_id):
    path = get_notes_path(character_id)
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    return ''


def save_notes_file(character_id, text):
    os.makedirs(NOTES_DIR, exist_ok=True)
    with open(get_notes_path(character_id), 'w', encoding='utf-8') as f:
        f.write(text)


def get_history_path(character_id):
    return os.path.join(HISTORIES_DIR, f'{str(character_id)}.json')


def load_history(character_id):
    with file_lock:
        path = get_history_path(character_id)
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        return []

def save_history(character_id, history):
    ensure_dirs()
    with file_lock:
        with open(get_history_path(character_id), 'w', encoding='utf-8') as f:
            json.dump(history, f, ensure_ascii=False, indent=2)


def _char_id(char):
    """Extract id from the Tavern V2 structure (from vesper or root)."""
    return char.get('vesper', {}).get('id') or char.get('id')


def _char_name(char):
    """Safely extracts the character's name depending on the structure."""
    # In the V2 structure the name lives inside the data object: data.name
    if 'data' in char and isinstance(char['data'], dict):
        return char['data'].get('name', 'Unknown')
    return char.get('name', 'Unknown')


@characters_bp.route('/get_characters', methods=['GET'])
def get_characters():
    try:
        characters = load_characters()
        needs_save = False
        for char in characters:
            char.pop('image', None)
            cid = _char_id(char)
            
            # Check the avatar on disk
            has_av = os.path.exists(get_avatar_path(cid))
            
            # For compatibility, write the flag both at the root and inside vesper
            char['has_avatar'] = has_av
            if 'vesper' not in char or not isinstance(char['vesper'], dict):
                char['vesper'] = {}
            char['vesper']['has_avatar'] = has_av
            # Backfill default_avatar for records saved before this field
            # existed — same permanent-once-assigned logic, just triggered
            # on read instead of write for old data. Batched into a single
            # save after the loop rather than one write per character.
            if not char['vesper'].get('default_avatar'):
                ensure_default_avatar(char['vesper'])
                needs_save = True
                
            # Also propagate the name to the top level, in case the frontend is old
            if 'name' not in char:
                char['name'] = _char_name(char)

        if needs_save:
            save_characters(characters)
                
        return jsonify(characters)
    except Exception:
        return jsonify([]), 500


@characters_bp.route('/character_avatar/<character_id>', methods=['GET'])
def character_avatar(character_id):
    # Removed <int:character_id> so the route accepts an ID in any format
    path = get_avatar_path(character_id)
    if os.path.exists(path):
        return send_file(path, mimetype='image/jpeg')
    return '', 404


@characters_bp.route('/save_character', methods=['POST'])
def save_character():
    try:
        ensure_dirs()
        data = request.json
        image_data = data.pop('image', None)
        cid = _char_id(data)
        
        # First process the avatar and set the flags in the data object
        if image_data:
            save_avatar(cid, image_data)
            data['has_avatar'] = True
            if 'vesper' in data and isinstance(data['vesper'], dict):
                data['vesper']['has_avatar'] = True
        else:
            has_av = os.path.exists(get_avatar_path(cid))
            data['has_avatar'] = has_av
            if 'vesper' in data and isinstance(data['vesper'], dict):
                data['vesper']['has_avatar'] = has_av

        # Every character gets a permanent fallback avatar assigned once,
        # regardless of whether a real one was uploaded — covers "no avatar
        # yet", "upload failed", and any other case where has_avatar ends up
        # false down the line. No-op if already assigned.
        if 'vesper' not in data or not isinstance(data['vesper'], dict):
            data['vesper'] = {}
        ensure_default_avatar(data['vesper'])

        characters = load_characters()
        existing_idx = next((i for i, c in enumerate(characters) if str(_char_id(c)) == str(cid)), None)
        
        if existing_idx is not None:
            characters[existing_idx] = data 
        else:
            characters.append(data)     
        save_characters(characters)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/update_character/<character_id>', methods=['PUT'])
def update_character(character_id):
    try:
        data = request.json
        image_data = data.pop('image', None)
        
        # First set the actual avatar flags inside data
        if image_data:
            save_avatar(character_id, image_data)
            data['has_avatar'] = True
            if 'vesper' in data and isinstance(data['vesper'], dict):
                data['vesper']['has_avatar'] = True
        else:
            has_av = os.path.exists(get_avatar_path(character_id))
            data['has_avatar'] = has_av
            if 'vesper' in data and isinstance(data['vesper'], dict):
                data['vesper']['has_avatar'] = has_av

        # Same permanent-fallback logic as save_character — ensure_default_avatar
        # is a no-op if this character already has one, so editing never
        # reassigns it.
        if 'vesper' not in data or not isinstance(data['vesper'], dict):
            data['vesper'] = {}
        ensure_default_avatar(data['vesper'])

        characters = load_characters()
        for i, char in enumerate(characters):
            if str(_char_id(char)) == str(character_id):
                characters[i] = data
                break
        save_characters(characters)
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/delete_character/<character_id>', methods=['DELETE'])
def delete_character(character_id):
    try:
        characters = load_characters()
        characters = [c for c in characters if str(_char_id(c)) != str(character_id)]
        save_characters(characters)
        
        delete_avatar(character_id)
        
        history_path = get_history_path(character_id)
        if os.path.exists(history_path):
            os.remove(history_path)
            
        notes_path = get_notes_path(character_id)
        if os.path.exists(notes_path):
            os.remove(notes_path)
            
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/get_chat_history/<character_id>', methods=['GET'])
def get_chat_history(character_id):
    try:
        return jsonify(load_history(character_id))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@characters_bp.route('/save_chat_history/<character_id>', methods=['POST'])
def save_chat_history(character_id):
    try:
        chat_data = request.json
        save_history(character_id, chat_data.get('history', []))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/clear_chat_history/<character_id>', methods=['POST'])
def clear_chat_history(character_id):
    try:
        save_history(character_id, [])
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/get_notes/<character_id>', methods=['GET'])
def get_notes(character_id):
    try:
        return jsonify({'notes': load_notes(character_id)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@characters_bp.route('/save_notes/<character_id>', methods=['POST'])
def save_notes(character_id):
    try:
        data = request.json
        save_notes_file(character_id, data.get('notes', ''))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


def _read_png_text_chunks(png_bytes):
    """Minimal PNG chunk reader — no Pillow, because Pillow's .info handling
    of tEXt/iTXt isn't guaranteed stable across versions and this is exactly
    the kind of thing you don't want silently breaking on a library bump.
    Returns {keyword: text} for all tEXt/zTXt/iTXt chunks found.
    PNG spec: https://www.w3.org/TR/png/ — 8-byte signature, then a sequence
    of [4-byte length][4-byte type][data][4-byte CRC] chunks."""
    import struct
    import zlib

    if png_bytes[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a PNG file')

    chunks = {}
    pos = 8
    while pos < len(png_bytes):
        if pos + 8 > len(png_bytes):
            break
        length = struct.unpack('>I', png_bytes[pos:pos+4])[0]
        ctype = png_bytes[pos+4:pos+8].decode('ascii', errors='replace')
        data = png_bytes[pos+8:pos+8+length]

        if ctype == 'tEXt':
            if b'\x00' in data:
                key, _, val = data.partition(b'\x00')
                chunks[key.decode('latin-1')] = val.decode('latin-1')
        elif ctype == 'zTXt':
            if b'\x00' in data:
                key, _, rest = data.partition(b'\x00')
                # rest[0] is compression method (always 0 = zlib), rest[1:] is compressed text
                try:
                    val = zlib.decompress(rest[1:]).decode('utf-8', errors='replace')
                    chunks[key.decode('latin-1')] = val
                except Exception:
                    pass
        elif ctype == 'iTXt':
            # keyword\0 compression_flag(1) compression_method(1) language_tag\0 translated_keyword\0 text
            parts = data.split(b'\x00', 4)
            if len(parts) == 5:
                key, comp_flag, _comp_method, _lang, text = parts
                try:
                    if comp_flag == b'\x01':
                        text = zlib.decompress(text)
                    chunks[key.decode('latin-1')] = text.decode('utf-8', errors='replace')
                except Exception:
                    pass

        pos += 8 + length + 4  # data + 4-byte CRC
        if ctype == 'IEND':
            break
    return chunks


@characters_bp.route('/import_character_png', methods=['POST'])
def import_character_png():
    """Imports a chara_card (v2 or v3) embedded in a PNG's tEXt/zTXt/iTXt
    metadata — the format used by Chub.ai and most Tavern-compatible cards.
    Returns the parsed character `data` object (plus the raw avatar as
    base64) for the frontend to drop straight into the create-character form
    via _autoExpandFilledAccordions, rather than saving directly — the user
    should get a chance to review/edit before it's written to characters.json.
    """
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'no file uploaded'}), 400
        file = request.files['file']
        png_bytes = file.read()

        chunks = _read_png_text_chunks(png_bytes)

        # v3 cards are usually under 'ccv3', v2 under 'chara'. Some exports
        # put v2 data under 'chara' even when spec says v2, so try both keys
        # and prefer ccv3 if present (newer/more complete).
        raw = chunks.get('ccv3') or chunks.get('chara')
        if not raw:
            return jsonify({'success': False, 'error': 'no character data found in PNG (missing chara/ccv3 chunk)'}), 400

        try:
            decoded = base64.b64decode(raw)
            card = json.loads(decoded)
        except Exception:
            return jsonify({'success': False, 'error': 'character chunk found but could not be decoded (corrupt or unsupported encoding)'}), 400

        # Both v2 and v3 nest the actual fields under "data"; v1 (very old
        # exports) has them at the root. Normalize to always return the
        # inner fields so the frontend doesn't need to branch on spec version.
        data = card.get('data', card)
        if not isinstance(data, dict):
            return jsonify({'success': False, 'error': 'character chunk decoded but has no usable data (wrong shape)'}), 400

        # A chunk that decodes fine but has no name and no first message
        # isn't a usable character card — it's either a corrupt/truncated
        # export or a PNG someone re-saved (many editors strip or garble
        # tEXt chunks on re-encode). Catching this here means the create-form
        # ends up empty with no explanation instead of a silent no-op import.
        if not str(data.get('name', '')).strip() and not str(data.get('first_mes', '')).strip():
            return jsonify({'success': False, 'error': 'character data found but is empty (no name or first message) — the card may be corrupted'}), 400

        # Re-encode the original PNG bytes as the avatar so the imported
        # character keeps its picture — save_character already accepts a
        # base64 'image' field.
        avatar_b64 = base64.b64encode(png_bytes).decode('ascii')

        return jsonify({
            'success': True,
            'data': {
                'name': data.get('name', ''),
                'description': data.get('description', ''),
                'personality': data.get('personality', ''),
                'scenario': data.get('scenario', ''),
                'first_mes': data.get('first_mes', ''),
                'mes_example': data.get('mes_example', ''),
                'creator_notes': data.get('creator_notes', ''),
                'system_prompt': data.get('system_prompt', ''),
                'post_history_instructions': data.get('post_history_instructions', ''),
                'alternate_greetings': data.get('alternate_greetings', []),
                'character_book': data.get('character_book', {'entries': []}),
                'tags': data.get('tags', []),
                'creator': data.get('creator', ''),
                'character_version': data.get('character_version', ''),
                'extensions': data.get('extensions', {}) if isinstance(data.get('extensions'), dict) else {},
            },
            'image': f'data:image/png;base64,{avatar_b64}',
            'spec_found': 'v3' if 'ccv3' in chunks else 'v2',
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/save_draft/<character_id>', methods=['POST'])
def save_draft(character_id):
    try:
        data = request.json or {}
        draft = data.get('draft', '')
        characters = load_characters()
        found = False
        for char in characters:
            if str(_char_id(char)) == str(character_id):
                if 'vesper' not in char or not isinstance(char['vesper'], dict):
                    char['vesper'] = {}
                char['vesper']['draft'] = draft
                found = True
                break
        if not found:
            return jsonify({'success': False, 'error': 'character not found'}), 404
        save_characters(characters)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


def _get_llama_server_url():
    """Reads LLAMA_SERVER_URL from settings.json (system section).
    Falls back to the default local port if settings are missing/broken —
    this endpoint is a nice-to-have token counter, not critical path,
    so it should degrade quietly rather than 500 on a settings hiccup."""
    settings_path = os.path.join(DATA_DIR, 'settings.json')
    try:
        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)
        url = settings.get('system', {}).get('LLAMA_SERVER_URL')
        if url:
            return url.rstrip('/')
    except Exception:
        pass
    return 'http://127.0.0.1:8080'


@characters_bp.route('/count_field_tokens', methods=['POST'])
def count_field_tokens():
    """Exact token count for a single character-form field, via the currently
    loaded model's own tokenizer (llama-server's /tokenize endpoint) instead
    of the old length/4 approximation. Intentionally per-field rather than
    per-keystroke-for-the-whole-form: the frontend debounces calls, and each
    field is tokenized independently so one huge field doesn't stall the
    counter for the others.

    Known compromise: this counts each field's raw text in isolation. It does
    NOT include chat-template wrapper tokens (role headers, BOS/EOS, etc.),
    so the true in-context cost per field will be a little higher than what's
    shown. Good enough for "am I anywhere near context limit" purposes; not
    meant to be an exact prompt-assembly simulator.
    """
    try:
        data = request.json or {}
        text = data.get('text', '')
        if not text:
            return jsonify({'tokens': 0})

        llama_url = _get_llama_server_url()
        resp = requests.post(
            f'{llama_url}/tokenize',
            json={'content': text},
            timeout=5
        )
        resp.raise_for_status()
        result = resp.json()
        tokens = result.get('tokens', [])
        return jsonify({'tokens': len(tokens)})
    except requests.exceptions.RequestException:
        # LLM not loaded / server down / switched to image mode — fall back
        # to the old approximation rather than breaking the counter entirely.
        text = (request.json or {}).get('text', '')
        return jsonify({'tokens': round(len(text) / 4), 'approximate': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500