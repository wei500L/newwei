const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getPropName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function listSourceFiles(rootDir) {
  const results = [];
  const ignored = new Set(['node_modules', '.next', 'dist', 'build', 'out', '.turbo']);

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
  if (ts.isNoSubstitutionTemplateLiteral(templateNode)) {
    return templateNode.text;
  }

  if (!ts.isTemplateExpression(templateNode)) {
    return null;
  }

  let result = templateNode.head.text;
  for (const span of templateNode.templateSpans) {
    const expressionText = span.expression.getText(sourceFile).trim();
    const mapped = optionsMap.get(expressionText);
    const placeholder =
      (mapped || expressionText)
        .replace(/[^a-zA-Z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'value';
    result += `{{${placeholder}}}`;
    result += span.literal.text;
  }

  return result;
}

function extractDefaultString(callExpression, sourceFile) {
  const [_, arg1, arg2] = callExpression.arguments;

  const optionsObjectLiteral =
    arg1 && ts.isObjectLiteralExpression(arg1)
      ? arg1
      : arg2 && ts.isObjectLiteralExpression(arg2)
        ? arg2
        : null;
  const optionsMap = buildOptionsMap(optionsObjectLiteral, sourceFile);

  // t('key', 'Default') / t('key', `Default ${x}`, { x })
  if (
    arg1 &&
    (ts.isStringLiteralLike(arg1) ||
      ts.isNoSubstitutionTemplateLiteral(arg1) ||
      ts.isTemplateExpression(arg1))
  ) {
    if (ts.isStringLiteralLike(arg1)) return arg1.text;
    return templateToI18nString(arg1, sourceFile, optionsMap);
  }

  // t('key', { defaultValue: 'Default' })
  if (arg1 && ts.isObjectLiteralExpression(arg1)) {
    for (const prop of arg1.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const propName = getPropName(prop.name);
      if (propName !== 'defaultValue') continue;
      const init = prop.initializer;
      if (ts.isStringLiteralLike(init)) return init.text;
      if (ts.isNoSubstitutionTemplateLiteral(init) || ts.isTemplateExpression(init)) {
        return templateToI18nString(init, sourceFile, optionsMap);
      }
    }
  }

  return null;
}

function collectTranslationKeys(appRootDir) {
  const sourceFiles = listSourceFiles(appRootDir);
  const keys = new Map();

  for (const filePath of sourceFiles) {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      kind
    );

    const visit = (node) => {
      if (ts.isCallExpression(node) && isTranslateCallExpression(node.expression)) {
        const arg0 = node.arguments[0];
        if (arg0 && ts.isStringLiteralLike(arg0)) {
          const key = arg0.text;
          const defaultValue = extractDefaultString(node, sourceFile);
          const entry = keys.get(key) || { defaults: new Set(), files: new Set() };
          if (defaultValue) entry.defaults.add(defaultValue);
          entry.files.add(filePath);
          keys.set(key, entry);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return keys;
}

function flattenKeys(object, prefix = '') {
  const result = new Set();
  for (const [key, value] of Object.entries(object || {})) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      for (const nested of flattenKeys(value, pathKey)) result.add(nested);
      continue;
    }
    result.add(pathKey);
  }
  return result;
}

function hasTranslationKey(flattenedKeys, key) {
  if (flattenedKeys.has(key)) return true;
  for (const candidate of flattenedKeys) {
    if (candidate.startsWith(`${key}_`)) return true;
  }
  return false;
}

function getDeepOwn(object, pathKey) {
  const parts = pathKey.split('.');
  let current = object;
  for (const part of parts) {
    if (!isPlainObject(current)) return undefined;
    if (!hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function setDeepIfMissing(object, pathKey, value) {
  const parts = pathKey.split('.');
  let current = object;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const isLeaf = index === parts.length - 1;
    if (isLeaf) {
      if (!hasOwn(current, part)) current[part] = value;
      return { ok: true };
    }

    if (!hasOwn(current, part)) {
      current[part] = {};
    } else if (!isPlainObject(current[part])) {
      return {
        ok: false,
        reason: `Cannot create nested key under non-object value at ${parts
          .slice(0, index + 1)
          .join('.')}`,
      };
    }
    current = current[part];
  }

  return { ok: true };
}

function findPrefixConflicts(keys) {
  const list = [...keys].sort();
  const conflicts = [];
  for (let i = 0; i < list.length; i++) {
    const key = list[i];
    const prefix = `${key}.`;
    if (list.some((candidate) => candidate.startsWith(prefix))) {
      conflicts.push(key);
    }
  }
  return conflicts;
}

module.exports = {
  collectTranslationKeys,
  findPrefixConflicts,
  flattenKeys,
  getDeepOwn,
  hasTranslationKey,
  isPlainObject,
  setDeepIfMissing,
};
