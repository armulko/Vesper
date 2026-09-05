import json
from flask import Blueprint, request, jsonify
from db import get_db

lorebooks_bp = Blueprint('lorebooks', __name__)


def _entry_to_dict(row):
    d = dict(row)
    for field in ('keys', 'secondary_keys'):
        raw = d.get(field)
        try:
            d[field] = json.loads(raw) if raw else ([] if field == 'keys' else None)
        except (json.JSONDecodeError, TypeError):
            d[field] = [] if field == 'keys' else None
    return d


@lorebooks_bp.route('/get_lorebooks', methods=['GET'])
def get_lorebooks():
    """Весь список лорбуков юзера — вкладка Лорбуков. Не фильтрует по
    shared/owner здесь: это полный список, фронт решает что показывать
    (например 'мои' vs 'общедоступные' как табы над одним и тем же списком)."""
    try:
        db = get_db()
        rows = db.execute('SELECT * FROM lorebooks ORDER BY id').fetchall()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@lorebooks_bp.route('/lorebook/<int:lorebook_id>', methods=['GET'])
def get_lorebook(lorebook_id):
    """Один лорбук + все его entries — для экрана редактирования."""
    try:
        db = get_db()
        lorebook = db.execute('SELECT * FROM lorebooks WHERE id = ?', (lorebook_id,)).fetchone()
        if not lorebook:
            return jsonify({'error': 'lorebook not found'}), 404
        entries = db.execute(
            'SELECT * FROM lorebook_entries WHERE lorebook_id = ? ORDER BY priority DESC, id',
            (lorebook_id,)
        ).fetchall()
        result = dict(lorebook)
        result['entries'] = [_entry_to_dict(e) for e in entries]
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@lorebooks_bp.route('/save_lorebook', methods=['POST'])
def save_lorebook():
    """Создаёт лорбук (пустой или с entries сразу, если фронт шлёт их
    массивом — удобно для импорта из карточки персонажа, см. отдельный
    /import_lorebook_from_character ниже, который переиспользует это же
    поле). auto_created_for_character_id не принимается отсюда напрямую —
    для этого есть отдельный явный эндпоинт импорта, чтобы обычное ручное
    'создать лорбук' не могло случайно выставить происхождение."""
    try:
        data = request.json or {}
        name = data.get('name', 'New lorebook')
        is_shared = 1 if data.get('is_shared') else 0
        scan_depth = data.get('scan_depth', 4)
        entries = data.get('entries', [])

        db = get_db()
        cur = db.execute(
            'INSERT INTO lorebooks (name, is_shared, scan_depth) VALUES (?, ?, ?)',
            (name, is_shared, scan_depth)
        )
        lorebook_id = cur.lastrowid
        _insert_entries(db, lorebook_id, entries)
        db.commit()
        return jsonify({'success': True, 'id': lorebook_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


def _insert_entries(db, lorebook_id, entries):
    for e in entries:
        db.execute(
            '''INSERT INTO lorebook_entries (
                   lorebook_id, keys, secondary_keys, content, enabled,
                   priority, case_sensitive, position, token_budget
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                lorebook_id,
                json.dumps(e.get('keys', []), ensure_ascii=False),
                json.dumps(e.get('secondary_keys'), ensure_ascii=False) if e.get('secondary_keys') else None,
                e.get('content', ''),
                1 if e.get('enabled', True) else 0,
                e.get('priority', 100),
                1 if e.get('case_sensitive') else 0,
                e.get('position', 'before_char'),
                e.get('token_budget'),
            )
        )


@lorebooks_bp.route('/update_lorebook/<int:lorebook_id>', methods=['PUT'])
def update_lorebook(lorebook_id):
    """Обновляет мета-поля лорбука (name/is_shared/scan_depth) И полностью
    заменяет набор entries, если он передан — тот же 'снести и перезаписать'
    подход что в save_chat_history, оправдан по той же причине: фронт
    редактирует entries как единый список в форме, дельту присылать не
    удобнее чем целиком."""
    try:
        data = request.json or {}
        db = get_db()
        existing = db.execute('SELECT id FROM lorebooks WHERE id = ?', (lorebook_id,)).fetchone()
        if not existing:
            return jsonify({'success': False, 'error': 'lorebook not found'}), 404

        db.execute(
            '''UPDATE lorebooks SET name = ?, is_shared = ?, scan_depth = ?,
                   updated_at = datetime('now') WHERE id = ?''',
            (
                data.get('name', 'Unnamed'),
                1 if data.get('is_shared') else 0,
                data.get('scan_depth', 4),
                lorebook_id,
            )
        )

        if 'entries' in data:
            db.execute('DELETE FROM lorebook_entries WHERE lorebook_id = ?', (lorebook_id,))
            _insert_entries(db, lorebook_id, data['entries'])

        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@lorebooks_bp.route('/rename_lorebook/<int:lorebook_id>', methods=['PUT'])
def rename_lorebook(lorebook_id):
    """Отдельный узкий эндпоинт для переименования (обсуждали отдельно от
    остального редактирования) — не требует гонять entries туда-обратно
    ради смены одного поля."""
    try:
        data = request.json or {}
        name = data.get('name', '').strip()
        if not name:
            return jsonify({'success': False, 'error': 'name required'}), 400
        db = get_db()
        cur = db.execute(
            "UPDATE lorebooks SET name = ?, updated_at = datetime('now') WHERE id = ?",
            (name, lorebook_id)
        )
        db.commit()
        if cur.rowcount == 0:
            return jsonify({'success': False, 'error': 'lorebook not found'}), 404
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@lorebooks_bp.route('/delete_lorebook/<int:lorebook_id>', methods=['DELETE'])
def delete_lorebook(lorebook_id):
    """Просто удаляет — CASCADE сносит entries и character_lorebooks сам.
    Предупреждение 'это был локальный лорбук, точно удалить?' — та
    развилка, которую обсуждали ('автосоздан под перса и больше никуда не
    подключен') — это чисто UI-уровень принятия решения ПЕРЕД вызовом
    этого эндпоинта: фронт сам смотрит is_shared + сколько персонажей
    подключено (через /lorebook/<id>/characters ниже) и решает, показывать
    ли предупреждение. Здесь на бэкенде разделять 'просто отвязать' и
    'удалить насовсем' незачем — раз юзер дошёл до этого DELETE, значит
    уже решил, оба сценария ('локальный, никуда не подключен' и 'общий,
    подключен много где') одинаково завершаются полным удалением записи."""
    try:
        db = get_db()
        db.execute('DELETE FROM lorebooks WHERE id = ?', (lorebook_id,))
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# --- Подключение к персонажам (N:N через character_lorebooks) -------------

@lorebooks_bp.route('/character/<int:character_id>/lorebooks', methods=['GET'])
def get_character_lorebooks(character_id):
    try:
        db = get_db()
        rows = db.execute(
            '''SELECT l.* FROM lorebooks l
               JOIN character_lorebooks cl ON cl.lorebook_id = l.id
               WHERE cl.character_id = ?
               ORDER BY l.id''',
            (character_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@lorebooks_bp.route('/lorebook/<int:lorebook_id>/characters', methods=['GET'])
def get_lorebook_characters(lorebook_id):
    """Нужно фронту чтобы посчитать 'сколько персонажей подключено' перед
    показом предупреждения при удалении (см. комментарий в delete_lorebook)."""
    try:
        db = get_db()
        rows = db.execute(
            '''SELECT c.id, c.name FROM characters c
               JOIN character_lorebooks cl ON cl.character_id = c.id
               WHERE cl.lorebook_id = ?
               ORDER BY c.id''',
            (lorebook_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@lorebooks_bp.route('/connect_lorebook', methods=['POST'])
def connect_lorebook():
    try:
        data = request.json or {}
        character_id = data.get('character_id')
        lorebook_id = data.get('lorebook_id')
        if not character_id or not lorebook_id:
            return jsonify({'success': False, 'error': 'character_id and lorebook_id required'}), 400
        db = get_db()
        db.execute(
            'INSERT OR IGNORE INTO character_lorebooks (character_id, lorebook_id) VALUES (?, ?)',
            (character_id, lorebook_id)
        )
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@lorebooks_bp.route('/disconnect_lorebook', methods=['POST'])
def disconnect_lorebook():
    try:
        data = request.json or {}
        character_id = data.get('character_id')
        lorebook_id = data.get('lorebook_id')
        if not character_id or not lorebook_id:
            return jsonify({'success': False, 'error': 'character_id and lorebook_id required'}), 400
        db = get_db()
        db.execute(
            'DELETE FROM character_lorebooks WHERE character_id = ? AND lorebook_id = ?',
            (character_id, lorebook_id)
        )
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@lorebooks_bp.route('/import_lorebook_from_character', methods=['POST'])
def import_lorebook_from_character():
    """Автосоздание лорбука из character_book при импорте PNG-карточки
    (см. routes/characters.py: import_character_png теперь отдаёт
    raw_character_book отдельным полем вместо того чтобы тихо его
    дропать — фронт после успешного импорта персонажа зовёт этот
    эндпоинт, если raw_character_book.entries непустой).

    Ожидает: {character_id, name, entries: [...]}
    Создаёт лорбук с auto_created_for_character_id = character_id и сразу
    подключает его к этому персонажу через character_lorebooks — ровно то
    'автоматически создаётся и подключается', что обсуждали. Возможность
    докинуть ещё общих лорбуков сверху не отменяется — это просто ещё один
    connect_lorebook на тот же character_id."""
    try:
        data = request.json or {}
        character_id = data.get('character_id')
        name = data.get('name', 'Imported lorebook')
        entries = data.get('entries', [])
        if not character_id:
            return jsonify({'success': False, 'error': 'character_id required'}), 400
        if not entries:
            return jsonify({'success': False, 'error': 'no entries to import'}), 400

        db = get_db()
        char = db.execute('SELECT id FROM characters WHERE id = ?', (character_id,)).fetchone()
        if not char:
            return jsonify({'success': False, 'error': 'character not found'}), 404

        cur = db.execute(
            'INSERT INTO lorebooks (name, is_shared, auto_created_for_character_id) VALUES (?, 0, ?)',
            (name, character_id)
        )
        lorebook_id = cur.lastrowid
        _insert_entries(db, lorebook_id, entries)
        db.execute(
            'INSERT OR IGNORE INTO character_lorebooks (character_id, lorebook_id) VALUES (?, ?)',
            (character_id, lorebook_id)
        )
        db.commit()
        return jsonify({'success': True, 'lorebook_id': lorebook_id, 'imported_entries': len(entries)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
