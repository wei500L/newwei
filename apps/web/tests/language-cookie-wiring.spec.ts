import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const i18nPath = path.resolve(__dirname, "../lib/i18n.ts");
const rootLayoutPath = path.resolve(__dirname, "../app/layout.tsx");

describe("language cookie wiring", () => {
  it("persists the selected language to a cookie", () => {
    const source = fs.readFileSync(i18nPath, "utf8");

    expect(source).toContain('export const LANGUAGE_COOKIE_KEY = "language";');
    expect(source).toContain("document.cookie = `${LANGUAGE_COOKIE_KEY}=${encodeURIComponent(next)}; path=/; max-age=31536000; samesite=lax`;");
  });

  it("hydrates the html lang attribute from the language cookie on the server", () => {
    const source = fs.readFileSync(rootLayoutPath, "utf8");

    expect(source).toContain('import { cookies } from "next/headers";');
    expect(source).toContain("const htmlLang = resolveLocale(cookieStore.get(LANGUAGE_COOKIE_KEY)?.value);");
    expect(source).toContain("<html lang={htmlLang} suppressHydrationWarning>");
  });
});
