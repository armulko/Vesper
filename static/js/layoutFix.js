// static/js/layoutFix.js
// Раскладочная коррекция поискового запроса — конверт по индексу физической клавиши.

const KEYBOARD_LAYOUTS_URL = '/data/keyboard_layouts.json';
const ACTIVE_SOURCE_LAYOUTS = ['en', 'ru', 'uk'];
const TARGET_LAYOUTS = ['en', 'ru', 'uk'];

// Максимальная длина строки, для которой имеет смысл выполнять перекодирование
const MAX_LAYOUT_FIX_LENGTH = 60;

let _layoutData = null;
const _pairMaps = new Map(); // "en->ru" -> Direct Map Object
const _sourceCheckRegex = new Map(); // "en" -> RegExp

let _variantsCache = new Map();
const _VARIANTS_CACHE_MAX = 50;

async function _initLayoutFix() {
    try {
        const r = await fetch(KEYBOARD_LAYOUTS_URL);
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${KEYBOARD_LAYOUTS_URL}`);
        const json = await r.json();
        _layoutData = { keyOrder: json._key_order, layouts: json.layouts };

        // Собираем быструю регулярку для проверки наличия символов раскладки
        for (const code of ACTIVE_SOURCE_LAYOUTS) {
            const layout = json.layouts[code];
            if (!layout) continue;

            // ИСПРАВЛЕНИЕ: Если lower/upper — строки, мы не вызываем .join('')
            const lowerStr = Array.isArray(layout.lower) ? layout.lower.join('') : (layout.lower || '');
            const upperStr = Array.isArray(layout.upper) ? layout.upper.join('') : (layout.upper || '');

            const allChars = (lowerStr + upperStr).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
            _sourceCheckRegex.set(code, new RegExp(`[${allChars}]`));
        }

        // Генерируем прямые словари конвертации символ-в-символ
        for (const fromCode of ACTIVE_SOURCE_LAYOUTS) {
            const fromLayout = json.layouts[fromCode];
            if (!fromLayout || fromLayout.reversible === false) continue;

            for (const toCode of TARGET_LAYOUTS) {
                if (fromCode === toCode) continue;
                const toLayout = json.layouts[toCode];
                if (!toLayout) continue;

                const pairKey = `${fromCode}->${toCode}`;
                const directMap = Object.create(null);

                // ИСПРАВЛЕНИЕ: Безопасное получение длины (работает и с массивами, и со строками)
                const minLowerLen = Math.min(fromLayout.lower.length, toLayout.lower.length);
                for (let i = 0; i < minLowerLen; i++) {
                    directMap[fromLayout.lower[i]] = toLayout.lower[i];
                }

                const minUpperLen = Math.min(fromLayout.upper.length, toLayout.upper.length);
                for (let i = 0; i < minUpperLen; i++) {
                    directMap[fromLayout.upper[i]] = toLayout.upper[i];
                }

                _pairMaps.set(pairKey, directMap);
            }
        }
    } catch (e) {
        console.error('Layout data load failed, layout-fix disabled:', e);
        _layoutData = { keyOrder: [], layouts: {} };
    }
}
document.addEventListener('DOMContentLoaded', _initLayoutFix);

function _convertLayoutDirect(str, pairKey) {
    const map = _pairMaps.get(pairKey);
    if (!map) return str;

    const len = str.length;
    const out = new Array(len);

    for (let i = 0; i < len; i++) {
        const ch = str[i];
        out[i] = map[ch] ?? ch;
    }

    return out.join('');
}

function _getLayoutVariants(query) {
    if (!_layoutData || !query.trim() || query.length > MAX_LAYOUT_FIX_LENGTH) {
        return [query];
    }

    const cached = _variantsCache.get(query);
    if (cached) return cached;

    const variantsSet = new Set([query]);

    for (const [pairKey, map] of _pairMaps.entries()) {
        const [fromCode] = pairKey.split('->');
        const regex = _sourceCheckRegex.get(fromCode);

        // Если в строке вовсе нет символов исходной раскладки — пропускаем
        if (regex && !regex.test(query)) {
            continue;
        }

        const converted = _convertLayoutDirect(query, pairKey);
        if (converted !== query) {
            variantsSet.add(converted);
        }
    }

    const variants = Array.from(variantsSet);

    if (_variantsCache.size >= _VARIANTS_CACHE_MAX) {
        _variantsCache.delete(_variantsCache.keys().next().value);
    }
    _variantsCache.set(query, variants);

    return variants;
}