import json
import re
import requests
from flask import Blueprint, request, jsonify, Response, stream_with_context
from model_logic.model_manager import get_llm, llm_lock
from settings import cfg, get_active_llm_cfg
from db import get_db
import threading

chat_bp = Blueprint('chat', __name__)


# --- Лорбук: сканирование ключей и инъекция контента -----------------------
#
# Чистый строковый матчинг, без обращения к модели (см. обсуждение — это
# программный prompt-preprocessing шаг, не LLM-задача). Работает по тем же
# `lines`, что и остальная сборка промпта — то есть по сырому тексту истории
# как он пришёл от фронта, ДО любых замен {{user}}/{{char}} (замена
# происходит позже, при рендере system_block/notes/etc, но lines сюда
# попадают нетронутыми).

def _key_matches(key, scan_text_lower, scan_text_raw, case_sensitive):
    """Одна проверка одного ключа. Ключ вида /regex/ — режим regex (та же
    конвенция что в ST: обёрнут в слэши = паттерн, иначе — обычная
    подстрока). Пустой/битый ключ никогда не матчится, а не роняет скан."""
    if not key:
        return False
    if len(key) >= 2 and key.startswith('/') and key.endswith('/'):
        pattern = key[1:-1]
        try:
            flags = 0 if case_sensitive else re.IGNORECASE
            return re.search(pattern, scan_text_raw, flags) is not None
        except re.error:
            return False
    haystack = scan_text_raw if case_sensitive else scan_text_lower
    needle = key if case_sensitive else key.lower()
    return needle in haystack


def _entry_triggers(entry, scan_text_lower, scan_text_raw):
    """keys[] матчится по OR (любой ключ триггерит), secondary_keys[] (если
    заданы) добавляют AND поверх этого — сработает только если есть хотя бы
    один основной ключ И хотя бы один secondary. Секонд-ключи без основных
    ничего не триггерят сами по себе, это уточняющее условие, не альтернатива."""
    case_sensitive = bool(entry['case_sensitive'])
    keys = json.loads(entry['keys']) if entry['keys'] else []
    if not any(_key_matches(k, scan_text_lower, scan_text_raw, case_sensitive) for k in keys):
        return False

    secondary_raw = entry['secondary_keys']
    if secondary_raw:
        secondary_keys = json.loads(secondary_raw)
        if secondary_keys and not any(
            _key_matches(k, scan_text_lower, scan_text_raw, case_sensitive) for k in secondary_keys
        ):
            return False
    return True


def scan_lorebooks(character_id, lines, token_budget_fn, total_token_budget=None):
    """Возвращает (before_char_text, after_char_text) — уже склеенные строки
    готовые для вставки в system_block, отсортированные по priority DESC и
    урезанные под бюджет. token_budget_fn(text) -> int должен считать токены
    тем же способом что и остальной прompt (см. count_tokens_text ниже),
    чтобы бюджет не расходился с тем, что реально увидит модель.

    total_token_budget — общий лимит на весь инжектируемый лорбук-контент
    разом (before+after вместе). None (дефолт) значит "взять из настроек
    юзера" — реальный ключ prompts.LOREBOOK_TOKEN_BUDGET в settings.json/
    settings.js:SETTINGS_SCHEMA (0 в настройках = не ограничивать). Явно
    переданное число (например в тестах) перебивает cfg().

    at_depth position пока не реализован (см. обсуждение — сложная фича,
    следующий заход) — entries с position='at_depth' сканируются и
    матчатся как обычно, но вставляются как before_char, чтобы хотя бы не
    потерять их полностью, а не молча дропаются.
    """
    if total_token_budget is None:
        total_token_budget = cfg('prompts', 'LOREBOOK_TOKEN_BUDGET') or 0

    db = get_db()
    lorebooks = db.execute(
        '''SELECT l.* FROM lorebooks l
           JOIN character_lorebooks cl ON cl.lorebook_id = l.id
           WHERE cl.character_id = ?''',
        (character_id,)
    ).fetchall()

    if not lorebooks:
        return '', ''

    # Разные лорбуки на одном персонаже могут иметь разный scan_depth —
    # берём максимальный, чтобы ни один entry не остался недосканирован
    # (лишние строки в окне не вредят более "мелким" лорбукам, у них всё
    # равно решает совпадение ключа, не размер окна).
    max_depth = max(lb['scan_depth'] for lb in lorebooks)
    scan_window = lines[-max_depth:] if max_depth > 0 else lines
    scan_text_raw = "\n".join(scan_window)
    scan_text_lower = scan_text_raw.lower()

    lorebook_ids = [lb['id'] for lb in lorebooks]
    placeholders = ','.join('?' * len(lorebook_ids))
    entries = db.execute(
        f'''SELECT * FROM lorebook_entries
            WHERE lorebook_id IN ({placeholders}) AND enabled = 1
            ORDER BY priority DESC, id''',
        lorebook_ids
    ).fetchall()

    triggered = [e for e in entries if _entry_triggers(e, scan_text_lower, scan_text_raw)]

    before_parts, after_parts = [], []
    used_tokens = 0
    for entry in triggered:
        content = entry['content']
        if not content:
            continue
        cost = entry['token_budget'] if entry['token_budget'] is not None else token_budget_fn(content)
        if total_token_budget and used_tokens + cost > total_token_budget:
            continue
        used_tokens += cost
        if entry['position'] == 'after_char':
            after_parts.append(content)
        else:
            # before_char И at_depth (пока не реализован отдельно) едут сюда
            before_parts.append(content)

    return "\n".join(before_parts), "\n".join(after_parts)


def replace_placeholders(text, char_name, user_name):
    if not text:
        return text
    text = text.replace('{{char}}', char_name).replace('{{user}}', user_name)
    text = text.replace('{char}', char_name).replace('{user}', user_name)
    return text

def tokenize(text):
    try:
        llm_cfg = get_active_llm_cfg()
        r = requests.post(f"{cfg('system', 'LLAMA_SERVER_URL')}/tokenize", json={"content": text}, timeout=llm_cfg.get('tokenize_timeout', 3))
        if r.status_code == 200:
            return r.json().get("tokens", [])
    except Exception:
        pass
    return None  

def count_tokens_text(text):
    tokens = tokenize(text)
    if tokens is None:
        return max(1, int(len(text) / 2.5))
    return len(tokens)

@chat_bp.route('/get_suggest_prompt', methods=['POST'])
def get_suggest_prompt():
    data = request.json
    persona_name = data.get('personaName', 'User')
    persona_description = data.get('personaDescription', '')
    char_name = data.get('characterName', 'AI')
    char_instructions = data.get('characterInstructions', '')

    prompt = cfg('prompts', 'SUGGEST_SYSTEM_PROMPT')\
        .replace('{{persona_name}}', persona_name)\
        .replace('{{char_name}}', char_name)\
        .replace('{{persona_description}}', f' {persona_description}' if persona_description else '')\
        .replace('{{char_instructions}}', f' {char_instructions}' if char_instructions else '')

    return jsonify({'systemPrompt': prompt})

def _fill_content_template(template, value):
    # .format(content=...) doesn't work here: Python's str.format treats
    # {{ as an escaped literal brace, not a placeholder — so a template
    # written as "...{{content}}..." would never get substituted, it'd
    # just print literal {content} in the output. Plain string replace
    # sidesteps that: try the double-brace form first (the default going
    # forward), fall back to the single-brace form for older templates
    # that were written before this switch.
    if '{{content}}' in template:
        return template.replace('{{content}}', value)
    return template.replace('{content}', value)

def build_system_prompt(character_prompt):
    return f"{cfg('prompts', 'DEFAULT_SYSTEM_RULES')}\n\nDESCRIPTION:\n{character_prompt}"

def build_prompt(system_block, lines, char_name, ooc_command=None, post_history_instructions=None,
                  character_notes=None, lorebook_before_char='', lorebook_after_char=''):
    if lorebook_before_char:
        # before_char едет в самый system_block, перед остальным DESCRIPTION —
        # это "фоновый лор мира", он должен читаться раньше информации о
        # персонаже, не после неё (см. обсуждение позиционирования).
        safe_before = lorebook_before_char.replace("{", "{{").replace("}", "}}")
        system_block = f"{safe_before}\n\n{system_block}"

    history_block = "\n".join(lines).replace("{", "{{").replace("}", "}}")
    instruction_block = history_block
    if character_notes:
        # Moved here from system_block on purpose: notes buried at the start of a
        # multi-thousand-token prompt get drowned out by history. Placing them
        # right before generation (OOC-style, same as ooc_command below) gives
        # them the same recency weight that made /cmd reliable.
        safe_notes = character_notes.replace("{", "{{").replace("}", "}}")
        notes_template = cfg('prompts', 'NOTES_TEMPLATE')
        instruction_block += "\n" + _fill_content_template(notes_template, safe_notes) + "\n"
    if lorebook_after_char:
        # after_char — "важно прямо сейчас", инъектится ближе к генерации,
        # той же логикой recency что notes/ooc выше.
        safe_after = lorebook_after_char.replace("{", "{{").replace("}", "}}")
        instruction_block += f"\n{safe_after}\n"
    if post_history_instructions:
        # Escaped the same way as the OOC note below — it's user/creator
        # text riding through a .format() call downstream via prompt_template,
        # so stray { or } would otherwise blow up formatting or get silently eaten.
        safe_phi = post_history_instructions.replace("{", "{{").replace("}", "}}")
        instruction_block += f"\n[{char_name}'s ongoing instructions: {safe_phi}]\n"
    if ooc_command:
        safe_ooc = ooc_command.replace("{", "{{").replace("}", "}}")
        ooc_template = cfg('prompts', 'OOC_TEMPLATE')
        instruction_block += "\n" + _fill_content_template(ooc_template, safe_ooc) + "\n"
    t = get_active_llm_cfg().get('chat_template', {})
    return t.get('prompt_template', '{system_start}{system}{system_end}{inst_start}{instruction}{inst_end}{char_name}:').format(
        system_start=t.get('system_start', ''),
        system=system_block,
        system_end=t.get('system_end', ''),
        inst_start=t.get('inst_start', ''),
        instruction=instruction_block,
        inst_end=t.get('inst_end', ''),
        char_name=char_name
    )

@chat_bp.route('/chat', methods=['POST'])
def chat():
    if not get_llm():
        return jsonify({'error': 'LLM model not loaded'}), 400

    data = request.json
    system_prompt = data.get('systemPrompt', '')
    conversation_history = data.get('conversationHistory', '')
    char_name = data.get('characterName', 'AI')
    user_name = data.get('personaName', 'User')
    ooc_command = data.get('oocCommand')
    character_notes = data.get('characterNotes', '').strip()
    post_history_instructions = data.get('postHistoryInstructions', '').strip()
    # character_id опционален для обратной совместимости — если фронт его
    # не шлёт (или это ещё старый клиент), лорбук просто не сканируется,
    # остальной прompt собирается как раньше.
    character_id = data.get('characterId')

    if not conversation_history:
        return jsonify({'error': 'Empty history'}), 400

    system_prompt = replace_placeholders(system_prompt, char_name, user_name)
    system_block = build_system_prompt(system_prompt)
    system_block = replace_placeholders(system_block, char_name, user_name)

    character_notes = replace_placeholders(character_notes, char_name, user_name)
    post_history_instructions = replace_placeholders(post_history_instructions, char_name, user_name)

    llm_cfg = get_active_llm_cfg()
    lines = conversation_history.strip().split("\n")

    lorebook_before, lorebook_after = ('', '')
    if character_id:
        # Скан один раз, не на каждой итерации truncation ниже: скан-окно
        # берётся с КОНЦА lines (последние N сообщений), а truncation режет
        # с НАЧАЛА (lines.pop(0)) — то есть хвост, где матчатся ключи, в
        # подавляющем большинстве случаев не меняется от урезания истории.
        # Не идеально точно на грани (очень короткая история), но избавляет
        # от лишних SQL-запросов на каждый pop() — разумный компромисс.
        lorebook_before, lorebook_after = scan_lorebooks(character_id, lines, count_tokens_text)
        if lorebook_before:
            lorebook_before = replace_placeholders(lorebook_before, char_name, user_name)
        if lorebook_after:
            lorebook_after = replace_placeholders(lorebook_after, char_name, user_name)

    full_prompt = build_prompt(system_block, lines, char_name, ooc_command, post_history_instructions,
                                character_notes, lorebook_before, lorebook_after)
    token_count = count_tokens_text(full_prompt)
    max_prompt = llm_cfg.get('context_size', 4096) - llm_cfg.get('max_answer_tokens', 300)

    if token_count > max_prompt:
        while token_count > max_prompt and len(lines) > 2:
            lines.pop(0)
            full_prompt = build_prompt(system_block, lines, char_name, ooc_command, post_history_instructions,
                                        character_notes, lorebook_before, lorebook_after)
            token_count = count_tokens_text(full_prompt)

    def generate():
        llm_cfg = get_active_llm_cfg()
        acquired = llm_lock.acquire(timeout=llm_cfg.get('lock_acquire_timeout', 10))
        if not acquired:
            yield f"data: {json.dumps({'error': 'Model is busy, try again'})}\n\n"
            return

        import time
        timeout_sec = llm_cfg.get('generation_timeout', 20)
        last_activity = time.time()  # Record the start time

        try:
            t = llm_cfg.get('chat_template', {})
            stop_tokens = t.get('stop_tokens', []) + [f"\n{user_name}:", f"\n{char_name}:"]
            payload = {
                "prompt": full_prompt,
                "n_predict": llm_cfg.get('max_answer_tokens', 300),
                "temperature": cfg('generation', 'TEMPERATURE'),
                "top_p": cfg('generation', 'TOP_P'),
                "top_k": cfg('generation', 'TOP_K'),
                "repeat_penalty": cfg('generation', 'REPEAT_PENALTY'),
                "frequency_penalty": cfg('generation', 'FREQUENCY_PENALTY'),
                "presence_penalty": cfg('generation', 'PRESENCE_PENALTY'),
                "stop": stop_tokens,
                "stream": True
            }
            with requests.post(
                f"{cfg('system', 'LLAMA_SERVER_URL')}/completion",
                json=payload,
                stream=True,
                timeout=timeout_sec
            ) as resp:
                for line in resp.iter_lines():
                    # Check for a hang timeout without spawning new threads
                    if time.time() - last_activity > timeout_sec:
                        raise TimeoutError("Generation hung")

                    if not line:
                        continue
                    
                    last_activity = time.time()  # Reset the timer upon receiving data
                    line = line.decode("utf-8")
                    
                    if line.startswith("data: "):
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":  # Exit safely if the server sent an end-of-stream marker
                            break
                        
                        try:
                            chunk = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue
                            
                        token = chunk.get("content", "")
                        if token:
                            yield f"data: {json.dumps({'token': token})}\n\n"
                        if chunk.get("stop"):
                            yield f"data: {json.dumps({'done': True, 'token_count': token_count})}\n\n"
                            break

        except TimeoutError as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            llm_lock.release()

    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@chat_bp.route('/count_tokens', methods=['POST'])
def count_tokens():
    if not get_llm():
        return jsonify({'count': 0})
    try:
        data = request.json
        text = data.get('text', '')
        char_name = data.get('char_name', 'AI')
        user_name = data.get('user_name', 'User')
        system_prompt = data.get('system_prompt', '')

        system_block = build_system_prompt(system_prompt)
        system_block = replace_placeholders(system_block, char_name, user_name)

        lines = text.strip().split("\n") if text.strip() else []
        t = get_active_llm_cfg().get('chat_template', {})
        full_prompt = t.get('prompt_template', '{system_start}{system}{system_end}{inst_start}{instruction}{inst_end}{char_name}:').format(
            system_start=t.get('system_start', ''),
            system=system_block,
            system_end=t.get('system_end', ''),
            inst_start=t.get('inst_start', ''),
            instruction="\n".join(lines),
            inst_end=t.get('inst_end', ''),
            char_name=char_name
        )
        return jsonify({'count': count_tokens_text(full_prompt)})
    except Exception:
        return jsonify({'count': 0})


@chat_bp.route('/summarize', methods=['POST'])
def summarize():
    if not get_llm():
        return jsonify({'error': 'Model not loaded'}), 400

    data = request.json
    messages = data.get('messages', [])
    previous_summaries = data.get('previousSummaries', [])
    history_text = "\n".join(messages)

    if previous_summaries:
        prior_context = "\n\n---\n\n".join(previous_summaries)
        instruction_block = (
            f"The following are previously created summaries for this conversation. "
            f"Do not repeat information already recorded there. Use them as context to avoid duplication "
            f"and correctly prioritize new information:\n{prior_context}\n\n"
            f"New fragment to summarize:\n{history_text}\n\n{cfg('prompts', 'SUMMARIZE_PROMPT')}"
        )
    else:
        instruction_block = f"Summary:\n{history_text}\n\n{cfg('prompts', 'SUMMARIZE_PROMPT')}"

    t = get_active_llm_cfg().get('chat_template', {})
    full_prompt = t.get('prompt_template', '{system_start}{system}{system_end}{inst_start}{instruction}{inst_end}{char_name}:').format(
        system_start=t.get('system_start', ''),
        system=cfg('prompts', 'SUMMARIZE_PROMPT'),
        system_end=t.get('system_end', ''),
        inst_start=t.get('inst_start', ''),
        instruction=instruction_block,
        inst_end=t.get('inst_end', ''),
        char_name="Summary"
    )

    def generate():
        llm_cfg = get_active_llm_cfg()
        acquired = llm_lock.acquire(timeout=llm_cfg.get('lock_acquire_timeout', 10))
        if not acquired:
            yield f"data: {json.dumps({'error': 'Model is busy, try again'})}\n\n"
            return

        timeout_sec = llm_cfg.get('generation_timeout', 20)
        timed_out = threading.Event()
        timer = None

        def _on_timeout():
            timed_out.set()

        try:
            payload = {
                "prompt": full_prompt,
                "n_predict": llm_cfg.get('summarize_n_predict', 5000),
                "temperature": llm_cfg.get('summarize_temperature', 0.3),
                "stop": llm_cfg.get('chat_template', {}).get('stop_tokens', []),
                "stream": True
            }
            with requests.post(
                f"{cfg('system', 'LLAMA_SERVER_URL')}/completion",
                json=payload,
                stream=True,
                timeout=timeout_sec
            ) as resp:
                if resp.status_code != 200:
                    yield f"data: {json.dumps({'error': f'Summarization server error: {resp.status_code}'})}\n\n"
                    return

                for line in resp.iter_lines():
                    if timed_out.is_set():
                        raise TimeoutError("Generation hung")
                    if timer is not None:
                        timer.cancel()
                    timer = threading.Timer(timeout_sec, _on_timeout)
                    timer.start()

                    if not line:
                        continue
                    line = line.decode("utf-8").strip()
                    if line.startswith("data: "):
                        raw_json = line[6:].strip()
                        if raw_json == "[DONE]":
                            break
                        try:
                            chunk = json.loads(raw_json)
                        except json.JSONDecodeError:
                            continue  
                        
                        token = chunk.get("content", "")
                        if token:
                            yield f"data: {json.dumps({'token': token})}\n\n"
                        if chunk.get("stop"):
                            yield f"data: {json.dumps({'done': True})}\n\n"
                            break

        except TimeoutError as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            if timer is not None:
                timer.cancel()
            llm_lock.release()

    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@chat_bp.route('/meta_summarize', methods=['POST'])
def meta_summarize():
    if not get_llm():
        return jsonify({'error': 'Model not loaded'}), 400

    data = request.json
    summaries = data.get('summaries', [])
    combined = "\n\n---\n\n".join(summaries)

    t = get_active_llm_cfg().get('chat_template', {})
    full_prompt = t.get('prompt_template', '{system_start}{system}{system_end}{inst_start}{instruction}{inst_end}{char_name}:').format(
        system_start=t.get('system_start', ''),
        system=cfg('prompts', 'META_SUMMARIZE_PROMPT'),
        system_end=t.get('system_end', ''),
        inst_start=t.get('inst_start', ''),
        instruction=f"{combined}\n\n{cfg('prompts', 'META_SUMMARIZE_PROMPT')}",
        inst_end=t.get('inst_end', ''),
        char_name="Summary"
    )

    def generate():
        llm_cfg = get_active_llm_cfg()
        acquired = llm_lock.acquire(timeout=llm_cfg.get('lock_acquire_timeout', 10))
        if not acquired:
            yield f"data: {json.dumps({'error': 'Model is busy, try again'})}\n\n"
            return

        timeout_sec = llm_cfg.get('generation_timeout', 20)
        timed_out = threading.Event()
        timer = None

        def _on_timeout():
            timed_out.set()

        try:
            payload = {
                "prompt": full_prompt,
                "n_predict": llm_cfg.get('summarize_n_predict', 5000),
                "temperature": llm_cfg.get('summarize_temperature', 0.3),
                "stop": llm_cfg.get('chat_template', {}).get('stop_tokens', []),
                "stream": True
            }
            with requests.post(
                f"{cfg('system', 'LLAMA_SERVER_URL')}/completion",
                json=payload,
                stream=True,
                timeout=timeout_sec
            ) as resp:
                if resp.status_code != 200:
                    yield f"data: {json.dumps({'error': f'Meta-summarization server error: {resp.status_code}'})}\n\n"
                    return

                for line in resp.iter_lines():
                    if timed_out.is_set():
                        raise TimeoutError("Generation hung")
                    if timer is not None:
                        timer.cancel()
                    timer = threading.Timer(timeout_sec, _on_timeout)
                    timer.start()

                    if not line:
                        continue
                    line = line.decode("utf-8").strip()
                    if line.startswith("data: "):
                        raw_json = line[6:].strip()
                        if raw_json == "[DONE]":
                            break
                        try:
                            chunk = json.loads(raw_json)
                        except json.JSONDecodeError:
                            continue  
                        
                        token = chunk.get("content", "")
                        if token:
                            yield f"data: {json.dumps({'token': token})}\n\n"
                        if chunk.get("stop"):
                            yield f"data: {json.dumps({'done': True})}\n\n"
                            break

        except TimeoutError as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            if timer is not None:
                timer.cancel()
            llm_lock.release()

    return Response(stream_with_context(generate()), mimetype='text/event-stream')