import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkGevImports } from "./globe-check-imports.mjs";

const cleanup = [];

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop(), { recursive: true, force: true });
  }
});

function makeFixture({ appFiles, vendorFiles }) {
  const root = mkdtempSync(join(tmpdir(), "gev-check-imports-"));
  cleanup.push(root);
  const appRoots = [join(root, "app")];
  const vendorSrc = join(root, "vendor", "gods-eye-view", "src");

  for (const [relativePath, content] of Object.entries(appFiles)) {
    const target = join(appRoots[0], relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  for (const [relativePath, content] of Object.entries(vendorFiles)) {
    const target = join(vendorSrc, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  return { appRoots, vendorSrc };
}

describe("checkGevImports", () => {
  it("遇到 .vue 时失败并给出完整链路", () => {
    const { appRoots, vendorSrc } = makeFixture({
      appFiles: {
        "page.ts": 'import { createScene } from "@gev/app/entry";\n',
      },
      vendorFiles: {
        "app/entry.js": 'export { thing } from "./widget.js";\n',
        "app/widget.js": 'import "./Thing.vue";\n',
        "app/Thing.vue": "<template><div /></template>\n",
      },
    });

    const result = checkGevImports({ appRoots, vendorSrc });

    expect(result.entries).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toContain(".vue");
    expect(result.failures[0].chain).toEqual([
      "app/entry.js",
      "app/widget.js",
      "app/Thing.vue",
    ]);
  });

  it("遇到黑名单模块时失败", () => {
    const { appRoots, vendorSrc } = makeFixture({
      appFiles: {
        "page.ts": 'const module = await import("@gev/app/entry");\n',
      },
      vendorFiles: {
        "app/entry.js": 'import { data } from "./data.js";\n',
        "app/data.js": "export const data = 1;\n",
      },
    });

    const result = checkGevImports({ appRoots, vendorSrc });

    expect(result.entries).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toContain("黑名单");
    expect(result.failures[0].chain).toEqual(["app/entry.js", "app/data.js"]);
  });

  it("干净链路时成功（裸包名不跟随）", () => {
    const { appRoots, vendorSrc } = makeFixture({
      appFiles: {
        "page.ts": 'import "@gev/app/entry";\n',
      },
      vendorFiles: {
        "app/entry.js":
          'import { util } from "./util.js";\nimport * as Cesium from "cesium";\nexport const x = util;\n',
        "app/util.js": "export const util = 1;\n",
      },
    });

    const result = checkGevImports({ appRoots, vendorSrc });

    expect(result.entries).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("没有任何 @gev 引用时返回 0 entries", () => {
    const { appRoots, vendorSrc } = makeFixture({
      appFiles: {
        "page.ts": "export const answer = 42;\n",
      },
      vendorFiles: {},
    });

    const result = checkGevImports({ appRoots, vendorSrc });

    expect(result.entries).toBe(0);
    expect(result.failures).toEqual([]);
  });
});
