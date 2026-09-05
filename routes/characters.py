import os
import json
import base64
import requests
from flask import Blueprint, request, jsonify, send_file
from db import get_db
from routes.default_avatars import pick_random_default_avatar

characters_bp = Blueprint('characters', __name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
AVATARS_DIR = os.path.join(DATA_DIR, 'avatars', 'characters')

def ensure_dirs():
    os.makedirs(AVATARS_DIR, exist_ok=True)


# Список полей, которые в БД хранятся как JSON-текст (TEXT-колонка с
# сериализованным массивом/объектом внутри), а наружу в API должны уходить
# как настоящий JSON, не как строка-со-скобками. Единое место вместо
# json.loads() россыпью по каждому роуту — если появится новое JSON-поле,
# добавить его сюда и оно само подхватится и на сериализации, и на десериализации.
JSON_FIELDS = ('alternate_greetings', 'tags', 'extensions')


def get_avatar_path(character_id):
    return os.path.join(AVATARS_DIR, f'{character_id}.jpg')


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


def _pick_default_avatar():
    """Делегирует в default_avatars.py — та же логика, что и раньше:
    рандомный выбор из реально просканированной data/avatars/default/,
    закэшированной в памяти процесса. Назначается один раз при создании
    и потом никогда не переприсваивается (см. ensure_default_avatar в
    оригинале — здесь этот же принцип, просто без in-place мутации dict,
    т.к. в БД default_avatar — обычная колонка, не вложенный объект)."""
    return pick_random_default_avatar()


def _row_to_dict(row):
    """sqlite3.Row -> plain dict, разворачивая JSON_FIELDS обратно в
    настоящие списки/объекты и добавляя derived has_avatar (см. схему —
    это поле сознательно не хранится в БД, всегда считается с диска)."""
    d = dict(row)
    for field in JSON_FIELDS:
        raw = d.get(field)
        try:
            d[field] = json.loads(raw) if raw else ([] if field != 'extensions' else {})
        except (json.JSONDecodeError, TypeError):
            # Битый JSON в поле не должен ронять весь список персонажей —
            # деградируем до пустого значения и едем дальше.
            d[field] = [] if field != 'extensions' else {}
    d['has_avatar'] = os.path.exists(get_avatar_path(d['id']))
    return d


@characters_bp.route('/get_characters', methods=['GET'])
def get_characters():
    try:
        db = get_db()
        rows = db.execute('SELECT * FROM characters ORDER BY id').fetchall()
        return jsonify([_row_to_dict(r) for r in rows])
    except Exception:
        return jsonify([]), 500


@characters_bp.route('/character_avatar/<int:character_id>', methods=['GET'])
def character_avatar(character_id):
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

        db = get_db()
        cur = db.execute(
            '''INSERT INTO characters (
                   name, description, personality, scenario, first_mes,
                   mes_example, creator_notes, system_prompt,
                   post_history_instructions, alternate_greetings, tags,
                   creator, character_version, extensions, default_avatar, draft
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                data.get('name', 'Unknown'),
                data.get('description', ''),
                data.get('personality', ''),
                data.get('scenario', ''),
                data.get('first_mes', ''),
                data.get('mes_example', ''),
                data.get('creator_notes', ''),
                data.get('system_prompt', ''),
                data.get('post_history_instructions', ''),
                json.dumps(data.get('alternate_greetings', []), ensure_ascii=False),
                json.dumps(data.get('tags', []), ensure_ascii=False),
                data.get('creator', ''),
                data.get('character_version', ''),
                json.dumps(data.get('extensions', {}), ensure_ascii=False),
                _pick_default_avatar(),
                data.get('draft', ''),
            )
        )
        new_id = cur.lastrowid
        db.commit()

        if image_data:
            save_avatar(new_id, image_data)

        return jsonify({'success': True, 'id': new_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/update_character/<int:character_id>', methods=['PUT'])
def update_character(character_id):
    try:
        data = request.json
        image_data = data.pop('image', None)

        db = get_db()
        existing = db.execute('SELECT id FROM characters WHERE id = ?', (character_id,)).fetchone()
        if not existing:
            return jsonify({'success': False, 'error': 'character not found'}), 404

        db.execute(
            '''UPDATE characters SET
                   name = ?, description = ?, personality = ?, scenario = ?,
                   first_mes = ?, mes_example = ?, creator_notes = ?,
                   system_prompt = ?, post_history_instructions = ?,
                   alternate_greetings = ?, tags = ?, creator = ?,
                   character_version = ?, extensions = ?,
                   updated_at = datetime('now')
               WHERE id = ?''',
            (
                data.get('name', 'Unknown'),
                data.get('description', ''),
                data.get('personality', ''),
                data.get('scenario', ''),
                data.get('first_mes', ''),
                data.get('mes_example', ''),
                data.get('creator_notes', ''),
                data.get('system_prompt', ''),
                data.get('post_history_instructions', ''),
                json.dumps(data.get('alternate_greetings', []), ensure_ascii=False),
                json.dumps(data.get('tags', []), ensure_ascii=False),
                data.get('creator', ''),
                data.get('character_version', ''),
                json.dumps(data.get('extensions', {}), ensure_ascii=False),
                character_id,
            )
        )
        # default_avatar сознательно не в SET-списке — та же железобетонная
        # логика что раньше (ensure_default_avatar же был no-op при апдейте):
        # назначается один раз при создании, никогда не трогается редактированием.
        db.commit()

        if image_data:
            save_avatar(character_id, image_data)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/delete_character/<int:character_id>', methods=['DELETE'])
def delete_character(character_id):
    try:
        db = get_db()
        db.execute('DELETE FROM characters WHERE id = ?', (character_id,))
        # FK ON DELETE CASCADE сносит character_personas / chats / forks /
        # messages / character_lorebooks сам — раньше это было три ручных
        # os.remove() (history file, notes file, avatar), теперь только
        # аватарка остаётся файлом на диске и чистится руками, всё
        # остальное схлопывает движок БД.
        db.commit()
        delete_avatar(character_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@characters_bp.route('/save_draft/<int:character_id>', methods=['POST'])
def save_draft(character_id):
    try:
        data = request.json or {}
        draft = data.get('draft', '')
        db = get_db()
        cur = db.execute('UPDATE characters SET draft = ? WHERE id = ?', (draft, character_id))
        db.commit()
        if cur.rowcount == 0:
            return jsonify({'success': False, 'error': 'character not found'}), 404
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


def _read_png_text_chunks(png_bytes):
    """Не тронуто — чистый бинарный парсинг PNG-чанков, к БД отношения не
    имеет, оставлен как был в старом routes/characters.py."""
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
                try:
                    val = zlib.decompress(rest[1:]).decode('utf-8', errors='replace')
                    chunks[key.decode('latin-1')] = val
                except Exception:
                    pass
        elif ctype == 'iTXt':
            parts = data.split(b'\x00', 4)
            if len(parts) == 5:
                key, comp_flag, _comp_method, _lang, text = parts
                try:
                    if comp_flag == b'\x01':
                        text = zlib.decompress(text)
                    chunks[key.decode('latin-1')] = text.decode('utf-8', errors='replace')
                except Exception:
                    pass

        pos += 8 + length + 4
        if ctype == 'IEND':
            break
    return chunks


@characters_bp.route('/import_character_png', methods=['POST'])
def import_character_png():
    """Не тронуто по сути — по-прежнему возвращает распарсенные данные
    фронту на ревью, не пишет в БД напрямую. Единственное отличие от
    старой версии: character_book из ответа убран — лорбуки теперь
    отдельная сущность (отдельный этап плана), сюда больше не суётся."""
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'no file uploaded'}), 400
        file = request.files['file']
        png_bytes = file.read()

        chunks = _read_png_text_chunks(png_bytes)

        raw = chunks.get('ccv3') or chunks.get('chara')
        if not raw:
            return jsonify({'success': False, 'error': 'no character data found in PNG (missing chara/ccv3 chunk)'}), 400

        try:
            decoded = base64.b64decode(raw)
            card = json.loads(decoded)
        except Exception:
            return jsonify({'success': False, 'error': 'character chunk found but could not be decoded (corrupt or unsupported encoding)'}), 400

        data = card.get('data', card)
        if not isinstance(data, dict):
            return jsonify({'success': False, 'error': 'character chunk decoded but has no usable data (wrong shape)'}), 400

        if not str(data.get('name', '')).strip() and not str(data.get('first_mes', '')).strip():
            return jsonify({'success': False, 'error': 'character data found but is empty (no name or first message) — the card may be corrupted'}), 400

        avatar_b64 = base64.b64encode(png_bytes).decode('ascii')

        # character_book вынесен из ответа сознательно: лорбуки больше не
        # часть карточки персонажа на уровне хранения (см. план — этап 4).
        # Если у импортируемой карточки есть непустые entries, их подхватит
        # отдельный флоу "автосоздание лорбука при импорте" когда он будет
        # готов — сюда его пока не тащим, чтобы не плодить недострой номер два.
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
                'tags': data.get('tags', []),
                'creator': data.get('creator', ''),
                'character_version': data.get('character_version', ''),
                'extensions': data.get('extensions', {}) if isinstance(data.get('extensions'), dict) else {},
            },
            'image': f'data:image/png;base64,{avatar_b64}',
            'spec_found': 'v3' if 'ccv3' in chunks else 'v2',
            # Отдаём сырой character_book отдельно (не внутри data) — фронт
            # решит что с ним делать (например, предложить юзеру "создать
            # лорбук из этой карточки?"), но это уже не поле персонажа.
            'raw_character_book': data.get('character_book', {'entries': []}),
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


def _get_llama_server_url():
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
    """Не тронуто — токенизация полей формы, к БД никак не относится."""
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
        text = (request.json or {}).get('text', '')
        return jsonify({'tokens': round(len(text) / 4), 'approximate': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500