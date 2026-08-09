// chatDraft.js
// ─── Draft persistence (Telegram-style) ────────────────────────
// Stored server-side in the character record itself (vesper.draft),
// so it survives a page reload, a server restart, and follows the
// character rather than living only in this tab's memory.

let _draftSaveTimer = null;
let _draftDirty = false;

function _scheduleDraftSave() {
    _draftDirty = true;
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(_flushDraft, 500);
}

async function _flushDraft() {
    clearTimeout(_draftSaveTimer);
    if (!_draftDirty || !currentCharacter) return;
    const userInput = document.getElementById('userInput');
    const text = userInput ? userInput.value : '';
    _draftDirty = false;
    if (currentCharacter.vesper) currentCharacter.vesper.draft = text;
    try {
        await fetch(`${BASE_URL}/save_draft/${currentCharacter.vesper.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draft: text })
        });
    } catch (e) { console.error('Error saving draft:', e); }
}

function _clearDraft() {
    _draftDirty = false;
    clearTimeout(_draftSaveTimer);
    if (currentCharacter?.vesper) currentCharacter.vesper.draft = '';
    if (currentCharacter?.vesper?.id != null) {
        fetch(`${BASE_URL}/save_draft/${currentCharacter.vesper.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draft: '' })
        }).catch(() => {});
    }
}

function loadDraftIntoInput() {
    const userInput = document.getElementById('userInput');
    if (!userInput) return;
    const draft = currentCharacter?.vesper?.draft || '';
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
        if (!_draftDirty || !currentCharacter?.vesper?.id) return;
        const text = userInput ? userInput.value : '';
        try {
            navigator.sendBeacon(
                `${BASE_URL}/save_draft/${currentCharacter.vesper.id}`,
                new Blob([JSON.stringify({ draft: text })], { type: 'application/json' })
            );
        } catch (e) { /* best effort */ }
    });
});
