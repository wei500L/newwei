const path = require('node:path');

const { flattenKeys } = require('./i18n-utils');

function flattenValues(object, prefix = '') {
  const result = new Map();
  for (const [key, value] of Object.entries(object || {})) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of flattenValues(value, pathKey).entries()) {
        result.set(nestedKey, nestedValue);
      }
      continue;
    }
    result.set(pathKey, value);
  }
  return result;
}

function containsCjk(value) {
  return /[\u4e00-\u9fff]/.test(value);
}

function isMostlyAcronym(value) {
  // Short tokens, env vars, acronyms, or identifiers.
  if (value.length <= 5 && /^[A-Z0-9+._-]+$/.test(value)) return true;
  if (/^[A-Z0-9_]+$/.test(value) && value.length <= 40) return true;
  return false;
}

function isEnglishish(value) {
  if (!/[A-Za-z]{3,}/.test(value)) return false;
  if (containsCjk(value)) return false;
  if (isMostlyAcronym(value)) return false;
  if (/^https?:\/\//.test(value)) return false;
  return true;
}

function main() {
  const appRootDir = path.join(__dirname, '..');
  const localesDir = path.join(appRootDir, 'lib', 'locales');

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const en = require(path.join(localesDir, 'en.json'));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const zh = require(path.join(localesDir, 'zh.json'));

  const enKeys = flattenKeys(en);
  const zhKeys = flattenKeys(zh);
  const enValues = flattenValues(en);
  const zhValues = flattenValues(zh);

  const cjkInEn = [];
  for (const [key, value] of enValues.entries()) {
    if (typeof value !== 'string') continue;
    if (containsCjk(value)) cjkInEn.push({ key, value });
  }

  const englishishInZh = [];
  for (const [key, value] of zhValues.entries()) {
    if (typeof value !== 'string') continue;
    if (isEnglishish(value)) englishishInZh.push({ key, value });
  }

  const sameStrings = [];
  for (const key of enKeys) {
    if (!zhKeys.has(key)) continue;
    const enValue = enValues.get(key);
    const zhValue = zhValues.get(key);
    if (typeof enValue !== 'string' || typeof zhValue !== 'string') continue;
    if (enValue === zhValue) sameStrings.push({ key, value: enValue });
  }

  console.log('[i18n] Audit:');
  console.log(`- en.json CJK strings: ${cjkInEn.length}`);
  console.log(`- zh.json English-ish strings: ${englishishInZh.length}`);
  console.log(`- Exact same strings (en == zh): ${sameStrings.length}`);

  if (cjkInEn.length) {
    console.log('\n[i18n] en.json contains CJK strings (likely accidental):');
    for (const item of cjkInEn) console.log(`- ${item.key}: ${JSON.stringify(item.value)}`);
  }

  if (englishishInZh.length) {
    console.log('\n[i18n] zh.json contains English-ish strings (review for localization):');
    for (const item of englishishInZh.slice(0, 200)) console.log(`- ${item.key}: ${JSON.stringify(item.value)}`);
    if (englishishInZh.length > 200) {
      console.log(`... and ${englishishInZh.length - 200} more`);
    }
  }

  if (sameStrings.length) {
    console.log('\n[i18n] Strings that are exactly the same in en/zh (may be fine for acronyms):');
    for (const item of sameStrings.slice(0, 200)) console.log(`- ${item.key}: ${JSON.stringify(item.value)}`);
    if (sameStrings.length > 200) {
      console.log(`... and ${sameStrings.length - 200} more`);
    }
  }

  // Only fail hard on clearly unintended cases.
  if (cjkInEn.length) process.exit(1);
}

main();

