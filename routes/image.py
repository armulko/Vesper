import json
import base64
import threading
import time
from io import BytesIO
from queue import Queue, Empty
from flask import Blueprint, request, jsonify, Response, stream_with_context
from model_logic.model_manager import get_image_pipe, get_model_type
from settings import cfg, get_active_sd_cfg

image_bp = Blueprint('image', __name__)
image_lock = threading.Lock() 

def _stream_generation(prompt, steps, guidance=3.5):
    def generate():
        step_queue = Queue() 
        result_container = {}
        generation_error = [None]
        generation_done = threading.Event()

        def step_callback(pipe, step, timestep, kwargs):
            step_queue.put(json.dumps({
                'type': 'progress',
                'step': step + 1,
                'total': steps
            }))
            return kwargs

        def run_generation():
            with image_lock:
                try:
                    image_pipe = get_image_pipe()
                    image = image_pipe(
                        prompt=prompt,
                        num_inference_steps=steps,
                        guidance_scale=guidance,
                        height=get_active_sd_cfg().get('image_height', 1024),
                        width=get_active_sd_cfg().get('image_width', 1024),
                        callback_on_step_end=step_callback
                    ).images[0]
                    buffered = BytesIO()
                    image.save(buffered, format="PNG")
                    img_base64 = base64.b64encode(buffered.getvalue()).decode()
                    result_container['image'] = f'data:image/png;base64,{img_base64}'
                except Exception as e:
                    generation_error[0] = str(e)
                finally:
                    generation_done.set()

        threading.Thread(target=run_generation).start()

        while not generation_done.is_set():
            while not step_queue.empty():
                try:
                    yield f"data: {step_queue.get_nowait()}\n\n"
                except Empty:
                    break
            time.sleep(0.05)

        while not step_queue.empty():
            try:
                yield f"data: {step_queue.get_nowait()}\n\n"
            except Empty:
                break

        if generation_error[0]:
            yield f"data: {json.dumps({'type': 'error', 'error': generation_error[0]})}\n\n"
        else:
            yield f"data: {json.dumps({'type': 'done', 'image': result_container['image']})}\n\n"

    return generate

@image_bp.route('/generate_avatar', methods=['POST'])
def generate_avatar():
    if get_model_type() != "image":
        return jsonify({'error': 'Image model not loaded'}), 400
    if get_image_pipe() is None:
        return jsonify({'error': 'Model not initialized'}), 500
    try:
        data = request.json
        user_prompt = data.get('prompt', '').strip()
        photo_type = data.get('type', 'portrait')
        sd_cfg = get_active_sd_cfg()
        type_prompt = sd_cfg.get('avatar_portrait_prompt', '') if photo_type == 'portrait' else sd_cfg.get('avatar_fullbody_prompt', '')
        final_prompt = f"{sd_cfg.get('avatar_base_prompt', '')}, {type_prompt}, {user_prompt}"
        return Response(stream_with_context(_stream_generation(final_prompt, sd_cfg.get('avatar_steps', 30))()), mimetype='text/event-stream')
    except Exception as e:
        return Response(f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n", mimetype='text/event-stream')

@image_bp.route('/generate_image', methods=['POST'])
def generate_image():
    if get_model_type() != "image":
        return jsonify({'error': 'Image model not loaded'}), 400
    if get_image_pipe() is None:
        return jsonify({'error': 'Model not initialized'}), 500
    try:
        data = request.json
        user_prompt = data.get('prompt', '').strip()
        steps = max(1, min(60, int(data.get('steps', 20))))
        return Response(stream_with_context(_stream_generation(user_prompt, steps)()), mimetype='text/event-stream')
    except Exception as e:
        return Response(f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n", mimetype='text/event-stream')