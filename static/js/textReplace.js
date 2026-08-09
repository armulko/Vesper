// textReplace.js
// Find/replace pairs for the standalone text-replace view.
// Split out of main.js (2nd great refactoring).

function addReplacePair() {
    const container = document.getElementById('replacePairs');
    const row = document.createElement('div');

    row.className = 'replace-row';

    row.innerHTML = `
        <input class="form-input replace-input" placeholder="What">
        <input class="form-input replace-input" placeholder="On what">
        <button class="action-btn delete-btn replace-delete-btn">
            <img src="/static/icons/trash.svg" alt="delete">
        </button>
    `;

    row.querySelector('.replace-delete-btn').onclick = () => row.remove();

    container.appendChild(row);
}

function applyReplace() {
    let text = document.getElementById('replaceInput').value;
    const rows = document.querySelectorAll('.replace-row');
    rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        const from = inputs[0].value;
        const to = inputs[1].value;
        if (!from) return;
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`\\{?\\{?${escaped}\\}?\\}?`, 'g'), to);
    });
    document.getElementById('replaceOutput').value = text;
}

// ─── Events ────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);

stopBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
});

userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
        e.preventDefault();
        sendMessage();
    }
});

userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    const maxHeight = parseFloat(getComputedStyle(userInput).maxHeight);
    const newHeight = Math.min(userInput.scrollHeight, maxHeight);
    userInput.style.height = newHeight + 'px';
    userInput.style.overflowY = newHeight >= maxHeight ? 'auto' : 'hidden';
});

