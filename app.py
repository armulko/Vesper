import warnings
warnings.filterwarnings("ignore", message=".*pynvml package is deprecated.*", category=FutureWarning)

from flask import Flask, render_template
from flask_cors import CORS
import threading

from model_logic.model_manager import load_llm, load_image_model
from settings import get_all
from routes.chat import chat_bp
from routes.characters import characters_bp
from routes.personas import personas_bp
from routes.models import models_bp
from routes.image import image_bp
from routes.system import system_bp, start_inactivity_watchdog
from routes.settings import settings_bp
from routes.default_avatars import default_avatars_bp
from routes.data_files import data_files_bp
from routes.forks import forks_bp
from routes.chats import chats_bp
from routes.lorebooks import lorebooks_bp

app = Flask(__name__)
CORS(app)

app.register_blueprint(chat_bp)
app.register_blueprint(characters_bp)
app.register_blueprint(personas_bp)
app.register_blueprint(models_bp)
app.register_blueprint(image_bp)
app.register_blueprint(system_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(default_avatars_bp)
app.register_blueprint(data_files_bp)
app.register_blueprint(forks_bp)
app.register_blueprint(chats_bp)
app.register_blueprint(lorebooks_bp)

@app.route('/')
def home():
    return render_template('index.html')

if __name__ == '__main__':
    # load_llm()/load_image_model() already bail instantly when nothing's
    # selected, but spinning up a thread (and joining it) still costs real
    # time even for a function that returns immediately. Checking settings
    # here first and skipping thread creation entirely when there's nothing
    # to load avoids paying that overhead twice for a no-op startup.
    s = get_all()
    selected_llm = s.get("models", {}).get("selected_llm")
    selected_sd = s.get("models", {}).get("selected_sd")

    threads = []
    if selected_llm:
        threads.append(threading.Thread(target=load_llm))
    if selected_sd:
        threads.append(threading.Thread(target=load_image_model))

    for t in threads:
        t.start()
    for t in threads:
        t.join()

    start_inactivity_watchdog()
    app.run(host='0.0.0.0', port=5000, threaded=True)