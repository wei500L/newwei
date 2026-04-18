import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appLayoutPath = path.resolve(__dirname, "../app/(app)/layout.tsx");
const loginPagePath = path.resolve(__dirname, "../app/(auth)/login/page.tsx");
const welcomePagePath = path.resolve(__dirname, "../app/(app)/welcome/page.tsx");

describe("onboarding flow wiring", () => {
  it("wraps the authenticated shell with the onboarding boundary", () => {
    const source = fs.readFileSync(appLayoutPath, "utf8");

    expect(source).toContain('import { OnboardingBoundary } from "./components/onboarding-boundary";');
    expect(source).toContain("<OnboardingBoundary>{children}</OnboardingBoundary>");
  });

  it("sends fresh logins to the welcome route by default", () => {
    const source = fs.readFileSync(loginPagePath, "utf8");

    expect(source).toContain('const redirectTo = searchParams.get("callbackUrl") ?? "/welcome";');
  });

  it("offers onboarding links into today, events, map, and finance", () => {
    const source = fs.readFileSync(welcomePagePath, "utf8");

    expect(source).toContain('/today?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=today');
    expect(source).toContain('/events?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=events');
    expect(source).toContain('/map?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=map');
    expect(source).toContain('/finance?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=finance');
  });
});
