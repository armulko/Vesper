"""
Одноразовый скрипт миграции Vesper: старые JSON-файлы -> SQLite.

Гоняется ОДИН раз при апдейте на новую версию. Ничего не удаляет из
старых файлов — только читает их и льёт в новую БД, так что можно
гонять повторно на бэкапе если что-то пошло не так (но НЕ на живой
уже мигрированной базе — будут дубли, см. TODO про идемпотентность внизу).

Ожидаемая структура на входе (см. routes/characters.py, routes/personas.py):
    data/characters.json
    data/personas.json
    data/histories/<character_id>.json   (character_id = legacy id, число или строка)
    data/notes/<character_id>.txt        (plain text, может отсутствовать)
    data/avatars/characters/<id>.jpg     (не трогаем, просто оставляем на диске как есть)
    data/avatars/personas/<id>.jpg       (аналогично)

Аватарки НЕ переносим в БД — они остаются файлами на диске под тем же
путём. Только meta-данные (кто есть кто, default_avatar) едут в SQLite.
Пути к аватаркам после миграции строятся по новому integer id (см.
routes-層 после рефакторинга), так что если хочешь сохранить старые файлы
рабочими — либо переименовывай их под новый id после миграции, либо
временно резолвь путь через legacy_id пока не почистишь диск. Этот
скрипт сам файлы не трогает и не переименовывает.
"""

import json
import os
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CHARACTERS_FILE = os.path.join(DATA_DIR, 'characters.json')
PERSONAS_FILE = os.path.join(DATA_DIR, 'personas.json')
HISTORIES_DIR = os.path.join(DATA_DIR, 'histories')
NOTES_DIR = os.path.join(DATA_DIR, 'notes')
DB_FILE = os.path.join(DATA_DIR, 'vesper.db')
SCHEMA_FILE = os.path.join(BASE_DIR, 'vesper_schema.sql')


def _char_id(char):
    """Та же логика что в старом routes/characters.py: id мог жить и в
    vesper-обёртке, и в корне, дублируясь. Берём откуда найдём."""
    return char.get('vesper', {}).get('id') or char.get('id')


def _char_name(char):
    if 'data' in char and isinstance(char['data'], dict):
        return char['data'].get('name', 'Unknown')
    return char.get('name', 'Unknown')


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_notes(legacy_id):
    path = os.path.join(NOTES_DIR, f'{legacy_id}.txt')
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    return None


def load_history(legacy_id):
    path = os.path.join(HISTORIES_DIR, f'{legacy_id}.json')
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []


def migrate():
    if not os.path.exists(SCHEMA_FILE):
        print(f'Schema file not found: {SCHEMA_FILE}', file=sys.stderr)
        sys.exit(1)

    if os.path.exists(DB_FILE):
        # Не идемпотентно (см. TODO внизу) — лучше остановиться и дать
        # человеку решить, чем молча задублировать всё на повторном запуске.
        print(f'{DB_FILE} уже существует. Удали его вручную (или переименуй '
              f'старый) если хочешь мигрировать заново — скрипт не идемпотентен.',
              file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(DB_FILE)
    conn.execute('PRAGMA foreign_keys = ON')
    with open(SCHEMA_FILE, 'r', encoding='utf-8') as f:
        conn.executescript(f.read())

    characters_raw = load_json(CHARACTERS_FILE, [])
    personas_raw = load_json(PERSONAS_FILE, [])

    # --- Персоны -------------------------------------------------------
    persona_id_map = {}  # legacy_id -> new integer id
    for p in personas_raw:
        legacy_id = str(p.get('id'))
        cur = conn.execute(
            '''INSERT INTO personas (legacy_id, name, description, default_avatar)
               VALUES (?, ?, ?, ?)''',
            (legacy_id, p.get('name', 'Unknown'), p.get('description', ''),
             p.get('default_avatar'))
        )
        persona_id_map[legacy_id] = cur.lastrowid

    # Фолбэк-персона, если у юзера вообще нет персон, но FK на chats.persona_id
    # требует NOT NULL. Решение — "бери что найдётся, не критично".
    fallback_persona_id = None
    if persona_id_map:
        fallback_persona_id = next(iter(persona_id_map.values()))
    else:
        cur = conn.execute(
            '''INSERT INTO personas (legacy_id, name, description, default_avatar)
               VALUES (NULL, ?, ?, ?)''',
            ('Legacy User', 'Автосозданная персона при миграции — у аккаунта '
             'не было ни одной персоны на момент апдейта.', '1.svg')
        )
        fallback_persona_id = cur.lastrowid

    # --- Персонажи -------------------------------------------------------
    for char in characters_raw:
        legacy_id = str(_char_id(char))
        data = char.get('data', {}) if isinstance(char.get('data'), dict) else {}
        vesper = char.get('vesper', {}) if isinstance(char.get('vesper'), dict) else {}

        cur = conn.execute(
            '''INSERT INTO characters (
                   legacy_id, name, description, personality, scenario,
                   first_mes, mes_example, creator_notes, system_prompt,
                   post_history_instructions, alternate_greetings, tags,
                   creator, character_version, extensions, default_avatar, draft
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                legacy_id,
                data.get('name') or _char_name(char),
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
                vesper.get('default_avatar') or char.get('default_avatar'),
                vesper.get('draft', ''),
            )
        )
        new_char_id = cur.lastrowid

        # character_book у старых карточек почти всегда пустой ({'entries': []})
        # — лорбуки переезжают отдельным заходом (см. четвёртый этап плана),
        # этот скрипт их не заводит, только фиксирует персонажа как такового.
        # Если у карточки реально есть непустые entries — стоит вручную
        # прогнать отдельный import позже, это НЕ делает текущий скрипт.

        # --- Главный чат для этого персонажа: переносим всю старую
        # плоскую историю + notes.txt как единственный чат "Main"
        # с фолбэк-персоной (см. выше — "бери что найдётся").
        old_notes = load_notes(legacy_id)
        chat_cur = conn.execute(
            '''INSERT INTO chats (character_id, persona_id, title, notes)
               VALUES (?, ?, ?, ?)''',
            (new_char_id, fallback_persona_id, 'Main', old_notes)
        )
        new_chat_id = chat_cur.lastrowid

        fork_cur = conn.execute(
            '''INSERT INTO forks (chat_id, parent_fork_id, name)
               VALUES (?, NULL, ?)''',
            (new_chat_id, 'main')
        )
        new_fork_id = fork_cur.lastrowid

        history = load_history(legacy_id)
        for seq, msg in enumerate(history):
            versions = msg.get('versions')
            raw_versions = msg.get('rawVersions')
            conn.execute(
                '''INSERT INTO messages (
                       fork_id, seq, text, is_user, versions, raw_versions,
                       active_version, is_archived, is_summary
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (
                    new_fork_id,
                    seq,
                    msg.get('text', ''),
                    1 if msg.get('isUser') else 0,
                    json.dumps(versions, ensure_ascii=False) if versions else None,
                    json.dumps(raw_versions, ensure_ascii=False) if raw_versions else None,
                    msg.get('activeVersion', 0),
                    1 if msg.get('isArchived') else 0,
                    1 if msg.get('isSummary') else 0,
                )
            )

    conn.commit()
    conn.close()
    print(f'Готово. {len(characters_raw)} персонажей, {len(personas_raw)} персон '
          f'перенесено в {DB_FILE}.')


# TODO про идемпотентность: если понадобится гонять скрипт повторно (например
# юзер накатил миграцию, что-то не сошлось, поправил код и хочет заново) —
# сейчас единственная защита это "файл БД уже существует, ничего не делаем".
# Нормальный upsert по legacy_id не реализован, потому что миграция гоняется
# ровно один раз на апдейте — усложнять сейчас нет смысла, но если появится
# кейс "мигрировать частями" — нужен будет ON CONFLICT(legacy_id) DO UPDATE.

if __name__ == '__main__':
    migrate()