import json
import requests
from flask import Blueprint, request, jsonify, Response, stream_with_context
from model_logic.model_manager import get_llm, llm_lock
from settings import cfg, get_active_llm_cfg
import threading

chat_bp = Blueprint('chat', __name__)


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

def build_system_prompt(character_prompt):
    return f"{cfg('prompts', 'DEFAULT_SYSTEM_RULES')}\n\nDESCRIPTION:\n{character_prompt}"

def build_prompt(system_block, lines, char_name, ooc_command=None, post_history_instructions=None, character_notes=None):
    history_block = "\n".join(lines).replace("{", "{{").replace("}", "}}")
    instruction_block = history_block
    if character_notes:
        # Moved here from system_block on purpose: notes buried at the start of a
        # multi-thousand-token prompt get drowned out by history. Placing them
        # right before generation (OOC-style, same as ooc_command below) gives
        # them the same recency weight that made /cmd reliable.
        safe_notes = character_notes.replace("{", "{{").replace("}", "}}")
        notes_template = cfg('prompts', 'NOTES_TEMPLATE')
        instruction_block += "\n" + notes_template.format(content=safe_notes) + "\n"
    if post_history_instructions:
        # Escaped the same way as the OOC note below — it's user/creator
        # text riding through a .format() call downstream via prompt_template,
        # so stray { or } would otherwise blow up formatting or get silently eaten.
        safe_phi = post_history_instructions.replace("{", "{{").replace("}", "}}")
        instruction_block += f"\n[{char_name}'s ongoing instructions: {safe_phi}]\n"
    if ooc_command:
        safe_ooc = ooc_command.replace("{", "{{").replace("}", "}}")
        ooc_template = cfg('prompts', 'OOC_TEMPLATE')
        instruction_block += "\n" + ooc_template.format(content=safe_ooc) + "\n"
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

    if not conversation_history:
        return jsonify({'error': 'Empty history'}), 400

    system_prompt = replace_placeholders(system_prompt, char_name, user_name)
    system_block = build_system_prompt(system_prompt)
    system_block = replace_placeholders(system_block, char_name, user_name)

    character_notes = replace_placeholders(character_notes, char_name, user_name)
    post_history_instructions = replace_placeholders(post_history_instructions, char_name, user_name)

    llm_cfg = get_active_llm_cfg()
    lines = conversation_history.strip().split("\n")
    full_prompt = build_prompt(system_block, lines, char_name, ooc_command, post_history_instructions, character_notes)
    token_count = count_tokens_text(full_prompt)
    max_prompt = llm_cfg.get('context_size', 4096) - llm_cfg.get('max_answer_tokens', 300)

    if token_count > max_prompt:
        while token_count > max_prompt and len(lines) > 2:
            lines.pop(0)
            full_prompt = build_prompt(system_block, lines, char_name, ooc_command, post_history_instructions, character_notes)
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