"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCountryAlpha2 = exports.getCountryName = exports.extractCountryCodeFromText = exports.normalizeCountryCode = void 0;
const country_data_1 = require("./country-data");
const ALPHA2_TO_ALPHA3 = new Map();
const ALPHA3_SET = new Set();
const NAME_TO_ALPHA3 = new Map();
const ALPHA3_TO_NAME = new Map();
const ALPHA3_TO_ALPHA2 = new Map();
const normalizeKey = (value) => value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['.]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const normalizeLocaleKey = (value) => value
    .trim()
    .normalize("NFKC")
    .replace(/[\s'"·•，、,;:.()（）[\]{}<>《》“”‘’]/g, "")
    .toLowerCase();
const ALIAS_ENTRIES = [
    ["America", "USA"],
    ["Bolivia", "BOL"],
    ["Bosnia", "BIH"],
    ["Burma", "MMR"],
    ["Cabo Verde", "CPV"],
    ["Cape Verde", "CPV"],
    ["Czech Republic", "CZE"],
    ["Czechia", "CZE"],
    ["DRC", "COD"],
    ["Democratic Republic of the Congo", "COD"],
    ["Congo-Kinshasa", "COD"],
    ["Republic of the Congo", "COG"],
    ["Congo-Brazzaville", "COG"],
    ["Eswatini", "SWZ"],
    ["Iran", "IRN"],
    ["Ivory Coast", "CIV"],
    ["Korea", "KOR"],
    ["Laos", "LAO"],
    ["Macedonia", "MKD"],
    ["North Macedonia", "MKD"],
    ["North Korea", "PRK"],
    ["Palestine", "PSE"],
    ["Russia", "RUS"],
    ["South Korea", "KOR"],
    ["Syria", "SYR"],
    ["Tanzania", "TZA"],
    ["Turkey", "TUR"],
    ["UK", "GBR"],
    ["U.K.", "GBR"],
    ["UAE", "ARE"],
    ["United Kingdom", "GBR"],
    ["United Arab Emirates", "ARE"],
    ["United States", "USA"],
    ["United States of America", "USA"],
    ["US", "USA"],
    ["USA", "USA"],
    ["U.S.", "USA"],
    ["East Timor", "TLS"],
    ["Viet Nam", "VNM"],
    ["Venezuela", "VEN"],
    ["Vietnam", "VNM"]
];
const ALIAS_TO_ALPHA3 = new Map(ALIAS_ENTRIES.map(([label, code]) => [normalizeKey(label), code]));
const LOCALE_ALIAS_ENTRIES = [
    ["中国", "CHN"],
    ["中國", "CHN"],
    ["中国台湾", "TWN"],
    ["中国台灣", "TWN"],
    ["中國台湾", "TWN"],
    ["中國台灣", "TWN"],
    ["中國臺灣", "TWN"],
    ["中国台北", "TWN"],
    ["中國台北", "TWN"],
    ["中國臺北", "TWN"],
    ["台湾", "TWN"],
    ["台灣", "TWN"],
    ["美国", "USA"],
    ["美國", "USA"],
    ["英国", "GBR"],
    ["英國", "GBR"],
    ["俄罗斯", "RUS"],
    ["俄羅斯", "RUS"],
    ["乌克兰", "UKR"],
    ["烏克蘭", "UKR"],
    ["日本", "JPN"],
    ["韩国", "KOR"],
    ["韓國", "KOR"],
    ["朝鲜", "PRK"],
    ["朝鮮", "PRK"],
    ["以色列", "ISR"],
    ["巴勒斯坦", "PSE"],
    ["伊朗", "IRN"],
    ["土耳其", "TUR"],
    ["叙利亚", "SYR"],
    ["敘利亞", "SYR"],
    ["中华人民共和国", "CHN"],
    ["中華人民共和國", "CHN"],
    ["东帝汶", "TLS"],
    ["東帝汶", "TLS"]
];
const LOCALE_NAME_TO_ALPHA3 = new Map(LOCALE_ALIAS_ENTRIES.map(([label, code]) => [normalizeLocaleKey(label), code]));
for (const entry of country_data_1.COUNTRY_DATA) {
    const alpha2 = entry.alpha2.toUpperCase();
    const alpha3 = entry.alpha3.toUpperCase();
    ALPHA2_TO_ALPHA3.set(alpha2, alpha3);
    ALPHA3_SET.add(alpha3);
    ALPHA3_TO_ALPHA2.set(alpha3, alpha2);
    NAME_TO_ALPHA3.set(normalizeKey(entry.name), alpha3);
    ALPHA3_TO_NAME.set(alpha3, entry.name);
}
const EXTRA_COUNTRIES = [
    { name: "Kosovo", alpha2: "XK", alpha3: "XKX" }
];
for (const entry of EXTRA_COUNTRIES) {
    const alpha2 = entry.alpha2.toUpperCase();
    const alpha3 = entry.alpha3.toUpperCase();
    ALPHA2_TO_ALPHA3.set(alpha2, alpha3);
    ALPHA3_SET.add(alpha3);
    ALPHA3_TO_ALPHA2.set(alpha3, alpha2);
    NAME_TO_ALPHA3.set(normalizeKey(entry.name), alpha3);
    ALPHA3_TO_NAME.set(alpha3, entry.name);
}
const LOCALE_SETS = [["zh-Hans"], ["zh-Hant"], ["zh"]];
const canUseDisplayNames = () => typeof Intl !== "undefined" &&
    typeof Intl.DisplayNames === "function";
const addLocaleDisplayNames = (locales) => {
    if (!canUseDisplayNames()) {
        return;
    }
    let displayNames = null;
    try {
        displayNames = new Intl.DisplayNames(locales, { type: "region" });
    }
    catch {
        displayNames = null;
    }
    if (!displayNames) {
        return;
    }
    const entries = [...country_data_1.COUNTRY_DATA, ...EXTRA_COUNTRIES];
    for (const entry of entries) {
        const alpha2 = entry.alpha2.toUpperCase();
        const alpha3 = entry.alpha3.toUpperCase();
        const displayName = displayNames.of(alpha2);
        if (!displayName || typeof displayName !== "string") {
            continue;
        }
        const key = normalizeLocaleKey(displayName);
        if (!key) {
            continue;
        }
        const existing = LOCALE_NAME_TO_ALPHA3.get(key);
        if (!existing) {
            LOCALE_NAME_TO_ALPHA3.set(key, alpha3);
        }
    }
};
for (const locales of LOCALE_SETS) {
    addLocaleDisplayNames(locales);
}
const LOCALE_MATCHERS = Array.from(LOCALE_NAME_TO_ALPHA3.entries())
    .map(([label, code]) => ({ label, code }))
    .sort((a, b) => b.label.length - a.label.length);
const normalizeCountryCode = (input) => {
    if (!input || typeof input !== "string") {
        return null;
    }
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }
    const upper = trimmed.toUpperCase();
    if (/^[A-Z]{3}$/.test(upper) && ALPHA3_SET.has(upper)) {
        return upper;
    }
    if (/^[A-Z]{2}$/.test(upper)) {
        return ALPHA2_TO_ALPHA3.get(upper) ?? null;
    }
    const normalized = normalizeKey(trimmed);
    const localeKey = normalizeLocaleKey(trimmed);
    return (ALIAS_TO_ALPHA3.get(normalized) ??
        NAME_TO_ALPHA3.get(normalized) ??
        LOCALE_NAME_TO_ALPHA3.get(localeKey) ??
        null);
};
exports.normalizeCountryCode = normalizeCountryCode;
const extractCountryCodeFromText = (text) => {
    if (!text || typeof text !== "string") {
        return null;
    }
    const sanitized = text
        .replace(/\bU\.S\.A?\.?/gi, "USA")
        .replace(/\bU\.K\.?/gi, "UK");
    const direct = (0, exports.normalizeCountryCode)(sanitized);
    if (direct) {
        return direct;
    }
    const tokens = sanitized
        .split(/[\s,;:.()/-]+/)
        .map((token) => token.trim())
        .filter(Boolean);
    for (const token of tokens) {
        const isShort = token.length <= 3;
        if (isShort && token !== token.toUpperCase()) {
            continue;
        }
        const code = (0, exports.normalizeCountryCode)(token);
        if (code) {
            return code;
        }
    }
    const normalizedText = ` ${normalizeKey(sanitized)} `;
    for (const [alias, code] of ALIAS_TO_ALPHA3.entries()) {
        if (alias.length <= 3) {
            continue;
        }
        if (normalizedText.includes(` ${alias} `)) {
            return code;
        }
    }
    for (const [name, code] of NAME_TO_ALPHA3.entries()) {
        if (normalizedText.includes(` ${name} `)) {
            return code;
        }
    }
    const localeText = normalizeLocaleKey(sanitized);
    if (!localeText) {
        return null;
    }
    for (const matcher of LOCALE_MATCHERS) {
        if (matcher.label.length <= 1) {
            continue;
        }
        if (localeText.includes(matcher.label)) {
            return matcher.code;
        }
    }
    return null;
};
exports.extractCountryCodeFromText = extractCountryCodeFromText;
const getCountryName = (input) => {
    const code = (0, exports.normalizeCountryCode)(input);
    if (!code) {
        return null;
    }
    return ALPHA3_TO_NAME.get(code) ?? null;
};
exports.getCountryName = getCountryName;
const getCountryAlpha2 = (input) => {
    const code = (0, exports.normalizeCountryCode)(input);
    if (!code) {
        return null;
    }
    return ALPHA3_TO_ALPHA2.get(code) ?? null;
};
exports.getCountryAlpha2 = getCountryAlpha2;
//# sourceMappingURL=geo.js.map