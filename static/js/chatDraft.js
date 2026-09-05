// chatDraft.js
// ─── Draft persistence (Telegram-style) ────────────────────────
// Stored server-side in the character record itself (character.draft —
// flat field now, was vesper.draft under the old nested JSON shape),
// so it survives a page reload, a server restart, and follows the
// character rather than living only in this tab's memory.

let _draftSaveTimer = null;
let _draftDirty = false;
// Tracks which character the pending draft actually belongs to. Without
// this, a fast character A -> character B switch within the 500ms debounce
// window would flush character A's leftover text under character B's id
// (_flushDraft reads currentCharacter at flush time, not schedule time).
let _draftOwnerId = null;

function _scheduleDraftSave() {
    _draftDirty = true;
    _draftOwnerId = currentCharacter?.id ?? null;
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(_flushDraft, 500);
}

async function _flushDraft() {
    clearTimeout(_draftSaveTimer);
    if (!_draftDirty || _draftOwnerId == null) return;
    const userInput = document.getElementById('userInput');
    const text = userInput ? userInput.value : '';
    const ownerId = _draftOwnerId;
    _draftDirty = false;
    _draftOwnerId = null;
    // Only touch currentCharacter.draft in-memory if it's still the
    // same character — otherwise this would write into whichever character
    // the user has since switched to.
    if (currentCharacter?.id === ownerId) {
        currentCharacter.draft = text;
    }
    try {
        await fetch(`${BASE_URL}/save_draft/${ownerId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draft: text })
        });
    } catch (e) { console.error('Error saving draft:', e); }
}

function _clearDraft() {
    _draftDirty = false;
    _draftOwnerId = null;
    clearTimeout(_draftSaveTimer);
    if (currentCharacter) currentCharacter.draft = '';
    if (currentCharacter?.id != null) {
        fetch(`${BASE_URL}/save_draft/${currentCharacter.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draft: '' })
        }).catch(() => {});
    }
}

function loadDraftIntoInput() {
    const userInput = document.getElementById('userInput');
    if (!userInput) return;
    const draft = currentCharacter?.draft || '';
    userInput.value = draft;
    userInput.style.height = 'auto';
    if (draft) {
        const maxHeight = parseFloat(getComputedStyle(userInput).maxHeight);
        const newHeight = Math.min(userInput.scrollHeight, maxHeight);
        userInput.style.height = newHeight + 'px';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const userInput = document.getElementById('userInput');
    if (userInput) {
        userInput.addEventListener('input', _scheduleDraftSave);
    }
    // Flush on tab close / refresh — beforeunload can't await fetch, so
    // fire a best-effort keepalive request that survives page teardown.
    window.addEventListener('beforeunload', () => {
        if (!_draftDirty || _draftOwnerId == null) return;
        const text = userInput ? userInput.value : '';
        try {
            navigator.sendBeacon(
                `${BASE_URL}/save_draft/${_draftOwnerId}`,
                new Blob([JSON.stringify({ draft: text })], { type: 'application/json' })
            );
        } catch (e) { /* best effort */ }
    });
});