import json
from flask import Blueprint, request, jsonify
from db import get_db

forks_bp = Blueprint('forks', __name__)


def _fork_to_dict(row):
    return dict(row)


@forks_bp.route('/chat/<int:chat_id>/forks', methods=['GET'])
def get_chat_forks(chat_id):
    """Список всех веток чата (для UI — переключатель форков). Плоский
    список, не дерево — parent_fork_id в каждой записи достаточно для
    фронта, чтобы самому построить вложенность, если понадобится
    визуализировать дерево, а не просто список веток."""
    try:
        db = get_db()
        rows = db.execute(
            '''SELECT f.*,
                      (SELECT COUNT(*) FROM messages m WHERE m.fork_id = f.id) AS message_count
               FROM forks f
               WHERE f.chat_id = ?
               ORDER BY f.id''',
            (chat_id,)
        ).fetchall()
        return jsonify([_fork_to_dict(r) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@forks_bp.route('/create_fork', methods=['POST'])
def create_fork():
    """Форкает ветку с конкретного сообщения: копирует всю историю ДО и
    ВКЛЮЧАЯ это сообщение в новый fork, дальше юзер продолжает диалог
    независимо от родительской ветки — правки в новой ветке не задевают
    старую, и наоборот.

    Ожидает: {chat_id, from_message_id, name (опционально)}
    from_message_id — id сообщения из ЛЮБОГО существующего форка этого
    чата (обычно main, но технически можно форкнуть форк — дерево
    поддерживает произвольную вложенность, см. parent_fork_id).
    """
    try:
        data = request.json or {}
        chat_id = data.get('chat_id')
        from_message_id = data.get('from_message_id')
        name = data.get('name', '').strip() or None
        if not chat_id or not from_message_id:
            return jsonify({'success': False, 'error': 'chat_id and from_message_id required'}), 400

        db = get_db()

        source_msg = db.execute(
            'SELECT * FROM messages WHERE id = ?', (from_message_id,)
        ).fetchone()
        if not source_msg:
            return jsonify({'success': False, 'error': 'source message not found'}), 404

        source_fork = db.execute(
            'SELECT * FROM forks WHERE id = ?', (source_msg['fork_id'],)
        ).fetchone()
        if not source_fork or source_fork['chat_id'] != chat_id:
            return jsonify({'success': False, 'error': 'source message does not belong to this chat'}), 400

        # Всё что до и ВКЛЮЧАЯ точку форка (seq <= source_msg.seq) едет
        # в новую ветку — дальше она живёт независимо.
        messages_to_copy = db.execute(
            'SELECT * FROM messages WHERE fork_id = ? AND seq <= ? ORDER BY seq',
            (source_fork['id'], source_msg['seq'])
        ).fetchall()

        cur = db.execute(
            '''INSERT INTO forks (chat_id, parent_fork_id, name, forked_from_message_id)
               VALUES (?, ?, ?, ?)''',
            (chat_id, source_fork['id'], name, from_message_id)
        )
        new_fork_id = cur.lastrowid

        for msg in messages_to_copy:
            db.execute(
                '''INSERT INTO messages (
                       fork_id, seq, text, is_user, versions, raw_versions,
                       active_version, is_archived, is_summary
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (
                    new_fork_id, msg['seq'], msg['text'], msg['is_user'],
                    msg['versions'], msg['raw_versions'], msg['active_version'],
                    msg['is_archived'], msg['is_summary'],
                )
            )

        db.commit()
        return jsonify({'success': True, 'fork_id': new_fork_id, 'copied_messages': len(messages_to_copy)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@forks_bp.route('/rename_fork/<int:fork_id>', methods=['PUT'])
def rename_fork(fork_id):
    try:
        data = request.json or {}
        name = data.get('name', '').strip()
        if not name:
            return jsonify({'success': False, 'error': 'name required'}), 400
        db = get_db()
        cur = db.execute('UPDATE forks SET name = ? WHERE id = ?', (name, fork_id))
        db.commit()
        if cur.rowcount == 0:
            return jsonify({'success': False, 'error': 'fork not found'}), 404
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@forks_bp.route('/delete_fork/<int:fork_id>', methods=['DELETE'])
def delete_fork(fork_id):
    """Удаляет ветку и все её сообщения (CASCADE). Дочерние форки (если
    кто-то форкнул этот форк) тоже каскадно снесутся — parent_fork_id ->
    forks(id) ON DELETE CASCADE. Main-ветку (parent_fork_id IS NULL)
    трогать нельзя — это фактически удаление всего чата целиком через
    боковую дверь, для этого есть отдельный delete_chat."""
    try:
        db = get_db()
        fork = db.execute('SELECT * FROM forks WHERE id = ?', (fork_id,)).fetchone()
        if not fork:
            return jsonify({'success': False, 'error': 'fork not found'}), 404
        if fork['parent_fork_id'] is None:
            return jsonify({'success': False, 'error': 'cannot delete the main branch — delete the whole chat instead'}), 400

        db.execute('DELETE FROM forks WHERE id = ?', (fork_id,))
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@forks_bp.route('/fork/<int:fork_id>/history', methods=['GET'])
def get_fork_history(fork_id):
    """Читает историю конкретной ветки напрямую по fork_id — в отличие от
    get_chat_history в chats.py, которая всегда бьёт в main. Это то, что
    UI будет дёргать при переключении между форками."""
    try:
        db = get_db()
        fork = db.execute('SELECT id FROM forks WHERE id = ?', (fork_id,)).fetchone()
        if not fork:
            return jsonify({'error': 'fork not found'}), 404
        rows = db.execute(
            'SELECT * FROM messages WHERE fork_id = ? ORDER BY seq', (fork_id,)
        ).fetchall()

        result = []
        for r in rows:
            d = dict(r)
            for field in ('versions', 'raw_versions'):
                raw = d.get(field)
                try:
                    d[field] = json.loads(raw) if raw else None
                except (json.JSONDecodeError, TypeError):
                    d[field] = None
            result.append(d)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
