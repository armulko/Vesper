"""
Serves static-but-not-in-static-folder files from the project's /data
directory (e.g. keyboard_layouts.json for layoutFix.js). Same pattern as
routes/default_avatars.py — /data holds mixed generated/config JSON
(settings.json, model_layer_cache.json, etc.), not meant to live under
static/, but a few of its files need to be fetchable by the frontend.

Deliberately whitelist-based rather than a blanket send_from_directory on
the whole folder: /data also holds settings.json and other files that
shouldn't be openly fetchable by anything running in the page.
"""
import os
from flask import Blueprint, send_from_directory, abort

data_files_bp = Blueprint('data_files', __name__)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

# Only these filenames are servable via /data/<filename> — add here as
# needed, don't open the whole directory up.
ALLOWED_FILES = {
    'keyboard_layouts.json',
}


@data_files_bp.route('/data/<path:filename>')
def serve_data_file(filename):
    if filename not in ALLOWED_FILES:
        abort(404)
    return send_from_directory(DATA_DIR, filename)