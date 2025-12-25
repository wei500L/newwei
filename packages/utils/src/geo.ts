import { COUNTRY_DATA } from "./country-data";

const ALPHA2_TO_ALPHA3 = new Map<string, string>();
const ALPHA3_SET = new Set<string>();
const NAME_TO_ALPHA3 = new Map<string, string>();
const ALPHA3_TO_NAME = new Map<string, string>();

const normalizeKey = (value: string): string =>
  value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['.]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const ALIAS_ENTRIES: Array<[string, string]> = [
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
  ["Viet Nam", "VNM"],
  ["Venezuela", "VEN"],
  ["Vietnam", "VNM"]
];

const ALIAS_TO_ALPHA3 = new Map<string, string>(
  ALIAS_ENTRIES.map(([label, code]) => [normalizeKey(label), code])
);

for (const entry of COUNTRY_DATA) {
  const alpha2 = entry.alpha2.toUpperCase();
  const alpha3 = entry.alpha3.toUpperCase();
  ALPHA2_TO_ALPHA3.set(alpha2, alpha3);
  ALPHA3_SET.add(alpha3);
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
  NAME_TO_ALPHA3.set(normalizeKey(entry.name), alpha3);
  ALPHA3_TO_NAME.set(alpha3, entry.name);
}

export const normalizeCountryCode = (input?: string | null): string | null => {
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
  return ALIAS_TO_ALPHA3.get(normalized) ?? NAME_TO_ALPHA3.get(normalized) ?? null;
};

export const extractCountryCodeFromText = (text?: string | null): string | null => {
  if (!text || typeof text !== "string") {
    return null;
  }

  const sanitized = text
    .replace(/\bU\.S\.A?\b/gi, "USA")
    .replace(/\bU\.K\.\b/gi, "UK");

  const tokens = sanitized
    .split(/[\s,;:.()/-]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const isShort = token.length <= 3;
    if (isShort && token !== token.toUpperCase()) {
      continue;
    }

    const code = normalizeCountryCode(token);
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

  return null;
};

export const getCountryName = (input?: string | null): string | null => {
  const code = normalizeCountryCode(input);
  if (!code) {
    return null;
  }

  return ALPHA3_TO_NAME.get(code) ?? null;
};
