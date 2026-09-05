// chatNotes.js
// Notes переехали с уровня персонажа на уровень чата (см. обсуждение —
// "отдельные на каждый чат"). loadCharacterNotes теперь принимает chatId,
// не characterId — имя функции оставлено как есть (переименование по всем
// вызовам — риск больше, чем несоответствие имени), но параметр и роут
// теперь чётко про чат.

async function loadCharacterNotes(chatId) {
    try {
        const r = await fetch(`${BASE_URL}/get_notes/${chatId}`);
        const data = await r.json();
        _characterNotes = data.notes || '';
    } catch(e) {
        _characterNotes = '';
    }
    const ta = document.getElementById('characterNotesInput');
    if (ta) {
        ta.value = _characterNotes;
        ta.classList.remove('notes-unsaved', 'notes-saved');
    }
}

async function saveCharacterNotes() {
    if (!currentChatId) return;
    const ta = document.getElementById('characterNotesInput');
    _characterNotes = ta ? ta.value : _characterNotes;
    await fetch(`${BASE_URL}/save_notes/${currentChatId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: _characterNotes })
    });
    if (ta) {
        ta.classList.remove('notes-unsaved');
        ta.classList.add('notes-saved');
        setTimeout(() => ta.classList.remove('notes-saved'), 1500);
    }
}


function toggleNotesPanel() {
    const panel = document.getElementById('notesPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
        document.getElementById('characterNotesInput').focus();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('characterNotesInput');
    if (ta) {
        ta.addEventListener('input', () => {
            ta.classList.add('notes-unsaved');
            ta.classList.remove('notes-saved');
        });
        ta.addEventListener('blur', () => {
            if (ta.classList.contains('notes-unsaved')) saveCharacterNotes();
        });
    }
});