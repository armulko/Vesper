// app.js
// App bootstrap: global DOM refs, app state persistence, token bar,
// view restoration guard, and the DOMContentLoaded init sequence.
// Split out of main.js (2nd great refactoring) — load this LAST,
// same position main.js used to occupy in index.html.

const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');

function saveAppState() {
    fetch(`${BASE_URL}/save_state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            currentCharacterId: currentCharacter ? currentCharacter.id : null,
            currentPersonaId: currentPersona ? currentPersona.id : null,
            currentView: currentView
        })
    }).catch(error => console.error('Error saving state:', error));
}

async function updateTokenCount() {
    if (!currentCharacter) return;
    const counter = document.getElementById('tokenCounter');
    if (!counter) return;

    let systemPrompt = `You are ${currentCharacter.name}.`;
    if (currentCharacter.description) systemPrompt += ` ${currentCharacter.description}`;
    if (currentPersona) {
        const personaName = currentPersona.name || 'User';
        systemPrompt += `\n\nYou are talking with ${personaName}.`;
        if (currentPersona.description) systemPrompt += ` ${currentPersona.description}`;
    }

    const characterName = currentCharacter.name;
    const personaName = currentPersona ? currentPersona.name : 'User';

    let historyText = '';
    chatHistory
        .filter(msg => !msg.isArchived)
        .forEach(msg => {
            historyText += `${msg.isUser ? personaName : characterName}: ${msg.text}\n`;
        });

    const attempt = async (retriesLeft) => {
        try {
            const modelRes = await fetch(`${BASE_URL}/get_model_type`);
            const modelData = await modelRes.json();

            if (modelData.model_type !== 'llm' && retriesLeft > 0) {
                setTimeout(() => attempt(retriesLeft - 1), 2000);
                return;
            }

            const [tokenRes, configRes] = await Promise.all([
            fetch(`${BASE_URL}/count_tokens`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: historyText,
                    char_name: characterName,
                    user_name: personaName,
                    system_prompt: systemPrompt + (_characterNotes ? `\n\n[PERSISTENT NOTES — FOLLOW AS ABSOLUTE RULES, NO EXCEPTIONS]:\n${_characterNotes}` : '')
                })
            }),
                fetch(`${BASE_URL}/get_config`)
            ]);

            const tokenData = await tokenRes.json();
            const configData = await configRes.json();

            const count = tokenData.count;
            const max = configData.context_size;

            const percent = count / max;
            const fill = document.getElementById('tokenFill');
            const countText = document.getElementById('tokenCountText');

            counter.style.display = 'flex';
            counter.className = 'token-counter-bar' +
                (percent > 0.9 ? ' danger' : percent > 0.7 ? ' warn' : '');

            if (fill) fill.style.width = `${Math.min(percent * 100, 100)}%`;
            if (countText) countText.textContent = `${count} / ${max}`;
        } catch {
            counter.style.display = 'none';
        }
    };

    attempt(5);
}



// Inactivity shutdown now lives server-side (routes/system.py watchdog) —
// it survives a closed tab / throttled background browser, unlike a JS timer.

// Views that only exist as destinations in the mobile bottom-nav flow —
// there's no desktop entry point back out of them (no matching nav-btn on
// desktop, no sidebar tab targets them directly). If one of these gets
// restored as currentView on a desktop viewport (e.g. state was saved
// during a phone session and the same account is then opened on a PC),
// the user lands on a screen with no way to navigate away from it, since
// the bottom nav that would normally let them tap back to Chat isn't
// there. Guarded at the restore call sites below rather than inside
// switchView itself — switchView is also the normal, legitimate way to
// *reach* these views while actually on mobile, and shouldn't refuse that.
const MOBILE_ONLY_VIEWS = ['load', 'loadPersona'];

function _sanitizeRestoredView(view) {
    const isDesktop = window.matchMedia('(min-width: 768px)').matches;
    if (isDesktop && MOBILE_ONLY_VIEWS.includes(view)) {
        return 'chat';
    }
    return view;
}

// ─── Initialization ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    loadCurrentModel();
    loadModelManager();

    fetch(`${BASE_URL}/get_state`)
    .then(r => r.json())
    .then(state => {
        const safeView = _sanitizeRestoredView(state.currentView);
        if (safeView && safeView !== 'chat') {
            switchView(safeView);
        }
        if (state.currentPersonaId) {
            return fetch(`${BASE_URL}/get_personas`)
                .then(r => r.json())
                .then(personas => {
                    const persona = personas.find(p => p.id === state.currentPersonaId);
                    if (persona) currentPersona = persona;
                    return state;
                });
        }
        return state;
        })
        .then(state => {
            if (state.currentCharacterId) {
                const savedView = _sanitizeRestoredView(state.currentView) || 'chat';
                loadCharacter(state.currentCharacterId, savedView);
            } else {
                document.getElementById('chatEmptyState').innerHTML = `
                    <div style="font-size: 2rem; opacity: 0.6">◈</div>
                    <div>Персонаж не выбран</div>
                    <div style="font-size: 2rem; opacity: 0.6">◈</div>
                `;
            }
        });
});

const _LLM_DEFAULTS = {
    context_size: 4096,
    max_answer_tokens: 300,
    gpu_layers: -1,
    cpu_threads: 4,
    batch_size: 128,
    generation_timeout: 60,
    lock_acquire_timeout: 30,
    tokenize_timeout: 10,
    summarize_n_predict: 2000,
    summarize_temperature: 0.3,
    chat_template: {
        prompt_template: '{system_start}{system}{system_end}{inst_start}{instruction}{inst_end}{char_name}:',
        system_start: '[SYSTEM_PROMPT]',
        system_end: '[/SYSTEM_PROMPT]',
        inst_start: '[INST]',
        inst_end: '[/INST]',
        stop_tokens: ['[INST]', '[/INST]', '[SYSTEM_PROMPT]', '</s>']
    }
};

const _SD_DEFAULTS = {
    image_height: 1024,
    image_width: 1024,
    guidance_scale: 7.5,
    avatar_steps: 30,
    avatar_base_prompt: 'photorealistic, ultra realistic, solo, highly detailed, natural lighting, sharp focus',
    avatar_portrait_prompt: 'upper body, detailed face',
    avatar_fullbody_prompt: 'full body, standing on ground, detailed outfit, detailed face'
};


let _modelConfigFilename = null;
let _modelConfigPendingSwitch = null;