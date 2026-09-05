import os
import base64
from flask import Blueprint, request, jsonify, send_file
from db import get_db
from routes.default_avatars import pick_random_default_avatar

personas_bp = Blueprint('personas', __name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
AVATARS_DIR = os.path.join(DATA_DIR, 'avatars', 'personas')


def ensure_dirs():
    os.makedirs(AVATARS_DIR, exist_ok=True)


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


def _row_to_dict(row):
    d = dict(row)
    d['has_avatar'] = os.path.exists(get_avatar_path(d['id']))
    return d


@personas_bp.route('/get_personas', methods=['GET'])
def get_personas():
    try:
        db = get_db()
        rows = db.execute('SELECT * FROM personas ORDER BY id').fetchall()
        return jsonify([_row_to_dict(r) for r in rows])
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

        db = get_db()
        cur = db.execute(
            '''INSERT INTO personas (name, description, default_avatar)
               VALUES (?, ?, ?)''',
            (data.get('name', 'Unknown'), data.get('description', ''),
             pick_random_default_avatar())
        )
        new_id = cur.lastrowid
        db.commit()

        if image_data:
            save_avatar(new_id, image_data)

        return jsonify({'success': True, 'id': new_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@personas_bp.route('/update_persona/<int:persona_id>', methods=['PUT'])
def update_persona(persona_id):
    try:
        data = request.json
        image_data = data.pop('image', None)

        db = get_db()
        existing = db.execute('SELECT id FROM personas WHERE id = ?', (persona_id,)).fetchone()
        if not existing:
            return jsonify({'success': False, 'error': 'persona not found'}), 404

        # default_avatar сознательно не в SET — та же железобетонная логика
        # что в characters.py: назначается один раз на INSERT, никогда не
        # трогается на UPDATE.
        db.execute(
            '''UPDATE personas SET name = ?, description = ?,
                   updated_at = datetime('now')
               WHERE id = ?''',
            (data.get('name', 'Unknown'), data.get('description', ''), persona_id)
        )
        db.commit()

        if image_data:
            save_avatar(persona_id, image_data)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@personas_bp.route('/delete_persona/<int:persona_id>', methods=['DELETE'])
def delete_persona(persona_id):
    """Раньше это был безусловный delete. Теперь персона может быть жёстко
    привязана к существующим чатам (chats.persona_id, NOT NULL) — схема
    сознательно ON DELETE CASCADE на этой связи (см. vesper_schema.sql),
    то есть удаление персоны технически снесёт и все её чаты + форки +
    сообщения по цепочке. Это осознанное решение (обсуждали) — но
    предупреждение юзеру обязательно ДО удаления, поэтому:

    - без ?force=true — только считаем и возвращаем сколько чатов заденет,
      ничего не удаляем. Фронт показывает предупреждение с этим числом.
    - с ?force=true — юзер подтвердил, реально удаляем (каскад делает
      остальное сам через FK).
    """
    try:
        db = get_db()
        chat_count = db.execute(
            'SELECT COUNT(*) AS c FROM chats WHERE persona_id = ?', (persona_id,)
        ).fetchone()['c']

        force = request.args.get('force', 'false').lower() == 'true'

        if chat_count > 0 and not force:
            return jsonify({
                'success': False,
                'needs_confirmation': True,
                'affected_chats': chat_count,
                'message': f'Эта персона используется в {chat_count} чат(ах). '
                           f'Удаление сотрёт их тоже. Повтори запрос с ?force=true, '
                           f'если это осознанное решение.'
            }), 409

        db.execute('DELETE FROM personas WHERE id = ?', (persona_id,))
        db.commit()
        delete_avatar(persona_id)
        return jsonify({'success': True, 'deleted_chats': chat_count})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# --- Подключение персон к персонажам (N:N через character_personas) -------

@personas_bp.route('/character/<int:character_id>/personas', methods=['GET'])
def get_character_personas(character_id):
    """Список персон, подключенных к конкретному персонажу — для вкладки
    персонажа, "список подключенных персон"."""
    try:
        db = get_db()
        rows = db.execute(
            '''SELECT p.* FROM personas p
               JOIN character_personas cp ON cp.persona_id = p.id
               WHERE cp.character_id = ?
               ORDER BY p.id''',
            (character_id,)
        ).fetchall()
        return jsonify([_row_to_dict(r) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@personas_bp.route('/persona/<int:persona_id>/characters', methods=['GET'])
def get_persona_characters(persona_id):
    """Обратная сторона — список персонажей, к которым подключена эта
    персона. Нужна для зеркальной кнопки во вкладке персоны, как ты и
    описывал (подключение видно и оттуда, и оттуда)."""
    try:
        db = get_db()
        rows = db.execute(
            '''SELECT c.id, c.name, c.default_avatar FROM characters c
               JOIN character_personas cp ON cp.character_id = c.id
               WHERE cp.persona_id = ?
               ORDER BY c.id''',
            (persona_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@personas_bp.route('/connect_persona', methods=['POST'])
def connect_persona():
    """Подключает персону к персонажу. Работает с любой стороны UI (форма
    персонажа или форма персоны шлют один и тот же запрос) — направление
    связи в N:N таблице не имеет значения, это просто пара id."""
    try:
        data = request.json or {}
        character_id = data.get('character_id')
        persona_id = data.get('persona_id')
        if not character_id or not persona_id:
            return jsonify({'success': False, 'error': 'character_id and persona_id required'}), 400

        db = get_db()
        # INSERT OR IGNORE — если связь уже есть, тихо не дублируем (PK
        # на паре (character_id, persona_id) и так бы отклонил дубль
        # ошибкой, IGNORE просто делает повторный "подключить" идемпотентным
        # вместо необходимости сначала проверять существование самим).
        db.execute(
            'INSERT OR IGNORE INTO character_personas (character_id, persona_id) VALUES (?, ?)',
            (character_id, persona_id)
        )
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@personas_bp.route('/disconnect_persona', methods=['POST'])
def disconnect_persona():
    """Рвёт связь персонаж<->персона. Ничего не удаляет из самих таблиц
    characters/personas — только строку в junction table, как обсуждали:
    'рвём соединение и кайфуем', ни один из двух объектов не трогается."""
    try:
        data = request.json or {}
        character_id = data.get('character_id')
        persona_id = data.get('persona_id')
        if not character_id or not persona_id:
            return jsonify({'success': False, 'error': 'character_id and persona_id required'}), 400

        db = get_db()
        db.execute(
            'DELETE FROM character_personas WHERE character_id = ? AND persona_id = ?',
            (character_id, persona_id)
        )
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500