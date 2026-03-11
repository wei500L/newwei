import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(repoRoot, relativePath), "utf8");

describe("shared auth session wiring", () => {
  it("routes apollo and api clients through the shared browser auth session module", () => {
    const apolloClientSource = read("lib/apollo-client.ts");
    const apiClientSource = read("lib/api-client.ts");

    expect(apolloClientSource).toContain("./browser-auth-session");
    expect(apiClientSource).toContain("./browser-auth-session");
    expect(apolloClientSource).not.toContain('from "next-auth/react"');
    expect(apiClientSource).not.toContain('from "next-auth/react"');
  });
});

describe("hero metrics wiring", () => {
  it("uses the shared hero metrics hook instead of direct GraphQL query hooks", () => {
    const files = [
      "app/(app)/dashboard/dashboard-content.tsx",
      "app/(app)/finance/market-overview.tsx",
      "app/(app)/components/ticker-tape.tsx",
    ];

    for (const file of files) {
      const source = read(file);
      expect(source).toContain("useHeroMetrics");
      expect(source).not.toContain("useDashboardHeroMetricsQuery");
    }
  });
});
