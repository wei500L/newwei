import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const dashboardContentPath = path.resolve(
  __dirname,
  '../app/(app)/dashboard/dashboard-content.tsx',
);

const collectBindingNames = (name: ts.BindingName, bindings: Set<string>) => {
  if (ts.isIdentifier(name)) {
    bindings.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    collectBindingNames(element.name, bindings);
  }
};

const collectTopLevelBindings = (sourceFile: ts.SourceFile) => {
  const bindings = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) {
        continue;
      }
      if (clause.name) {
        bindings.add(clause.name.text);
      }
      const namedBindings = clause.namedBindings;
      if (!namedBindings) {
        continue;
      }
      if (ts.isNamespaceImport(namedBindings)) {
        bindings.add(namedBindings.name.text);
        continue;
      }
      for (const element of namedBindings.elements) {
        bindings.add(element.name.text);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, bindings);
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      bindings.add(statement.name.text);
    }
  }

  return bindings;
};

describe('dashboard-content realtime constants', () => {
  it('does not reference undeclared DASHBOARD_* constants', () => {
    const sourceText = fs.readFileSync(dashboardContentPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      dashboardContentPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const bindings = collectTopLevelBindings(sourceFile);
    const referencedConstants = new Set<string>();

    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text.startsWith('DASHBOARD_')) {
        referencedConstants.add(node.text);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    const undeclared = [...referencedConstants].filter((name) => !bindings.has(name));

    expect(undeclared).toEqual([]);
  });
});
