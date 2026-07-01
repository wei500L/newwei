import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appLayoutPath = path.resolve(__dirname, "../app/(app)/layout.tsx");
const loginPagePath = path.resolve(__dirname, "../app/(auth)/login/page.tsx");
const onboardingBoundaryPath = path.resolve(
  __dirname,
  "../app/(app)/components/onboarding-boundary.tsx",
);
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

  it("localizes the welcome copy through i18n resources", () => {
    const source = fs.readFileSync(welcomePagePath, "utf8");

    expect(source).toContain('import { useTranslation } from "react-i18next";');
    expect(source).toContain("const { t } = useTranslation();");
    expect(source).toContain('t("pages.welcome.title")');
    expect(source).not.toContain("Read the daily briefing");
    expect(source).not.toContain("Learn the workspace in four short stops.");
    expect(source).not.toContain("Enter workspace");
  });

  it("does not clear a skipped onboarding dismissal when a guided page is visited", () => {
    const source = fs.readFileSync(onboardingBoundaryPath, "utf8");
    const markChecklistSection =
      source.split("markChecklistVisited: (step) => {")[1]?.split("completeTour: (step) => {")[0] ??
      "";

    expect(markChecklistSection).not.toContain("dismissed: false");
  });
});
