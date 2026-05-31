const fs = require('node:fs');
const path = require('node:path');

const {
  collectTranslationKeys,
  flattenKeys,
  getDeepOwn,
  hasTranslationKey,
  setDeepIfMissing,
} = require('./i18n-utils');

function pickDefaultValue(defaults) {
  const list = [...defaults].filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  return list.sort((a, b) => b.length - a.length)[0];
}

function main() {
  const copyEnToZh = process.argv.includes('--copy-en-to-zh');
  const appRootDir = path.join(__dirname, '..');
  const localesDir = path.join(appRootDir, 'lib', 'locales');
  const enPath = path.join(localesDir, 'en.json');
  const zhPath = path.join(localesDir, 'zh.json');

  const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(zhPath, 'utf8'));

  const used = collectTranslationKeys(appRootDir);

  const enKeys = flattenKeys(en);
  const zhKeys = flattenKeys(zh);

  let enAdded = 0;
  let zhAdded = 0;
  let warnings = 0;
  const missingZh = [];

  for (const [key, info] of used.entries()) {
    if (!hasTranslationKey(enKeys, key)) {
      const extracted = pickDefaultValue(info.defaults);
      const fallback = key === 'common.row' ? 'Row' : key;
      const value = extracted ?? fallback;
      const result = setDeepIfMissing(en, key, value);
      if (!result.ok) {
        warnings++;
        console.warn(`[i18n] WARN: ${result.reason} (skipping ${key})`);
      } else {
        enAdded++;
      }
    }
  }

  // Refresh after adding new keys to en.
  const nextEnKeys = flattenKeys(en);

  for (const key of nextEnKeys) {
    if (!hasTranslationKey(zhKeys, key)) {
      const value = getDeepOwn(en, key);
      if (value === undefined) continue;
      if (!copyEnToZh) {
        missingZh.push({ key, value });
        continue;
      }
      const result = setDeepIfMissing(zh, key, value);
      if (!result.ok) {
        warnings++;
        console.warn(`[i18n] WARN: ${result.reason} (skipping ${key})`);
      } else {
        zhAdded++;
      }
    }
  }

  fs.writeFileSync(enPath, `${JSON.stringify(en, null, 2)}\n`);
  fs.writeFileSync(zhPath, `${JSON.stringify(zh, null, 2)}\n`);

  console.log(`[i18n] Synced: en +${enAdded}, zh +${zhAdded}${warnings ? `, warnings ${warnings}` : ''}`);
  if (missingZh.length) {
    console.error('[i18n] Missing zh translations. Add translated values, or pass --copy-en-to-zh for a temporary legacy fallback:');
    for (const item of missingZh.slice(0, 80)) {
      console.error(`- ${item.key}: ${JSON.stringify(item.value)}`);
    }
    if (missingZh.length > 80) console.error(`... and ${missingZh.length - 80} more`);
    process.exit(1);
  }
}

main();
