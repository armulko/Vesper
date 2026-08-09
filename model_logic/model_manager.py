import gc
import os
import subprocess
import threading
import time
import torch
import requests
from diffusers import StableDiffusionXLPipeline, EulerDiscreteScheduler
from settings import cfg, get_active_llm_cfg, get_active_sd_cfg

# BASE_DIR previously pointed at this file's own folder, correct back when
# model_manager.py lived in the project root (models/ was a direct
# sibling). Now that this file lives in model_logic/, os.path.dirname of
# __file__ points at model_logic/ itself — one level too deep. Going up one
# more level restores "project root" as BASE_DIR so MODELS_DIR still
# resolves to <root>/models regardless of which folder this module lives in.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(BASE_DIR, "models")

# Single source of truth for the KV-cache quantization type actually passed
# to llama-server.exe. model_autoconfig.autodetect_llm_cfg() takes this as
# an explicit parameter rather than hardcoding its own copy — if this ever
# changes (e.g. testing turbo4 or falling back to q8_0 for a
# quant-sensitive model), there's one line to edit, not two files that can
# silently drift out of sync.
LLM_KV_CACHE_TYPE = "turbo3"

llm_process = None
image_pipe = None
current_model_type = None
llm_lock = threading.Lock()

def get_llm(): return llm_process is not None
def get_image_pipe(): return image_pipe
def get_model_type(): return current_model_type

def get_vram_free_gb():
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        return info.free / (1024 ** 3)
    except Exception:
        return None

def get_file_size_gb(filename):
    path = os.path.join(MODELS_DIR, filename)
    if not os.path.exists(path):
        return None
    return os.path.getsize(path) / (1024 ** 3)

def check_vram_fit(filename):
    # Empty/None filename means there's nothing to load in the first place —
    # bail before touching pynvml. nvmlInit()/nvmlDeviceGetMemoryInfo() talk
    # to the GPU driver and aren't free; doing that just to immediately
    # discover there's no file to check against was the main source of the
    # "hangs for a bit, then errors out" delay in the no-model case.
    if not filename:
        return {'fits': True, 'free_gb': None, 'required_gb': None}
    free = get_vram_free_gb()
    size = get_file_size_gb(filename)
    if free is None or size is None:
        return {'fits': True, 'free_gb': None, 'required_gb': size}
    fits = free >= size
    return {'fits': fits, 'free_gb': round(free, 2), 'required_gb': round(size, 2)}

def load_llm():
    global llm_process, current_model_type
    if llm_process is not None:
        return
    filename = cfg("models", "selected_llm")
    if not filename:
        print("[Model Manager] ERROR: LLM model is not selected in settings.")
        return
    llm_cfg = get_active_llm_cfg()

    print(f"[Model Manager] Starting llama-server.exe for model: {filename}")
    
    llm_process = subprocess.Popen([
        os.path.join(BASE_DIR, "llama_server", "llama-server.exe"),
        "-m", os.path.join(MODELS_DIR, filename),
        "--ctx-size", str(llm_cfg.get("context_size", 4096)),
        "--n-gpu-layers", str(llm_cfg.get("gpu_layers", 0)),
        "--threads", str(llm_cfg.get("cpu_threads", 4)),
        "--batch-size", str(llm_cfg.get("batch_size", 128)),
        "--cache-type-k", LLM_KV_CACHE_TYPE,
        "--cache-type-v", LLM_KV_CACHE_TYPE,
        "--flash-attn", "on",
        "--parallel", "1",
        "--host", "127.0.0.1",
        "--port", "8080",
    ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    
    success = False
    max_attempts = 180
    url = f"{cfg('system', 'LLAMA_SERVER_URL')}/health"
    
    print(f"[Model Manager] Waiting for server readiness at {url}...")
    
    for attempt in range(1, max_attempts + 1):
        try:
            r = requests.get(url, timeout=1)
            
            if r.status_code == 200:
                success = True
                print(f"[Model Manager] SUCCESS: Server is fully ready on attempt {attempt}!")
                break
            elif r.status_code == 503:
                if attempt % 5 == 0:
                    print(f"[Model Manager] Server status (503): Model weights are still loading into memory...")
            else:
                if attempt % 5 == 0:
                    print(f"[Model Manager] Server returned unexpected status {r.status_code}, waiting...")
            
            time.sleep(1)
            
        except requests.exceptions.RequestException:
            if attempt % 10 == 0:
                print(f"[Model Manager] Attempt {attempt}/{max_attempts}: Port is still closed or server is busy initializing...")
            time.sleep(1)
            
    if success:
        current_model_type = "llm"
    else:
        print(f"[Model Manager] CRITICAL ERROR: Server did not respond within {max_attempts} seconds. Forcing process unload.")
        unload_llm()

def unload_llm():
    global llm_process, current_model_type
    if llm_process is not None:
        try:
            llm_process.terminate()
            try:
                llm_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                llm_process.kill()
                llm_process.wait()
        except Exception:
            pass
        llm_process = None
        time.sleep(0.5)
    current_model_type = None

def load_image_model():
    global image_pipe, current_model_type
    if image_pipe is not None:
        return
    filename = cfg("models", "selected_sd")
    if not filename:
        return
    try:
        image_pipe = StableDiffusionXLPipeline.from_single_file(
            os.path.join(MODELS_DIR, filename),
            torch_dtype=torch.float16,
            use_safetensors=True
        ).to("cuda")
        image_pipe.scheduler = EulerDiscreteScheduler.from_config(
            image_pipe.scheduler.config
        )
        current_model_type = "image"
    except Exception:
        unload_image_model()
        raise

def unload_image_model():
    global image_pipe, current_model_type
    if image_pipe is not None:
        # Just dropping the pipeline reference isn't enough to fully free
        # VRAM: SDXL pipelines keep several large submodules (unet, vae,
        # both text encoders) as attributes, and diffusers/PyTorch hook
        # graphs on those submodules can hold live references back into
        # the pipeline. A single gc.collect() doesn't reliably unwind that
        # in one pass.
        #
        # Explicitly dropping the biggest submodules first breaks those
        # references before gc has to untangle anything, then two
        # collect+empty_cache passes: the first frees the now-unreferenced
        # Python objects, the second reclaims whatever was orphaned as a
        # result of the first (a common pattern for diffusers pipelines).
        for attr in ("unet", "vae", "text_encoder", "text_encoder_2"):
            if hasattr(image_pipe, attr):
                try:
                    setattr(image_pipe, attr, None)
                except Exception:
                    pass
        image_pipe = None
        gc.collect()
        torch.cuda.empty_cache()
        gc.collect()
        torch.cuda.empty_cache()
    current_model_type = None

# def switch_to_llm(force=False):
#     with llm_lock:
#         filename = cfg("models", "selected_llm")
#         if not filename:
#             return {'success': False, 'error': 'LLM is not selected'}
#         vram = check_vram_fit(filename)
#         if not vram['fits'] and not force:
#             return {
#                 'success': False,
#                 'vram_warning': True,
#                 'free_gb': vram['free_gb'],
#                 'required_gb': vram['required_gb']
#             }
#         unload_image_model()
#         load_llm()
#         return {'success': True if current_model_type == "llm" else False, 'error': 'Failed to start model server'}

# def switch_to_image(force=False):
#     with llm_lock:
#         filename = cfg("models", "selected_sd")
#         if not filename:
#             return {'success': False, 'error': 'SD model is not selected'}
#         vram = check_vram_fit(filename)
#         if not vram['fits'] and not force:
#             return {
#                 'success': False,
#                 'vram_warning': True,
#                 'free_gb': vram['free_gb'],
#                 'required_gb': vram['required_gb']
#                 }
#         unload_llm()
#         load_image_model()
#         return {'success': True if current_model_type == "image" else False, 'error': 'Failed to load image model'}

def select_and_load_llm(filename, force=False):
    from settings import save, get_all
    if not filename:
        # Nothing to select — don't bother taking llm_lock or touching
        # VRAM/pynvml for a no-op switch to "no model".
        with llm_lock:
            unload_llm()
            s = get_all()
            s["models"]["selected_llm"] = None
            save(s)
        return {'success': True}
    with llm_lock:
        vram = check_vram_fit(filename)
        if not vram['fits'] and not force:
            return {
                'success': False,
                'vram_warning': True,
                'free_gb': vram['free_gb'],
                'required_gb': vram['required_gb']
            }
        unload_llm()
        s = get_all()
        s["models"]["selected_llm"] = filename
        save(s)
        load_llm()
        return {'success': True if current_model_type == "llm" else False}

def select_and_load_sd(filename, force=False):
    from settings import save, get_all
    if not filename:
        with llm_lock:
            unload_image_model()
            s = get_all()
            s["models"]["selected_sd"] = None
            save(s)
        return {'success': True}
    with llm_lock:
        vram = check_vram_fit(filename)
        if not vram['fits'] and not force:
            return {
                'success': False,
                'vram_warning': True,
                'free_gb': vram['free_gb'],
                'required_gb': vram['required_gb']
            }
        unload_image_model()
        s = get_all()
        s["models"]["selected_sd"] = filename
        save(s)
        load_image_model()
        return {'success': True if current_model_type == "image" else False}

def unload_llm_only():
    with llm_lock:
        unload_llm()

def unload_sd_only():
    with llm_lock:
        unload_image_model()