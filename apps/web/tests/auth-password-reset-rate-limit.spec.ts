import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

describe("forgot password rate limit handling", () => {
  it("surfaces rate-limited reset requests distinctly", () => {
    const source = read("app/(auth)/forgot-password/page.tsx");

    expect(source).toContain("classifyRequestError(error).kind === \"rateLimit\"");
    expect(source).toContain("Too many reset requests. Please try again later.");
    expect(source).toContain("Failed to request password reset");
  });
});
