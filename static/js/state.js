// state.js

let currentCharacter = null;
let characterImage = null;
let deleteCharacterId = null;
let editingCharacterId = null;
let abortController = null;
let chatHistory = [];

let currentView = 'chat';

let currentPersona = null;
let personaImage = null;
let editingPersonaId = null;

let isLlmLoaded = false;
let isSdLoaded = false;
let isModelSwitching = false;

let avatarGeneratorTarget = null;
let selectedAvatarType = 'portrait';
let generatedAvatarData = null;

// Локально (localhost/127.0.0.1) и по локальной сети (192.168.x.x, 10.x.x.x, 172.16-31.x.x) —
// бэкенд всегда на :5000, страница и бэкенд на одной машине/сети, порт нужен явно.
// Через ngrok (или другой https-прокси) страница отдаётся с https, а прокся сама шлёт трафик
// на локальный :5000 у тебя на машине — снаружи порт указывать НЕ нужно, иначе mixed content.
const _isLan = /^(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(window.location.hostname);
const BASE_URL = _isLan
    ? `${window.location.protocol}//${window.location.hostname}:5000`
    : `${window.location.protocol}//${window.location.hostname}`;