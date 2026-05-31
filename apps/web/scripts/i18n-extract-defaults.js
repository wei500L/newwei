const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const ts = require('typescript');

const {
  getDeepOwn,
  isPlainObject,
  setDeepIfMissing,
} = require('./i18n-utils');

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has('--write');
const copyEnToZh = args.has('--copy-en-to-zh');

function getPropName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function listSourceFiles(rootDir) {
  const results = [];
  const ignored = new Set(['node_modules', '.next', '.next-docker', 'dist', 'build', 'out', '.turbo']);

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (ignored.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      results.push(path.join(dir, entry.name));
    }
  }

  walk(rootDir);
  return results;
}

function isTranslateCallExpression(expression) {
  return (
    (ts.isIdentifier(expression) && expression.text === 't') ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === 't')
  );
}

function buildOptionsMap(optionsObjectLiteral, sourceFile) {
  const map = new Map();
  if (!optionsObjectLiteral) return map;
  for (const prop of optionsObjectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const propName = getPropName(prop.name);
    if (!propName || propName === 'defaultValue') continue;
    map.set(prop.initializer.getText(sourceFile).trim(), propName);
  }
  return map;
}

function templateToI18nString(templateNode, sourceFile, optionsMap) {
  let result = templateNode.head.text;
  for (const span of templateNode.templateSpans) {
    const expressionText = span.expression.getText(sourceFile).trim();
    const mapped = optionsMap.get(expressionText);
    if (!mapped) return null;
    result += `{{${mapped}}}`;
    result += span.literal.text;
  }
  return result;
}

function getStaticDefaultValue(node, sourceFile, optionsMap) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return templateToI18nString(node, sourceFile, optionsMap);
  return null;
}

function getDefaultValueProperty(objectLiteral) {
  return objectLiteral.properties.find(
    (prop) => ts.isPropertyAssignment(prop) && getPropName(prop.name) === 'defaultValue'
  );
}

function getLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function findCommaBefore(text, start, floor) {
  for (let index = start - 1; index >= floor; index--) {
    const char = text[index];
    if (char === ',') return index;
    if (!/\s/.test(char)) break;
  }
  return -1;
}

function findCommaAfter(text, start, ceiling) {
  for (let index = start; index < ceiling; index++) {
    const char = text[index];
    if (char === ',') return index;
    if (!/\s/.test(char)) break;
  }
  return -1;
}

function removePropertyEdit(text, prop, objectLiteral) {
  const nextComma = findCommaAfter(text, prop.getEnd(), objectLiteral.getEnd());
  if (nextComma !== -1) {
    return { start: prop.getFullStart(), end: nextComma + 1 };
  }

  const previousComma = findCommaBefore(text, prop.getFullStart(), objectLiteral.getStart());
  if (previousComma !== -1) {
    return { start: previousComma, end: prop.getEnd() };
  }

  return { start: prop.getFullStart(), end: prop.getEnd() };
}

function removeArgumentEdit(text, callExpression, argIndex) {
  const argsList = callExpression.arguments;
  const arg = argsList[argIndex];
  const previousArgEnd = argIndex > 0 ? argsList[argIndex - 1].getEnd() : callExpression.expression.getEnd();
  const start = findCommaBefore(text, arg.getFullStart(), previousArgEnd);
  if (start === -1) return null;

  if (argIndex < argsList.length - 1) {
    const nextArg = argsList[argIndex + 1];
    const end = findCommaBefore(text, nextArg.getFullStart(), arg.getEnd());
    return end === -1 ? null : { start, end };
  }

  return { start, end: arg.getEnd() };
}

function collectFileChanges(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, kind);
  const edits = [];
  const defaults = [];
  const skipped = [];

  function recordDefault(callExpression, key, defaultValue, edit, line) {
    if (!edit) {
      skipped.push({ filePath, key, line, reason: 'Unable to calculate edit range' });
      return;
    }
    defaults.push({ key, defaultValue, filePath, line });
    edits.push(edit);
  }

  function visit(node) {
    if (ts.isCallExpression(node) && isTranslateCallExpression(node.expression)) {
      const [arg0, arg1, arg2] = node.arguments;
      if (arg0 && ts.isStringLiteralLike(arg0)) {
        const key = arg0.text;

        if (
          arg1 &&
          (ts.isStringLiteralLike(arg1) ||
            ts.isNoSubstitutionTemplateLiteral(arg1) ||
            ts.isTemplateExpression(arg1))
        ) {
          const optionsObjectLiteral = arg2 && ts.isObjectLiteralExpression(arg2) ? arg2 : null;
          const defaultValue = getStaticDefaultValue(
            arg1,
            sourceFile,
            buildOptionsMap(optionsObjectLiteral, sourceFile)
          );
          if (defaultValue != null) {
            recordDefault(
              node,
              key,
              defaultValue,
              removeArgumentEdit(sourceText, node, 1),
              getLine(sourceFile, arg1)
            );
          }
        }

        for (let argIndex = 1; argIndex < node.arguments.length; argIndex++) {
          const arg = node.arguments[argIndex];
          if (!ts.isObjectLiteralExpression(arg)) continue;
          const defaultValueProp = getDefaultValueProperty(arg);
          if (!defaultValueProp) continue;
          const defaultValue = getStaticDefaultValue(
            defaultValueProp.initializer,
            sourceFile,
            buildOptionsMap(arg, sourceFile)
          );
          if (defaultValue == null) continue;

          const hasOtherProperties = arg.properties.some((prop) => prop !== defaultValueProp);
          const edit = hasOtherProperties
            ? removePropertyEdit(sourceText, defaultValueProp, arg)
            : removeArgumentEdit(sourceText, node, argIndex);
          recordDefault(node, key, defaultValue, edit, getLine(sourceFile, defaultValueProp));
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { sourceText, edits, defaults, skipped };
}

function applyEdits(sourceText, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let output = sourceText;
  let previousStart = Number.POSITIVE_INFINITY;

  for (const edit of sorted) {
    if (edit.end > previousStart) {
      throw new Error(`Overlapping edit range ${edit.start}-${edit.end}`);
    }
    output = `${output.slice(0, edit.start)}${output.slice(edit.end)}`;
    previousStart = edit.start;
  }

  return output;
}

function main() {
  const appRootDir = path.join(__dirname, '..');
  const localesDir = path.join(appRootDir, 'lib', 'locales');
  const enPath = path.join(localesDir, 'en.json');
  const zhPath = path.join(localesDir, 'zh.json');
  const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(zhPath, 'utf8'));

  const sourceFiles = listSourceFiles(appRootDir);
  const fileChanges = [];
  const defaults = [];
  const skipped = [];
  const conflicts = [];
  const missingZh = [];
  let enAdded = 0;
  let zhAdded = 0;

  for (const filePath of sourceFiles) {
    const change = collectFileChanges(filePath);
    if (change.edits.length) fileChanges.push({ filePath, ...change });
    defaults.push(...change.defaults);
    skipped.push(...change.skipped);
  }

  for (const item of defaults) {
    const existingEn = getDeepOwn(en, item.key);
    if (existingEn === undefined) {
      const result = setDeepIfMissing(en, item.key, item.defaultValue);
      if (!result.ok) {
        skipped.push({ ...item, reason: result.reason });
      } else {
        enAdded++;
      }
    } else if (existingEn !== item.defaultValue) {
      conflicts.push({ ...item, localeValue: existingEn });
    }

    if (getDeepOwn(zh, item.key) === undefined && getDeepOwn(en, item.key) !== undefined) {
      if (!copyEnToZh) {
        missingZh.push(item);
        continue;
      }
      const result = setDeepIfMissing(zh, item.key, item.defaultValue);
      if (!result.ok) {
        skipped.push({ ...item, reason: result.reason });
      } else {
        zhAdded++;
      }
    }
  }

  if (shouldWrite) {
    for (const change of fileChanges) {
      const next = applyEdits(change.sourceText, change.edits);
      if (next !== change.sourceText) fs.writeFileSync(change.filePath, next);
    }
    fs.writeFileSync(enPath, `${JSON.stringify(en, null, 2)}\n`);
    fs.writeFileSync(zhPath, `${JSON.stringify(zh, null, 2)}\n`);
  }

  console.log(
    `[i18n] Static defaults: ${defaults.length}; files: ${fileChanges.length}; en +${enAdded}; zh +${zhAdded}; conflicts ${conflicts.length}; skipped ${skipped.length}`
  );
  if (conflicts.length) {
    console.log('[i18n] Existing locale values kept for conflicting defaults:');
    for (const item of conflicts.slice(0, 50)) {
      console.log(
        `- ${path.relative(appRootDir, item.filePath)}:${item.line} ${item.key}: ${JSON.stringify(
          item.defaultValue
        )} -> ${JSON.stringify(item.localeValue)}`
      );
    }
    if (conflicts.length > 50) console.log(`... and ${conflicts.length - 50} more`);
  }
  if (skipped.length) {
    console.error('[i18n] Skipped entries:');
    for (const item of skipped.slice(0, 50)) {
      console.error(`- ${path.relative(appRootDir, item.filePath)}:${item.line} ${item.key}: ${item.reason}`);
    }
    if (skipped.length > 50) console.error(`... and ${skipped.length - 50} more`);
    process.exitCode = 1;
  }
  if (missingZh.length) {
    console.error('[i18n] Missing zh translations. Add translated zh.json values, or pass --copy-en-to-zh for a temporary legacy fallback:');
    for (const item of missingZh.slice(0, 80)) {
      console.error(`- ${item.key}: ${JSON.stringify(item.defaultValue)}`);
    }
    if (missingZh.length > 80) console.error(`... and ${missingZh.length - 80} more`);
    process.exitCode = 1;
  }
  if (!shouldWrite) {
    console.log('[i18n] Dry run only. Pass --write to update files.');
  }
}

main();
