# Vesper — Project Structure

## Project Philosophy

1. **No censorship or restrictions.** User controls models, prompts, content — no platform filters.
2. **Full offline independence.** Everything runs locally, zero network dependency at runtime — even fonts are vendored, not pulled from a CDN. Nothing phones home.
3. **Universality and accessibility.** Clean UI with auto-configuration for non-experts (`model_autoconfig.py` parses GGUF metadata) — sensible defaults with no manual tuning required out of the box. Runs anywhere with the right libs + `llama.cpp`, English UI, adaptive layouts. Puts 8GB and 30+GB VRAM users on equal footing usability-wise. Manual override (fixed `gpu_layers`, custom VRAM reserve) planned for power users on top of the same autodetect path — see Layer-Fitting Algorithm below.

## High-level Architecture

Hybrid: lightweight Flask backend coordinates UI/state, orchestrates heavy AI models with independent lifecycles.

### 1. System Components

- **Client (Browser/SPA):** Pure JS (`state.js`, `chat.js`, `ui.js`, etc). Manages UI state, renders DOM, consumes SSE streams. Talks to backend via Fetch + SSE.
- **Server (Flask):** Entry `app.py`, routes in `routes/` (incl. `routes/default_avatars.py`), coordinator `model_manager.py`. Acts as API gateway, reads/writes character/chat JSON, controls AI model lifecycle, manages OS processes + CUDA context.
- **AI Model Layer (isolated VRAM):**
  - *Text (LLM):* separate child process `llama-server.exe`, default `127.0.0.1:8080`, but address is configurable via `LLAMA_SERVER_URL` (`system` section of `data/settings.json`, editable from settings UI) — not hardcoded, doesn't have to be local.
  - *Image:* SDXL pipeline loaded directly into CUDA via PyTorch/`diffusers`.

### 2. Independent Model Lifecycles (LLM ↔ Image)

Fully independent processes — selecting/unloading one never touches the other. No shared "mode switch."

- **Selecting an LLM** (`select_and_load_llm`): if a different LLM is running, `unload_llm()` kills the old process first → new filename saved to settings → `load_llm()` spawns fresh `llama-server.exe` with config's context/layer params, polls `/health`. Image pipeline untouched throughout.
- **Selecting SD** (`select_and_load_sd`): mirrors the above for `image_pipe`, doesn't touch `llm_process`.
- **Manual unload without replacement:** `unload_llm_only()` / `unload_sd_only()` free VRAM from one model without loading a replacement.
- Both models **can be resident in VRAM simultaneously** if user selects both — deliberate, not a special "dual mode."
- **Startup loading** (`app.py`): checks settings first, spawns a loader thread only for slots with a filename selected (unselected slots skip thread creation entirely). Threads joined before Flask starts serving — both models ready immediately post-startup. Startup time = max(LLM load, SD load), not sum. No VRAM pre-check here (unlike `/select_model`'s `check_vram_fit`) — mismatched model sizes can OOM on launch instead of failing gracefully.

### 3. Request Flow (message → response)

1. **Initiation:** user clicks send in `chat.js` → input disabled, local message added to DOM, POST to `/chat`.
2. **Routing:** `routes/chat.py` substitutes `{{char}}`/`{{user}}` placeholders, acquires thread-safe `llm_lock`.
3. **Proxying:** Flask streams request to `llama-server.exe`'s `/completion`, using `LLAMA_SERVER_URL` from settings.
4. **Streaming (backend):** tokens forwarded to client as SSE (`text/event-stream`).
5. **Rendering (client):** `renderStreamChunk()` in `chat.js` intercepts each token; char-by-char parser checks for italic markers (`*`) and OOC commands (`/cmd`), prevents HTML tags breaking mid-token. `appendTextNode()` collapses runs of blank lines live via a `lastWasBr` flag, so multiple empty lines never render even mid-stream.
6. **Completion:** on `done` flag, `llm_lock` released. Text run through `normalizeStreamedText()` (trim + collapse `\n{2,}` → `\n`) before being saved to `histories/<id>.json` — clean, not raw. Token counter updates, UI unlocks.

### 4. Frontend Model-State Flags

`state.js` tracks two independent booleans — `isLlmLoaded`, `isSdLoaded` — from `/get_model_type`'s `llm_loaded`/`sd_loaded` fields. Replaces an old single `currentModelType` enum (`'llm'|'image'|null`) that could only reflect whichever model loaded *last*, hiding the other from the UI once both became loadable. `chat.py`'s route guards fixed the same way — check `get_llm()` directly instead of comparing a shared mode string. Legacy `model_type` field still returned by the endpoint but unused by the client.

---

## Key Design Decisions

### 1. `llama-server.exe` over Python bindings (llama-cpp-python)
- **Process isolation:** if the model crashes (context error, OOM), Flask server stays alive, handles it gracefully in UI, can restart the process.
- **No GIL bottlenecks:** Python bindings hard-lock the GIL during inference, blocking parallel background work (token counting, status checks).
- **Easier Windows distribution:** official pre-compiled binary is stable, no build environment (VS Build Tools, CUDA Toolkit) needed on install.

### 2. Single HTML + SPA over heavy frameworks
- **Zero-compile:** no node_modules/Webpack/Vite. Runs straight from Flask `templates/`.
- **Low overhead:** vanilla JS keeps browser RAM low; state syncs to disk via targeted fetches.

### 3. VRAM Management Strategy (independent, user-controlled)
- Original design was strict single-model-at-a-time (hard toggle via chat-view switch). That toggle and its functions (`switch_to_llm`/`switch_to_image`) are dead code — commented out in `model_manager.py`, not deleted, superseded by `select_and_load_llm`/`select_and_load_sd`.
- **Current:** LLM and image model load/unload independently — user can have both, one, or neither in VRAM.
- `check_vram_fit()` checks free VRAM vs model file size before load; rejects (`success: False`, `vram_warning: True`) unless `force=True` passed — blocking guard with opt-in override, not a passive warning.
- `torch.cuda.empty_cache()` guarantees PyTorch returns VRAM to the OS immediately after pipeline deallocation, freeing space for `llama-server` layers.

### 3.5. Layer-Fitting Algorithm (`model_logic/layer_weights.py`, `layer_weight_cache.py`)
Decides `gpu_layers` for `autodetect_llm_cfg()` — how many of the model's transformer blocks to offload to GPU, matching how `llama-server.exe`'s `--n-gpu-layers` actually works (offloads the **first N** blocks sequentially, not an arbitrary subset — this is prefix-sum greedy fitting, not a knapsack problem).

- **`layer_weights.py`** — reads only the GGUF header + tensor directory (mmap'd, no weight data touched) via `parse_layer_weights()`. Buckets tensors into per-layer bytes (`blk.<N>.*`, regex-matched, architecture-agnostic — works on any llama.cpp-convention GGUF, not hardcoded per model family) and `non_layer_bytes` (embeddings/output head/norms — always resident, can't be selectively offloaded).
- **`best_fit_layers_for_target(info, vram_free_bytes, target_free_bytes)`** — greedily takes layers while remaining VRAM stays ≥ `target_free_bytes` (the reserve/floor), stops the instant the next layer would breach it. `target_free_bytes` is a **hard floor, not an aim-for-but-may-overshoot target** — an earlier version compared the two layer-count candidates straddling the floor and could pick whichever was numerically closer even if that dipped under the floor; that behavior was removed. Floor guarantee holds only relative to the layers the function itself chooses — if VRAM is already under the floor before any layer is taken (e.g. KV-cache alone ate past it), it correctly returns 0 layers but leftover is still under floor; `autodetect_llm_cfg()` flags this explicitly (`vram_insufficient_for_<X>gb_floor_even_before_layers` warning) rather than letting it look like a silent miscalculation.
- **Default reserve: 1GB** (`target_free_vram_gb` in `model_autoconfig.py`, both the tensor-directory path and the linear-estimate fallback below). Covers driver/runtime allocations, other apps, general OOM safety margin — not currently user-configurable, see Known Issues.
- **Fallback:** if tensor-directory parsing fails (corrupt file, exotic format), `autodetect_llm_cfg()` falls back to a linear estimate (`file_size / n_layer`, assumes uniform layer size) rather than leaving `gpu_layers` at `-1` (load everything) and risking an uncontrolled OOM.
- **`layer_weight_cache.py`** — wraps `parse_layer_weights()` with a `data/model_layer_cache.json` cache keyed by absolute path, invalidated on `(size, mtime)` mismatch (file replaced/updated → re-parse). Kept separate from `model_configs.json` deliberately — that file is user-editable generation settings, this one is derived/computed data with a different invalidation trigger (mixing them risks a manual settings edit sitting next to stale parse data or vice versa).

### 4. Network Access Modes (`state.js`, `BASE_URL`)
Frontend must handle three host/port shapes:
- **Local** (`localhost`/`127.0.0.1`) — backend always on port `5000`.
- **LAN** (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`) — e.g. phone over Wi-Fi, still directly port `5000`, no proxy.
- **Tunneled** (ngrok/similar https reverse proxy) — page served https on ngrok's domain, no port visible to browser. Hardcoding `:5000` or `http://` here trips the browser's mixed-content block (https page can't request plain http, port or no port).

`BASE_URL` is computed once at load, testing `window.location.hostname` against a regex covering localhost/127.0.0.1/private LAN ranges:
```js
const _isLan = /^(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(window.location.hostname);
const BASE_URL = _isLan
    ? `${window.location.protocol}//${window.location.hostname}:5000`
    : `${window.location.protocol}//${window.location.hostname}`;
```
Every fetch across the frontend (`chat.js` + siblings, `characters.js`, `personas.js`, `imageGen.js`, `modelManager.js`, `app.js`) goes through `${BASE_URL}/...`. Previously inconsistent (some hardcoded scheme/port), which worked locally but silently broke tunneled mode (browser rejected fetches client-side — no trace in Flask logs, only browser console mixed-content errors). Now migrated to one constant, one place decides scheme/port.

---

## Backend and Launch Infrastructure

### `run_code.bat`
Windows startup script with fault tolerance / soft restart.
- Checks `python` is on `PATH`.
- Launches `app.py`.
- **Infinite restart loop** (`:start ... goto start`): when an API restart command terminates Flask (SIGTERM), the batch pauses 3s (`timeout /t 3`) and spins the app back up automatically.

### HTML Partials
Split into `_modals.html`, `_navigation.html`, `_chat.html`, `_forms.html`, `_tools.html`, `_icons.html`. `_icons_and_modals.html` and `_chat_and_tools.html` were split further once the "and" in the filename made clear each was doing two jobs. Splitting caught two real bugs a naive copy-paste would've carried forward: a duplicated `<body>` tag left in the merged partial after `<body>` was correctly moved to the skeleton, and a dropped closing `</div>` on `#modelConfigModal` (would've let its markup leak outside its wrapper). Caught by diffing `<div>`/`</div>` counts per partial vs the pre-split original — the whole file's count was balanced, but that doesn't guarantee any given slice is.

**Main structural elements:**
1. **Global overlays/modals** (`_modals.html`): `#overlay` (darkens background on mobile sidebar open), `#confirmModal` (destructive-action confirmation), `#customAlertModal` (errors/notifications).
2. **Sidebar** (`_navigation.html`): switchable character/persona lists (`#sidebarCharactersList`/`#sidebarPersonasList`), quick-create buttons.
3. **Main content:**
   - `#chatView` (`_chat.html`): dialogue window, context token counter, collapsible notes panel, Suggest button, char-limited input.
   - `#charEditView`/`#personaEditView` (`_forms.html`): metadata config screens (name, system prompt, greeting), avatar upload with instant preview.
   - `#imageGenView` (`_tools.html`): SD interface — gallery, aspect ratio, sampling steps slider.
   - `#modelSwitchView` (`_tools.html`): LLM sampling params (Temp/Top K/Top P/Min P/Penalty), model file paths, theme toggle, restart/shutdown.
4. **Bottom nav** (mobile, `_navigation.html`): docked panel for Chat/Characters/Personas/Image/Settings. Highlighting fully driven by `switchView()` in `ui.js` keyed off `data-view` — no separate `setActiveNav` handler anymore (old inline `switchView(...); setActiveNav(this)` only updated on manual click, left the nav stale after programmatic navigation like state restore or chained model-switch confirm). `switchView` now toggles `.nav-btn.active` itself.
5. **Desktop-only nav** (`.desktop-only`): `.view-back-btn` and chat header's model-settings shortcut, hidden below 767px. Exist because mobile has bottom-nav for the same purpose; desktop sidebar tabs make them redundant there. `justify-content: space-between` on `.view-header` keeps the title position stable when the back button is hidden.

**Script loading order** (strict, avoids init errors):
1. `bgPattern.js` — decorative background SVG, self-contained, loads first.
2. `state.js` — state management (chat IDs, active views).
3. `ui.js` — animations, sidebars, custom alerts.
4. `layoutFix.js` — keyboard-layout-aware search correction; see [Keyboard Layout Search Correction](#keyboard-layout-search-correction-staticjslayoutfixjs). Must load before `characters.js`/`personas.js` — both call `_getLayoutVariants` from inside their fuzzy-search filters.
5. `characters.js` — CRUD + caching for AI characters.
6. `personas.js` — CRUD for user personas.
7. `imageGen.js` — streaming image gen + gallery.
8. `chat.js` — message dispatch, streaming, token counting (core only, post-2nd-refactor).
9. `chatSummary.js` — summarization: per-message, meta-summarize, browser modal, unarchive. Split from `chat.js`.
10. `chatNotes.js` — character notes panel. Split from `chat.js`.
11. `chatDraft.js` — Telegram-style draft persistence. Split from `chat.js`.
12. `scrollBounce.js` — rubber-band overscroll, loaded after chat.js family (needs `#chatMessagesInner`).
13. `modelManager.js` — model loading/switching UI + per-model config modal. Split from old `main.js`.
14. `textReplace.js` — find/replace view. Split from old `main.js`.
14. `tokenCounter.js` — character-form token counters (exact via `/count_field_tokens`, debounced, length/4 fallback). Split from an inline `<script>` in `index.html`.
15. `settings.js` — syncs param form with `data/settings.json`; owns `shutdownPC()`.
16. `app.js` — orchestrator: global DOM refs, `saveAppState`, token bar, view-restoration guard, `DOMContentLoaded` init. What's left of old `main.js`, kept "load last" position.

**2nd great refactoring:** `main.js` (700 lines) and `chat.js` (1200+ lines) had become dumping grounds, split by domain into files above. Two quirks moved worth noting: the `paste` listener (routes clipboard images to avatar generator) and `suggestBtn` click listener both moved from `main.js` into the tail of `chat.js` (chat-input-adjacent, not bootstrap).

**Known regression (unresolved, deprioritized):** since the split, edit/delete button hover-reveal on character/persona cards (`.character-card:hover .character-actions`) is broken — both buttons render permanently visible. CSS rule itself intact; root cause not found (suspected stale/duplicate script include, unconfirmed). Deprioritized as cosmetic.

---

### `static/js/state.js`
Global variables, loaded first.
- `BASE_URL` — see Network Access Modes above.
- `currentCharacter`, `chatHistory`, `abortController`
- `currentPersona`, `personaImage`, `characterImage`
- `isLlmLoaded`, `isSdLoaded`, `isModelSwitching` — independent booleans, not a mode string.
- `avatarGeneratorTarget`, `selectedAvatarType`, `generatedAvatarData`
- `editingCharacterId`, `editingPersonaId`, `deleteCharacterId`
- `currentView` — restored from `/get_state`, sanitized against current viewport (`_sanitizeRestoredView` in `app.js`) so a mobile-saved view can't strand a desktop session.

### `static/js/ui.js`
- `_pendingClose`/`_cancelPendingClose` — per-modal registry of an in-flight close's cancel function, checked at top of every open path. Needed because a modal can legitimately reopen before its prior close finishes animating (e.g. "Switch model?" → Yes → `vram_warning` → immediate re-confirm on the same `#confirmModal` while the first close is still `.closing`). Without this, the old close's timeout fires after the new open, stripping `.active` off — modal flashes and vanishes. Opening now cancels any pending close for that modal first.
- `showConfirm`/`closeConfirm`, `showCustomAlert`/`closeCustomAlert`
- `showSummarizeModal`/`closeSummarizeModal` — full-screen summarization modal with loader + cancel.
- `toggleSidebar`/`closeSidebar`, `openAvatarModal`/`closeAvatarModal`
- `switchView` — renders target view via the `views` map, toggles desktop `.tab-btn.active` and syncs mobile `.nav-btn.active` by `data-view`. Sole source of truth for both highlight systems.
- `DOMContentLoaded` — inits sidebar: search input delegates to `filterCharacters`/`filterPersonas`, tab toggling calls `loadCharacterList`/`loadPersonaList`, `createEntityBtn` calls `_resetCharacterForm()` before `switchView`, so editing a character then hitting "+ Create" doesn't leak old `editingCharacterId`/field values.

### `static/js/characters.js`
- `fetchCharacters`, `fetchCharacterHistory` — API requests.
- `avatarUrl(id)` — builds avatar URL with cache-busting `?t=` from `_avatarBust`.
- `characterAvatarImg(char)` — returns `<img>` HTML pointing to real avatar or default SVG.
- `loadCharacterList` — loads chars, updates `_charactersCache`, renders `#sidebarList` + `#characterGrid`.
- `loadCharacter(id, restoreView)` — loads character + history, renders greeting (via `_buildGreetingMessage`, see Alternate Greetings Swipe) with `{{char}}`/`{{user}}` substitution, switches view. Flushes outgoing character's draft before reassigning `currentCharacter`, loads incoming draft right after.
- `saveCharacter`/`editCharacter` — on save, redirects to `switchView('load')` on mobile (<768px, bottom-nav flow), or straight to `loadCharacter(charId, 'chat')` on desktop (no sidebar entry point for `load` view).
- Fuzzy search: `_fuzzyScore`/`_levenshtein` (Damerau-Levenshtein), globally accessible, reused by `personas.js`. Cutoff score `0.35` filters noise. `_fuzzyScoreLayoutAware` wraps `_fuzzyScore` with keyboard-layout correction (tries the query as-typed plus every layout reinterpretation from `layoutFix.js`, keeps the best score) — this is what `filterCharacters`/`filterPersonas` actually call, not raw `_fuzzyScore`; see [Keyboard Layout Search Correction](#keyboard-layout-search-correction-staticjslayoutfixjs).
- `_charactersCache`/`_personasCache` — updated on every `loadCharacterList`/`loadPersonaList` call, serve as source for client-side filtering without repeated server requests.
- `_autoResizeTextarea`, `_bindMobileResizeHandle` — see CSS section below for context.
- `handleDirectAvatarUpload` — wired to the new Upload button (see Avatar actions below).

### `static/js/personas.js`
Persona CRUD, mirrors `characters.js` patterns, reuses its fuzzy-search utilities.

---

## Data (`data/`)
- `characters.json` — character list; `vesper` object carries `draft` (unsent input, see `/save_draft/<id>`) and `default_avatar` alongside `id`/`has_avatar`.
- `personas.json` — persona list; same `default_avatar` field but root-level (no `vesper` wrapper).
- `avatars/default/` — fixed SVG pool (`1.svg`–`5.svg`), served via `GET /default_avatar/<filename>`.
- `app_state.json` — last active character/persona/open tab.
- `settings.json` — grouped by section: `system` (incl. `LLAMA_SERVER_URL`, `INACTIVITY_TIMEOUT_HOURS`), `generation` (incl. `DEFAULT_CONTEXT_SIZE`), `prompts`, `models` (selected filenames). `LLAMA_SERVER_URL` lives under `system` not `models` despite the name, so it's reachable from the settings UI.
- `model_configs.json` — per-model config, keyed by filename, validated via `model_autoconfig.validate_model_cfg`, auto-populated via `autodetect_llm_cfg` when missing/broken.
- `model_layer_cache.json` — cached per-layer GGUF tensor sizes, keyed by absolute file path; invalidated on size/mtime change (`layer_weight_cache.py`, see Layer-Fitting Algorithm).
- `histories/<id>.json` — chat history per character.
- `notes/<id>.txt` — persistent notes per character, injected into every LLM prompt as `[PERSISTENT NOTES — FOLLOW AS ABSOLUTE RULES, NO EXCEPTIONS]`.
- `keyboard_layouts.json` — position-indexed keyboard layout tables for search autocorrection; see [Keyboard Layout Search Correction](#keyboard-layout-search-correction-staticjslayoutfixjs). Lives outside `static/`, deliberately not open-served wholesale — `routes/data_files.py` whitelists it by filename rather than exposing the whole `data/` directory (which also holds `settings.json`).

---

## Architectural Notes
- `_fuzzyScore`/`_levenshtein` in `characters.js`, globally accessible — `personas.js` reuses without duplication. `_fuzzyScoreLayoutAware` (also `characters.js`) wraps it with keyboard-layout correction; see [Keyboard Layout Search Correction](#keyboard-layout-search-correction-staticjslayoutfixjs).
- `_charactersCache`/`_personasCache` — updated on every list load, avoid repeated server requests for filtering.
- Search cutoff score `0.35` filters noise.

---

## CSS Notes (`character-editor.css` and related)

- **`.cfg-field-error`/`.cfg-field-hint`/`.cfg-section-heading`** — model-config field validation styles (red border+shake on invalid, red hint text, bolder section heading). Standalone snippet pre-dating the 2nd refactoring, still not merged into any split file. Needs manual placement in `settings.css`.
- **`.field-accordion`/`.form-group` — `flex-shrink: 0`** — `.view-body` is `flex; column`. Without this, flex items shrink below content size when siblings need room — the two always-open textareas (Description/First message) were crushing every accordion below them to ~2px.
- **`.field-accordion-body` — `grid-template-rows: 0fr`/`1fr` swap** — replaced `max-height: 0/none`. Fixed `max-height` clips auto-growing textareas; `none` fixes clipping but can't animate open (snapped instead of sliding). Grid-rows swap animates both directions, no ceiling on content height.
- **`.field-accordion-body-inner` — horizontal padding, vertical margin on content (not the reverse)** — two related bugs from the same padding/margin confusion:
  - *Right-edge overflow:* `.field-textarea` had `width:100%` + its own `margin: 0 var(--space-4) var(--space-4)`. Margin doesn't subtract from `width:100%`, it adds on top — every textarea rendered 16px too wide, spilling past the accordion edge. Fixed: horizontal spacing moved to `padding: 0 var(--space-4)` on the `-inner` wrapper.
  - *Sliver visible while collapsed:* moving ALL spacing (incl. top/bottom) to padding on `-inner` made this worse — padding is part of the element's own box and always renders at declared size even with `min-height:0`, so the "collapsed" `0fr` track never truly hit 0px. Margin on a child, by contrast, has nowhere to sit once its row collapses to zero — it genuinely disappears. Fixed: top/bottom spacing as `margin-top`/`margin-bottom` on `.field-accordion-body-inner > :first-child`/`:last-child`, only left/right stay as wrapper padding.
- **`.alt-greeting-item`/`.charbook-entry` — bumped border to `--border-2`** — base border (`rgba(255,255,255,0.07)`) nearly invisible against surface colors; with only 8px between nested cards they read as an undifferentiated grey smear.
- **`.selected-persona`** — reuses `.active-char` styling (gold border/bg) for the selected persona card; previously applied by JS with no matching CSS.
- **Character form: two-column layout (`.character-form-layout`)** — was one long vertical stack requiring several screens of scroll. Now `grid-template-columns: 240px 1fr`: sticky left rail (`.character-form-rail`) holds PNG import/avatar/name/token count; right column (`.character-form-fields`) holds Description/First message + accordions, scrolls independently. Collapses to single column below 768px. `#imagePreview` here is 2× the shared avatar size (160px vs 80px) — override by id, doesn't affect persona form/avatar-generator modal which reuse the same class at default size.
- **Avatar actions: Upload + Generate side by side** — was a single "Generate avatar" button, with upload buried inside the generator modal, PNG import using an emoji icon. Now `.avatar-action-row` holds two equal buttons under the avatar preview; Upload wired to `handleDirectAvatarUpload`, Generate opens the existing modal; both use hand-drawn inline SVG icons (`currentColor`, no external icon set) instead of emoji. `.import-png-btn` got its own SVG + violet-accented treatment as the fastest form-entry path.
- **Total token counter (`.char-total-tokens`)** — was a muted mono text line, easy to miss. Now a small rail card with the number as focal point. Two details:
  - Renders in `--font-mono` (IBM Plex Mono), not `--font-serif` — Playfair Display's webfont lacks a `tnum` table so `tabular-nums` is a no-op, proportional-width digits reflowed the card width on every keystroke. Plex Mono ships real tabular figures.
  - When any contributing field's count is approximate, card switches from gold to neutral/warning styling and prefixes with `~`, so an estimate never reads as confidently as an exact count.
- **Mobile field adjustments** (`@media max-width:767px`):
  - `#characterDescription`/`#characterFirstMes` get `min-height:192px` (2× shared default) — on phone screens the shared height read as cramped before any text typed. Only these two, not every textarea.
  - `.form-textarea`/`.field-textarea` get `overflow:auto` + `resize:none` (desktop is `overflow:hidden`, see below).
  - **Custom touch resize handle** replaces native `resize:vertical` on mobile — iOS Safari never implemented touch-drag on the native handle (confirmed WebKit behavior, not a CSS gap), Android inconsistent. `_bindMobileResizeHandle` wraps each mobile textarea in `.textarea-resize-wrapper` + a thumb-sized `.textarea-resize-handle` driven by real touch listeners.
- **Desktop `.form-textarea`/`.field-textarea` — `overflow:hidden`** — auto-resize (`_autoResizeTextarea`) grows to fit content every keystroke, so nothing ever overflows on desktop. The browser's default `overflow:auto` still spawns a scrollbar/capture zone on an empty textarea, which grabs the mouse wheel and stalls page scroll when hovered — `hidden` kills that. Mobile keeps `auto` since touch scrolling doesn't have the capture problem.

### Default Avatar System (`routes/default_avatars.py`)
Replaces the old "no image → random emoji" placeholder with a fixed pool of 5 generic SVGs, assigned **once, permanently**.
- **Assigned once at first save** (`ensure_default_avatar()`, called from save/update character/persona — no-op if already set, so edits never reassign). `get_characters`/`get_personas` backfill it on read for older records (batched write). Never re-picked, including when a real avatar is uploaded/removed — standing fallback, not conditional on `has_avatar`. Lives at `vesper.default_avatar` for characters, root-level `default_avatar` for personas. `update_persona` explicitly carries the existing value forward before its full-object overwrite (frontend doesn't send this field, would wipe it otherwise).
- **Preview matches saved value** — `GET /list_default_avatars` lets the frontend pick + preview a filename, sends that exact filename with save (avoids frontend/backend independently rolling different picks).
- **Serving:** `GET /default_avatar/<filename>` in its own blueprint (`default_avatars_bp`), serves `mimetype='image/svg+xml'` explicitly (unlike real-upload avatar routes, hardcoded to `image/jpeg`). `get_default_avatar_path()` rejects anything not a bare `.svg` filename inside `DEFAULT_AVATARS_DIR`.
- **Frontend fallback chain:** real avatar → default SVG → nothing else. Old `randomEmoji()`/`.avatar-emoji` fallback removed from every render path.

### Alternate Greetings Swipe (`characters.js`, `chat.js`)
Character cards can carry multiple `alternate_greetings` alongside `first_mes` (`chara_card_v2` spec) — previously parsed/stored but never surfaced: chat always hardcoded `first_mes` as the opener.

- **No new UI mechanism — reuses the regenerate version-nav.** `chatHistory[0]` (the greeting) is built with the same `{ versions: [], activeVersion }` shape that regenerated bot replies already use (`switchVersion` in `chat.js`), via `_buildGreetingMessage()` (`characters.js`): `versions = [first_mes, ...alternate_greetings]`. The `‹ i/N ›` swipe control in `addMessage` already existed for regen — just extended to render on index 0 too, gated by `canSwipe` instead of the old hardcoded "last message" check.
- **Swipe only available while the greeting is still the sole message.** Once the user replies, `chatHistory.length > 1` locks it — swiping the opener after real conversation exists would retroactively rewrite established context. `isGreeting = messageIndex === 0 && chatHistory.length === 1` gates this everywhere (swipe nav, Edit button, Regenerate button).
- **Edit button hidden on the greeting** for the same reason it'd be pointless: `loadCharacter` rebuilds `chatHistory[0]` from the card's current `first_mes`/`alternate_greetings` on every visit, so a manual edit silently vanishes next time the character is opened. Once the user has replied (`isGreeting` false), the greeting is just a normal saved message and Edit works as usual.
- **`rawVersions` stored alongside `versions`** — un-substituted `{{char}}`/`{{user}}` text, kept so `loadCharacter` can re-fill placeholders (name/persona changed since last visit) without resetting `activeVersion` back to 0, and so cards saved *before* this feature (`chatHistory[0]` with no `versions` at all) get upgraded in place on next load instead of staying stuck as plain text forever — matched against the old saved text where possible so the visible greeting doesn't silently jump.

### Keyboard Layout Search Correction (`static/js/layoutFix.js`)
Character/persona search tolerates the classic "typed in the wrong keyboard layout" mistake (e.g. `Cophie` when the physical keys pressed were the ones for `Sophie` on a different layout) — Google-search-style correction, done entirely client-side.

- **Position-indexed layout tables** (`data/keyboard_layouts.json`), not per-language hardcoded pairs. Every layout is two 33-char strings (`lower`/`upper`), one entry per physical key in a fixed order (`_key_order`, QWERTY-US physical positions). Converting between any two layouts is a same-index lookup — adding a new layout to the JSON doesn't require touching any JS.
- **`reversible: false` flag** — some layouts (Hebrew, BÉPO, Bulgarian BDS, Turkish F, Greek, `ru_phonetic`) physically don't map 1:1 onto 33 Latin key positions; their tables carry legitimate duplicate characters (e.g. Hebrew final-form letters sharing a base position). Reversible layouts must have zero duplicate characters in `lower`/`upper` — a duplicate would make the char→index reverse lookup ambiguous. Non-reversible layouts are valid **conversion targets** only (typed-in-EN → shown-in-that-layout), never sources for autocorrection.
- **`ACTIVE_SOURCE_LAYOUTS`/`TARGET_LAYOUTS`** (top of `layoutFix.js`) — deliberately restricted to `['en', 'ru', 'uk']` rather than all layouts in the JSON. An earlier version tried every source against every target (~650 pairwise conversions per keystroke across 27 layouts) and froze the page for seconds on every input event. Extend these arrays if you regularly type in another layout; each addition costs real per-keystroke work, so this isn't meant to grow to "every layout in the file" by default.
- **Regex pre-check per source layout** (`_sourceCheckRegex`) — skips a conversion entirely if the query contains no characters from that source layout's alphabet, instead of running the conversion and discarding a no-op result.
- **`_variantsCache`** — small `Map` (cap 50, oldest-evicted) keyed on exact query string. Search re-runs on every debounced keystroke; re-typing back to a previously-seen query (common while editing a search box) skips recomputation entirely.
- **`_convertLayoutDirect`** builds one flat `fromChar → toChar` map per `(source, target)` pair at init (`_pairMaps`), rather than converting through a shared key-index at search time — the index-lookup approach worked but did strictly more work per character than a direct map hit needed to.
- Debounced at the search-input level (not in this file) — `layoutFix.js` only controls how many *layout pairs* get tried per call, not how often the call itself fires.


`chat.js`'s `parseMarkdown` started with only `*italic*`; extended to cover the common RP/chat markdown set. **Regex order matters and is not arbitrary:**
1. `> quote` (line-based, `^>\s?(.+)$\n?` with `/gm`) — resolved first, before `\n`→`<br>` conversion, so `^`/`$` anchor on real newlines. The trailing `\n?` in the match is deliberate: `.markdown-quote` is `display:block`, which already forces its own line break — leaving the following `\n` unconsumed would've converted to an extra `<br>` *after* the block, while the `<br>` *before* it gets visually absorbed by the block's own line-start (browsers don't render the two symmetrically). Consuming the trailing newline in the replacement is what makes the spacing above/below the quote look even instead of doubled on one side.
2. `***bold italic***` before `**bold**` — a plain two-pass bold-then-italic order mishandles triple asterisks (bold's lazy `.+?` doesn't stop where you'd expect inside `***x***`); needs its own explicit rule, output as nested `<strong><em>`.
3. `**bold**`, then `~~strikethrough~~`, then leftover single `*italic*` last, so it doesn't consume asterisks that belong to a wider pair already been replaced.
- **Colors:** `.markdown-quote` and the new `.markdown-bold-italic` both use `--gold-light`/`--gold-border` rather than `--text-2` (which is what `.markdown-italic` uses) — `--text-2` reads too close to `--violet` (already owned by `.ooc-cmd`) and to normal message text at a glance, gold gives both new styles a distinct, non-competing identity.


Field of faceted low-poly "crystal" motifs, generated once per page load, drifting/spinning behind every `.view`. Purely decorative (`aria-hidden`, `pointer-events:none`).
- **JS generation, not CSS `background-image`** — tiled images mechanically repeat; real irregularity needs randomized placement. Builds one large `<svg>` at `DOMContentLoaded` (deferred one `requestAnimationFrame`), never touched again — not a per-frame generator.
- **Crystal shape:** faceted polygon fan, triangular facets radiating from an off-center apex toward a fixed "light" direction, opacity set by facet angle to that direction. Off-center apex sells the 3D read (symmetric fan reads as a flat decorated circle). Replaced earlier flat-outline/open-glyph motifs which read as clutter or flat at high density.
- **Placement:** cell-based grid with per-cell jitter (avoids Poisson-disc clumping of pure random scatter) + random skip chance to avoid a perfect-lattice look. Tuned toward larger, sparser crystals with breathing room.
- **Sizing measured from host element, not `window`** — `.main-content` is narrower than the window (sidebar eats space); an earlier version sized the SVG viewBox off `window.innerWidth` while CSS sized the box off `.main-content`, disagreeing by exactly the sidebar width and shoving the field off-screen. Fixed via `host.getBoundingClientRect()`.
- **Self-rotation, no orbit:** each crystal spins at randomized speed/direction/phase via one shared `@keyframes` + per-instance CSS custom properties (`--spin-duration`, `--spin-direction`, `--base-rotation`) — avoids bloating markup with per-crystal keyframes. An orbital-wobble animation on the wrapping `<g>` was attempted and abandoned — reliably made the entire field invisible, but only at `devicePixelRatio===1` (exactly 100% zoom). Root cause not found despite systematic elimination — pointed at a Chromium compositing edge case. Not worth continuing to chase; orbit removed, self-rotation kept.
- **`requestAnimationFrame` before measuring** — generation deferred one frame past `DOMContentLoaded` since layout isn't guaranteed settled at that event, only that the DOM is parsed.
- **View transitions hand off sequentially, no cross-fade** (`switchView`/`_showView` in `ui.js`, `.view`/`.view-leaving` in `layout.css`) — outgoing view fully exits before incoming starts. An earlier cross-fade had both views' geometry live simultaneously, visibly colliding on mobile. Not specific to the background pattern, but its z-layering depends on a clean handoff.

### Rubber-Band Overscroll (`static/js/scrollBounce.js`)
Cosmetic spring-back on scroll/swipe past chat log edges. Self-contained, doesn't touch `chat.js` streaming/render logic.
- **Never transforms `#chatMessages` itself** — that's the scroll container; `transform` takes an element out of normal layout and would overlap the header/input bar around it. Fix: wrap message nodes in `#chatMessagesInner` (`templates/_chat.html`) and transform that instead; `#chatMessages` keeps clipping via `overflow`.
- **Every call site touching chat content moved to the inner wrapper** — `chat.js`'s `addMessage`/`addLoadingIndicator`/`reloadChat`, plus `characters.js`'s `loadCharacter`/`deleteCharacter`/`clearChatHistory`, all originally targeted `#chatMessages` directly, which would've silently deleted `#chatMessagesInner` along with the messages (next `addMessage` throws `Cannot read properties of null`). `scrollTop`/`scrollHeight`/`clientHeight` reads stayed on `#chatMessages` since those are legitimately about the scroll container.
- **Touch has a natural gesture end (`touchend`); wheel doesn't.** Handled via idle debounce (`WHEEL_IDLE_MS`=70ms — no further event means gesture over, snaps back) + immediate snap when a new wheel tick reverses sign relative to the current pull. `touchcancel` also handled alongside `touchend` since an OS-reclaimed gesture never fires `touchend`.
- **Resistance is a rubber-band curve, not linear clamp** — raw input feeds `max*(1-e^(-x/max))`, compressing hard near `OVERSCROLL_PX` (feels like pushing against something). Raw input itself hard-capped at 1.6× visual max (`RAW_PULL_CAP`) — beyond that further input does nothing, preventing infinite pinned-at-max accumulation from continuous wheel spin.
- **`overscroll-behavior: contain` on `.chat-messages`** — stops native browser overscroll from fighting the custom one.

---

## File Reference (one-liner per file)

Full flat index. Files with a dedicated writeup elsewhere in this doc link back instead of repeating it — check there for the "why", this list is just the "what".

### Backend
- `app.py` — Flask entry point; registers blueprints, boots loader threads for pre-selected models.
- `run_code.bat` — see [`run_code.bat`](#run_codebat) above.

**`model_logic/`**
- `model_manager.py` — low-level LLM/SD process lifecycle; see [Independent Model Lifecycles](#2-independent-model-lifecycles-llm--image) and [VRAM Management Strategy](#3-vram-management-strategy-independent-user-controlled).
- `model_autoconfig.py` — validates + auto-generates per-model configs from GGUF metadata; see [Layer-Fitting Algorithm](#35-layer-fitting-algorithm-model_logiclayer_weightspy-layer_weight_cachepy).
- `layer_weights.py` — GGUF tensor directory → per-layer VRAM cost, prefix-sum greedy fit; see [Layer-Fitting Algorithm](#35-layer-fitting-algorithm-model_logiclayer_weightspy-layer_weight_cachepy).
- `layer_weight_cache.py` — caches `layer_weights.py` output by file path; see [Layer-Fitting Algorithm](#35-layer-fitting-algorithm-model_logiclayer_weightspy-layer_weight_cachepy).

**`routes/`**
- `routes/chat.py` — `/chat`, token counting, summarization/meta-summarization endpoints.
- `routes/characters.py` — character CRUD, chat history, notes, PNG chara-card import.
- `routes/personas.py` — user persona CRUD.
- `routes/models.py` — model selection/unload endpoints and model listing.
- `routes/settings.py` — read/write `settings.json`, per-model config save/validate.
- `routes/image.py` — Stable Diffusion avatar/image generation endpoints.
- `routes/system.py` — app state, PC shutdown/restart, inactivity watchdog.
- `routes/default_avatars.py` — serves the fixed pool of fallback SVG avatars; see [Default Avatar System](#default-avatar-system-routesdefault_avatarspy).
- `routes/data_files.py` — whitelisted file server for `data/`, currently just `keyboard_layouts.json`; see [Keyboard Layout Search Correction](#keyboard-layout-search-correction-staticjslayoutfixjs).

### Frontend — Templates (`templates/`)
- `index.html` — skeleton only (`<head>`, `{% include %}` calls, script tags); see [HTML Partials](#html-partials).
- `_icons.html` — hidden SVG icon sprite (`<symbol>` defs).
- `_modals.html` — all modal windows (confirm, alert, avatar, summarize, summary browser).
- `_navigation.html` — desktop sidebar and mobile bottom nav.
- `_chat.html` — `#chatView` (the chat interface itself).
- `_tools.html` — settings view, image-gen view, text-replace view, model config modal.
- `_forms.html` — character and persona create/load CRUD forms.

### Frontend — JS (`static/js/`)
- `bgPattern.js` — see [Decorative Background Pattern](#decorative-background-pattern-staticjsbgpatternjs).
- `state.js` — see [`static/js/state.js`](#staticjsstatejs) above.
- `ui.js` — see [`static/js/ui.js`](#staticjsuijs) above.
- `layoutFix.js` — see [Keyboard Layout Search Correction](#keyboard-layout-search-correction-staticjslayoutfixjs).
- `characters.js` — see [`static/js/characters.js`](#staticjscharactersjs) above.
- `personas.js` — see [`static/js/personas.js`](#staticjspersonasjs) above.
- `imageGen.js` — Stable Diffusion image/avatar generation streaming UI.
- `chat.js` — core chat rendering, streaming, send/regenerate logic; see [Request Flow](#3-request-flow-message--response).
- `chatSummary.js` — conversation summarization and meta-summarization UI. Split from `chat.js`.
- `chatNotes.js` — persistent per-character notes panel. Split from `chat.js`.
- `chatDraft.js` — Telegram-style unsent-message draft persistence. Split from `chat.js`.
- `scrollBounce.js` — see [Rubber-Band Overscroll](#rubber-band-overscroll-staticjsscrollbouncejs).
- `modelManager.js` — model switching UI and per-model config modal. Split from old `main.js`.
- `textReplace.js` — standalone find/replace text view. Split from old `main.js`.
- `tokenCounter.js` — character-form token counters; split out from an inline `<script>` in `index.html`.
- `settings.js` — settings form generation, save, and restart flow.
- `app.js` — app orchestrator: state restore, token bar, `DOMContentLoaded` init. What's left of old `main.js`.

### Frontend — CSS (`static/css/`)
- `main.css` — entry point importing all other stylesheets in order.
- `variables.css` — design tokens (colors, typography, sizes, animations).
- `base.css` — CSS reset, self-hosted font imports.
- `layout.css` — SPA shell, sidebar, bottom nav, breakpoints.
- `bg-pattern.css` — styling for the generated crystal background.
- `chat.css` — chat messages, input, token counter styling.
- `forms.css` — generic form controls (inputs, buttons, search).
- `character-editor.css` — character/persona grid and two-column form layout; see [CSS Notes](#css-notes-character-editorcss-and-related).
- `settings.css` — model manager cards and settings accordion styling.
- `image-gen.css` — image generation view styling.
- `text-replace.css` — text replace view styling.
- `modals.css` — modal windows and overlays.
- `markdown.css` — markdown rendering inside chat messages.
- `utils.css` — atomic helpers, animations, utility classes.

---

## Known Issues / Open Items
- ~~Mixed-content errors over ngrok tunnel~~ resolved (see Network Access Modes).
- **TurboQuant not factored into autodetect VRAM math** — not a blocker, just makes calculated `gpu_layers`/context headroom conservative rather than optimal on TurboQuant setups.
- **No UI for manual layer-fitting override** — `gpu_layers` can already be set directly in `model_configs.json` (or via any future settings field that writes to it) and `autodetect_llm_cfg()` will happily leave it alone once populated, but there's no dedicated "Advanced" settings tab yet, no per-model VRAM-reserve override (hardcoded 1GB in `model_autoconfig.py`), and no flag distinguishing "user set this deliberately" from "autoconfig populated this, safe to recompute on next model swap" — a re-run of autodetect on config repair/update would currently overwrite a manual value. Planned for the 2nd great refactoring's settings pass.
- **Background pattern has no orbital wobble, only self-rotation** — see bgPattern.js above. If revisited, try a `requestAnimationFrame`-driven JS animation instead of CSS `@keyframes` to sidestep the Chromium compositing issue.
- ~~chara_card_v2 full field support~~ resolved. **Still open:** `data.extensions` round-trips on save/import, but its editing UI (`#characterExtensions` textarea + `acc-extensions` accordion) is built and hidden (`display:none`) — not wired into the form, raw-JSON editing not ready to expose. Not injected into system prompt by design (arbitrary third-party metadata, not a prompt field).