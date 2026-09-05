-- Vesper DB schema draft (SQLite)
-- PRAGMA foreign_keys = ON;  -- не забыть врубить, в SQLite это off по дефолту на каждое соединение

CREATE TABLE characters (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_id                  TEXT UNIQUE,   -- старый id из characters.json (vesper.id или root id),
                                                -- нужен только на время миграции чтобы смэтчить
                                                -- data/histories/<legacy_id>.json, avatars/, notes/<legacy_id>.txt
    name                        TEXT NOT NULL,
    description                 TEXT,
    personality                 TEXT,
    scenario                    TEXT,
    first_mes                   TEXT,
    mes_example                 TEXT,
    creator_notes               TEXT,
    system_prompt               TEXT,
    post_history_instructions   TEXT,
    alternate_greetings         TEXT,       -- JSON array, как было
    tags                        TEXT,       -- JSON array
    creator                     TEXT,
    character_version           TEXT,
    extensions                  TEXT,       -- JSON, roundtrip как сейчас
    default_avatar              TEXT,                          -- svg-заглушка, назначается один раз навсегда
                                                                   -- при первом сейве, никогда не переприсваивается —
                                                                   -- переживает даже удаление реального аватара
    -- has_avatar не хранится: derived-флаг, вычисляется на лету через
    -- os.path.exists(avatar_path) при чтении, как и сейчас делает
    -- get_characters(). Хранить его отдельно значит синхронизировать
    -- руками при каждом save/update/delete аватарки — источник рассинхрона
    -- на ровном месте, раз это тривиально пересчитать.
    draft                       TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE personas (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_id                  TEXT UNIQUE,   -- старый id из personas.json, только для миграции
    name                        TEXT NOT NULL,
    description                 TEXT,
    default_avatar              TEXT,   -- та же железобетонная логика что у характеров
    -- has_avatar не хранится, derived — см. комментарий в characters
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- N:N персонаж <-> персона ("подключенные персоны")
CREATE TABLE character_personas (
    character_id                INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    persona_id                  INTEGER NOT NULL REFERENCES personas(id)   ON DELETE CASCADE,
    PRIMARY KEY (character_id, persona_id)
);
-- удаление персонажа рвёт связь автоматом, персона живёт дальше — как и обсуждали.
-- удаление персоны — та же логика зеркально.

CREATE TABLE chats (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id                INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    persona_id                  INTEGER NOT NULL REFERENCES personas(id)   ON DELETE CASCADE,
    -- CASCADE: удаление персоны разрешено, но на уровне приложения (не БД!)
    -- ДО DELETE делаешь COUNT(*) чатов с этой persona_id и, если > 0,
    -- показываешь юзеру предупреждение "персона используется в N чатах,
    -- удаление сотрёт и их — точно?". Согласился — DELETE персоны,
    -- дальше FK CASCADE сам сносит chats -> forks -> messages по цепочке.
    -- БД тут просто исполняет решение, подтверждение — целиком UI-слой.
    title                        TEXT,
    notes                        TEXT,   -- переехало сюда с character-уровня (data/notes/<id>.txt) —
                                          -- теперь на чат, не на персонажа, раз чатов много
    created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forks (
    id                           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id                      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    parent_fork_id               INTEGER REFERENCES forks(id) ON DELETE CASCADE,  -- NULL = "main"-ветка
    name                         TEXT,       -- человекочитаемое, не участвует в путях/id
    forked_from_message_id       INTEGER,    -- сознательно БЕЗ FK constraint'а (см. ниже)
    created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);
-- forked_from_message_id не объявлен как REFERENCES messages(id) намеренно:
-- если бы был ON DELETE CASCADE, удаление ЛЮБОГО сообщения, с которого
-- когда-то что-то форкнули, снесло бы сам форк по цепочке — а форк должен
-- пережить удаление своей точки старта (это просто "с какого места
-- ответвились", историческая метка, не структурная зависимость).
-- ON DELETE SET NULL был бы безопаснее, но SQLite не разрешает forward
-- reference на таблицу, объявленную ниже, без отдельного ALTER TABLE после
-- CREATE TABLE messages. Раз это все равно всего лишь "запись для истории"
-- (какое сообщение было точкой ветвления), а не связь, на которой держится
-- целостность дерева форков (за это отвечает parent_fork_id), проще и
-- честнее оставить обычным INTEGER и не выдавать его за constraint,
-- которого нет.

CREATE TABLE messages (
    id                           INTEGER PRIMARY KEY AUTOINCREMENT,
    fork_id                      INTEGER NOT NULL REFERENCES forks(id) ON DELETE CASCADE,
    seq                          INTEGER NOT NULL,   -- порядковый номер внутри ветки
    text                         TEXT NOT NULL,
    is_user                      INTEGER NOT NULL,   -- bool
    versions                     TEXT,   -- JSON array, свайпы регенерации
    raw_versions                 TEXT,   -- JSON array, до {{char}}/{{user}} замены
    active_version               INTEGER NOT NULL DEFAULT 0,
    is_archived                  INTEGER NOT NULL DEFAULT 0,
    is_summary                   INTEGER NOT NULL DEFAULT 0,
    created_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_fork_seq ON messages(fork_id, seq);

CREATE TABLE lorebooks (
    id                           INTEGER PRIMARY KEY AUTOINCREMENT,
    name                         TEXT NOT NULL,
    is_shared                    INTEGER NOT NULL DEFAULT 0,   -- bool, доступен в общем пуле
    auto_created_for_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
    -- "происхождение" — не владение. При удалении персонажа просто NULL-ится,
    -- лорбук как сирота живёт дальше в общем списке (та же логика что с персонами).
    scan_depth                   INTEGER NOT NULL DEFAULT 4,
    created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lorebook_entries (
    id                           INTEGER PRIMARY KEY AUTOINCREMENT,
    lorebook_id                  INTEGER NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
    keys                         TEXT NOT NULL,   -- JSON array
    secondary_keys                TEXT,            -- JSON array, optional AND-условие
    content                      TEXT NOT NULL,
    enabled                      INTEGER NOT NULL DEFAULT 1,
    priority                     INTEGER NOT NULL DEFAULT 100,
    case_sensitive                INTEGER NOT NULL DEFAULT 0,
    position                     TEXT NOT NULL DEFAULT 'before_char',  -- before_char | after_char | at_depth
    token_budget                  INTEGER   -- NULL = делить общий бюджет лорбука без индивидуального капа
);

-- N:N персонаж <-> лорбук ("подключенные лорбуки", включая автосозданные и общие)
CREATE TABLE character_lorebooks (
    character_id                 INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    lorebook_id                  INTEGER NOT NULL REFERENCES lorebooks(id)  ON DELETE CASCADE,
    PRIMARY KEY (character_id, lorebook_id)
);

-- дебаг-скрипт при старте не нужен (см. обсуждение) — FK integrity даёт
-- SQLite сам, если врублен PRAGMA foreign_keys = ON на каждом соединении.
-- Нужна только версионная миграционка (PRAGMA user_version или Alembic).