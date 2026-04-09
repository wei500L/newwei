import 'reflect-metadata';

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

describe('graphql model initialization', () => {
  const hasDecorators = (node: ts.Node): boolean => {
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    return Boolean(decorators && decorators.length > 0);
  };

  const collectTypeRefs = (typeNode: ts.TypeNode, refs: string[] = []): string[] => {
    if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
      refs.push(typeNode.typeName.text);
      return refs;
    }

    if (ts.isArrayTypeNode(typeNode)) {
      return refs;
    }

    if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
      for (const inner of typeNode.types) {
        collectTypeRefs(inner, refs);
      }
      return refs;
    }

    if (ts.isParenthesizedTypeNode(typeNode)) {
      return collectTypeRefs(typeNode.type, refs);
    }

    return refs;
  };

  it('does not reference class types before declaration in decorated model fields', () => {
    const modelsDir = __dirname;
    const modelFiles = readdirSync(modelsDir)
      .filter((fileName) => fileName.endsWith('.model.ts'))
      .sort();

    const violations: string[] = [];

    for (const fileName of modelFiles) {
      const filePath = path.join(modelsDir, fileName);
      const sourceText = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const classPositions = new Map<string, number>();

      sourceFile.forEachChild((node) => {
        if (ts.isClassDeclaration(node) && node.name) {
          classPositions.set(node.name.text, node.pos);
        }
      });

      const walk = (node: ts.Node, currentClass: string | null): void => {
        let className = currentClass;

        if (ts.isClassDeclaration(node) && node.name) {
          className = node.name.text;
        }

        if (
          className &&
          ts.isPropertyDeclaration(node) &&
          hasDecorators(node) &&
          node.type &&
          !ts.isArrayTypeNode(node.type)
        ) {
          for (const ref of collectTypeRefs(node.type)) {
            const refPos = classPositions.get(ref);
            if (refPos !== undefined && refPos > node.pos) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.pos);
              const propName = node.name.getText(sourceFile);
              violations.push(
                `${fileName}:${line + 1} ${className}.${propName} references ${ref} before declaration`
              );
            }
          }
        }

        ts.forEachChild(node, (child) => walk(child, className));
      };

      walk(sourceFile, null);
    }

    expect(violations).toEqual([]);
  });
});
