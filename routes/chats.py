import json
from flask import Blueprint, request, jsonify
from db import get_db

chats_bp = Blueprint('chats', __name__)


def _row_to_dict(row):
    return dict(row)


def _message_to_dict(row):
    """Разворачивает JSON-текстовые колонки (versions/raw_versions) обратно
    в списки для ответа наружу — та же логика что JSON_FIELDS в
    characters.py, но локально: тут всего два таких поля, отдельная
    константа не оправдана."""
    d = dict(row)
    for field in ('versions', 'raw_versions'):
        raw = d.get(field)
        try:
            d[field] = json.loads(raw) if raw else None
        except (json.JSONDecodeError, TypeError):
            d[field] = None
    return d


def _get_or_create_main_fork(db, chat_id):
    """Каждый чат имеет ровно одну 'main'-ветку — она создаётся вместе с
    чатом (см. create_chat), так что в норме этот SELECT всегда находит
    что-то с первого раза. Fallback на создание — защита от рассинхрона
    (например, ручной SQL-правки в обход API), не штатный путь."""
    row = db.execute(
        'SELECT id FROM forks WHERE chat_id = ? AND parent_fork_id IS NULL ORDER BY id LIMIT 1',
        (chat_id,)
    ).fetchone()
    if row:
        return row['id']
    cur = db.execute(
        'INSERT INTO forks (chat_id, parent_fork_id, name) VALUES (?, NULL, ?)',
        (chat_id, 'main')
    )
    db.commit()
    return cur.lastrowid


@chats_bp.route('/character/<int:character_id>/chats', methods=['GET'])
def get_character_chats(character_id):
    """Список чатов персонажа — для UI 'создать чат / выбрать существующий'."""
    try:
        db = get_db()
        rows = db.execute(
            '''SELECT c.id, c.character_id, c.persona_id, c.title, c.created_at,
                      c.updated_at, p.name AS persona_name
               FROM chats c
               JOIN personas p ON p.id = c.persona_id
               WHERE c.character_id = ?
               ORDER BY c.updated_at DESC''',
            (character_id,)
        ).fetchall()
        return jsonify([_row_to_dict(r) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@chats_bp.route('/create_chat', methods=['POST'])
def create_chat():
    """Создаёт новый чат под персонажа с конкретной (уже подключенной)
    персоной. Персона фиксируется на чат жёстко в момент создания — как
    договаривались, дальше не меняется.

    Не проверяет здесь, что переданная persona_id реально есть в
    character_personas (подключена к этому персонажу) — тот constraint
    осмысленнее держать на стороне вызывающего UI (выбор идёт из уже
    отфильтрованного списка подключенных персон), а не дублировать
    ORM-проверкой здесь; если понадобится - легко добавить SELECT-guard.
    """
    try:
        data = request.json or {}
        character_id = data.get('character_id')
        persona_id = data.get('persona_id')
        title = data.get('title', 'New chat')
        if not character_id or not persona_id:
            return jsonify({'success': False, 'error': 'character_id and persona_id required'}), 400

        db = get_db()
        cur = db.execute(
            'INSERT INTO chats (character_id, persona_id, title) VALUES (?, ?, ?)',
            (character_id, persona_id, title)
        )
        chat_id = cur.lastrowid
        db.execute(
            'INSERT INTO forks (chat_id, parent_fork_id, name) VALUES (?, NULL, ?)',
            (chat_id, 'main')
        )
        db.commit()
        return jsonify({'success': True, 'chat_id': chat_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@chats_bp.route('/delete_chat/<int:chat_id>', methods=['DELETE'])
def delete_chat(chat_id):
    """CASCADE в схеме сам сносит forks -> messages. Персонаж и персона
    не трогаются — удаляется только сам чат и всё, что физически внутри
    него (форки/сообщения), не связи character_personas."""
    try:
        db = get_db()
        db.execute('DELETE FROM chats WHERE id = ?', (chat_id,))
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@chats_bp.route('/rename_chat/<int:chat_id>', methods=['PUT'])
def rename_chat(chat_id):
    try:
        data = request.json or {}
        title = data.get('title', '').strip()
        if not title:
            return jsonify({'success': False, 'error': 'title required'}), 400
        db = get_db()
        cur = db.execute(
            "UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ?",
            (title, chat_id)
        )
        db.commit()
        if cur.rowcount == 0:
            return jsonify({'success': False, 'error': 'chat not found'}), 404
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# --- История (main-ветка чата) --------------------------------------------
# Совместимо по духу со старыми /get_chat_history, /save_chat_history,
# /clear_chat_history из characters.py, но адресуется по chat_id, не
# character_id — раз персонаж теперь может иметь много чатов. Читает/пишет
# main fork; работа с произвольными форками — отдельный модуль (forks.py),
# следующий шаг после этого.

@chats_bp.route('/get_chat_history/<int:chat_id>', methods=['GET'])
def get_chat_history(chat_id):
    try:
        db = get_db()
        chat = db.execute('SELECT id FROM chats WHERE id = ?', (chat_id,)).fetchone()
        if not chat:
            return jsonify({'error': 'chat not found'}), 404

        fork_id = _get_or_create_main_fork(db, chat_id)
        rows = db.execute(
            'SELECT * FROM messages WHERE fork_id = ? ORDER BY seq', (fork_id,)
        ).fetchall()
        return jsonify([_message_to_dict(r) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@chats_bp.route('/save_chat_history/<int:chat_id>', methods=['POST'])
def save_chat_history(chat_id):
    """Сохраняет историю целиком в конкретную ветку — тот же контракт, что
    был у старого save_chat_history (фронт шлёт полный массив, не дельту),
    но теперь принимает опциональный fork_id в теле запроса: раз форки
    реально существуют (routes/forks.py), сохранение обязано знать, в
    какую ветку писать, а не всегда бить в main.

    Обратная совместимость: fork_id не передан -> пишем в main-ветку чата,
    как раньше (весь код до появления forks.py звал этот эндпоинт без
    понятия fork_id вообще, ломать этот путь незачем).
    """
    try:
        data = request.json or {}
        history = data.get('history', [])
        requested_fork_id = data.get('fork_id')

        db = get_db()
        chat = db.execute('SELECT id FROM chats WHERE id = ?', (chat_id,)).fetchone()
        if not chat:
            return jsonify({'success': False, 'error': 'chat not found'}), 404

        if requested_fork_id:
            fork = db.execute(
                'SELECT id FROM forks WHERE id = ? AND chat_id = ?',
                (requested_fork_id, chat_id)
            ).fetchone()
            if not fork:
                return jsonify({'success': False, 'error': 'fork not found in this chat'}), 404
            fork_id = fork['id']
        else:
            fork_id = _get_or_create_main_fork(db, chat_id)

        db.execute('DELETE FROM messages WHERE fork_id = ?', (fork_id,))
        for seq, msg in enumerate(history):
            versions = msg.get('versions')
            raw_versions = msg.get('rawVersions')
            db.execute(
                '''INSERT INTO messages (
                       fork_id, seq, text, is_user, versions, raw_versions,
                       active_version, is_archived, is_summary
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (
                    fork_id, seq, msg.get('text', ''),
                    1 if msg.get('isUser') else 0,
                    json.dumps(versions, ensure_ascii=False) if versions else None,
                    json.dumps(raw_versions, ensure_ascii=False) if raw_versions else None,
                    msg.get('activeVersion', 0),
                    1 if msg.get('isArchived') else 0,
                    1 if msg.get('isSummary') else 0,
                )
            )
        db.execute("UPDATE chats SET updated_at = datetime('now') WHERE id = ?", (chat_id,))
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@chats_bp.route('/clear_chat_history/<int:chat_id>', methods=['POST'])
def clear_chat_history(chat_id):
    try:
        db = get_db()
        fork_id = _get_or_create_main_fork(db, chat_id)
        db.execute('DELETE FROM messages WHERE fork_id = ?', (fork_id,))
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# --- Notes (теперь на уровне чата, не персонажа) ---------------------------

@chats_bp.route('/get_notes/<int:chat_id>', methods=['GET'])
def get_notes(chat_id):
    try:
        db = get_db()
        row = db.execute('SELECT notes FROM chats WHERE id = ?', (chat_id,)).fetchone()
        if not row:
            return jsonify({'error': 'chat not found'}), 404
        return jsonify({'notes': row['notes'] or ''})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@chats_bp.route('/save_notes/<int:chat_id>', methods=['POST'])
def save_notes(chat_id):
    try:
        data = request.json or {}
        notes = data.get('notes', '')
        db = get_db()
        cur = db.execute('UPDATE chats SET notes = ? WHERE id = ?', (notes, chat_id))
        db.commit()
        if cur.rowcount == 0:
            return jsonify({'success': False, 'error': 'chat not found'}), 404
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
