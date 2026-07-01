import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "..");
const i18nCheckPath = path.resolve(appRoot, "scripts/i18n-check.js");

describe("i18n coverage", () => {
  it("keeps locale keys complete and static defaultValue copy out of t() calls", () => {
    expect(() => {
      execFileSync(process.execPath, [i18nCheckPath], {
        cwd: appRoot,
        stdio: "pipe",
      });
    }).not.toThrow();
  });
});
