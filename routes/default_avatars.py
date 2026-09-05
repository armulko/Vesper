# default_avatars.py
#
# Shared fallback-avatar logic for both characters and personas.
# A small fixed pool of generic SVGs lives in data/avatars/default/
# (currently 1.svg .. 5.svg). Every character/persona gets ONE of them
# assigned at random the first time it's saved and that assignment is
# permanent — written into the record as `default_avatar` (just the
# filename, e.g. "3.svg") and never reassigned afterwards, so the same
# entity always shows the same default art even after a real avatar is
# uploaded, removed, or fails to upload.
#
# This is a "just in case" fallback: has_avatar=False, or has_avatar=True
# but the file on disk is somehow missing/corrupt, or the frontend hasn't
# loaded the real image yet — the UI can always fall back to
# /default_avatar/<filename> and get *something*, and it'll be the same
# something every time for that id.

import os
import random
from flask import Blueprint, send_file, jsonify

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
DEFAULT_AVATARS_DIR = os.path.join(DATA_DIR, 'avatars', 'default')

default_avatars_bp = Blueprint('default_avatars', __name__)

_cache = None  # list of filenames, populated lazily; small dir, no need to re-scan every call


def _list_default_avatars():
    global _cache
    if _cache is not None:
        return _cache
    try:
        files = sorted(
            f for f in os.listdir(DEFAULT_AVATARS_DIR)
            if f.lower().endswith('.svg')
        )
    except FileNotFoundError:
        files = []
    _cache = files
    return _cache


def pick_random_default_avatar():
    """Returns a filename like '3.svg', or None if the pool is empty
    (e.g. directory missing) — callers should treat None as 'no default
    available' and degrade gracefully rather than crash."""
    files = _list_default_avatars()
    if not files:
        return None
    return random.choice(files)


# ensure_default_avatar() removed — it existed to mutate a nested `vesper`
# dict in place before writing it back to characters.json. Now that
# characters/personas live as flat DB rows, there's no dict to mutate:
# callers (routes/characters.py, routes/personas.py) call
# pick_random_default_avatar() directly and put the result straight into
# the INSERT. Same "assigned once, never reassigned on UPDATE" contract —
# it's just enforced by the callers only ever setting default_avatar on
# INSERT and never touching it in an UPDATE statement, instead of by an
# idempotency check inside this function.


def get_default_avatar_path(filename):
    """Resolves a filename to a safe absolute path inside DEFAULT_AVATARS_DIR.
    Rejects path traversal — filename comes from data on disk we control,
    but the HTTP route also accepts it directly from the URL, so treat it
    as untrusted there."""
    safe_name = os.path.basename(filename)
    if not safe_name.lower().endswith('.svg'):
        return None
    path = os.path.join(DEFAULT_AVATARS_DIR, safe_name)
    if not os.path.abspath(path).startswith(os.path.abspath(DEFAULT_AVATARS_DIR)):
        return None
    return path


@default_avatars_bp.route('/default_avatar/<filename>', methods=['GET'])
def default_avatar(filename):
    path = get_default_avatar_path(filename)
    if path and os.path.exists(path):
        return send_file(path, mimetype='image/svg+xml')
    return '', 404


@default_avatars_bp.route('/list_default_avatars', methods=['GET'])
def list_default_avatars():
    """Lets the frontend pick a default avatar client-side (e.g. to preview
    one in the create-character/persona form before anything is saved),
    without hardcoding filenames or a count in JS. Reads the same cached
    list used for server-side random assignment, so the two stay in sync."""
    return jsonify(_list_default_avatars())