import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("vector service diagnostics wiring", () => {
  it("loads runtime diagnostics alongside settings", () => {
    const source = read("components/settings/vector-service-settings-panel.tsx");

    expect(source).toContain("system-settings/vector-service/diagnostics");
    expect(source).toContain("Runtime diagnostics");
    expect(source).toContain("Consecutive failures");
  });
});
