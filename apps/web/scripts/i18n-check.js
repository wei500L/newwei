const path = require('node:path');
const process = require('node:process');

const {
  collectTranslationDefaultValueUsages,
  collectTranslationKeys,
  findPrefixConflicts,
  flattenKeys,
  hasTranslationKey,
} = require('./i18n-utils');

function main() {
  const appRootDir = path.join(__dirname, '..');
  const localesDir = path.join(appRootDir, 'lib', 'locales');

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const en = require(path.join(localesDir, 'en.json'));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const zh = require(path.join(localesDir, 'zh.json'));

  const enKeys = flattenKeys(en);
  const zhKeys = flattenKeys(zh);

  const used = collectTranslationKeys(appRootDir);
  const usedKeys = new Set(used.keys());
  const { staticDefaults, dynamicDefaults } =
    collectTranslationDefaultValueUsages(appRootDir);

  const prefixConflicts = findPrefixConflicts(usedKeys);
  if (prefixConflicts.length) {
    console.error('[i18n] Key prefix conflicts (used as both key and namespace):');
    for (const key of prefixConflicts) console.error(`- ${key}`);
    process.exit(1);
  }

  const missingInEn = [];
  const missingInZh = [];
  for (const key of [...usedKeys].sort()) {
    if (!hasTranslationKey(enKeys, key)) missingInEn.push(key);
    if (!hasTranslationKey(zhKeys, key)) missingInZh.push(key);
  }

  const missingZhFromEn = [];
  for (const key of [...enKeys].sort()) {
    if (!hasTranslationKey(zhKeys, key)) missingZhFromEn.push(key);
  }

  if (
    !missingInEn.length &&
    !missingInZh.length &&
    !missingZhFromEn.length &&
    !staticDefaults.length
  ) {
    console.log('[i18n] OK: locales cover all used keys and zh matches en.');
    if (dynamicDefaults.length) {
      console.log(`[i18n] Dynamic translation defaultValue fallbacks: ${dynamicDefaults.length}`);
    }
    return;
  }

  if (missingInEn.length) {
    console.error('[i18n] Missing keys in en.json:');
    for (const key of missingInEn) console.error(`- ${key}`);
  }
  if (missingInZh.length) {
    console.error('[i18n] Missing keys in zh.json:');
    for (const key of missingInZh) console.error(`- ${key}`);
  }
  if (missingZhFromEn.length) {
    console.error('[i18n] zh.json is missing keys present in en.json:');
    for (const key of missingZhFromEn) console.error(`- ${key}`);
  }
  if (staticDefaults.length) {
    console.error('[i18n] Static translation defaultValue entries must be moved to locale files:');
    for (const item of staticDefaults.slice(0, 200)) {
      const relativePath = path.relative(appRootDir, item.filePath);
      console.error(`- ${relativePath}:${item.line}:${item.column} ${item.key}`);
    }
    if (staticDefaults.length > 200) {
      console.error(`... and ${staticDefaults.length - 200} more`);
    }
  }

  process.exit(1);
}

main();
