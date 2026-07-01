import { OnboardingPageVisit } from "../components/onboarding-page-visit";

import { MarketContent } from "./market-content";

export default function FinancePage() {
  return (
    <OnboardingPageVisit
      step="finance"
      title="Market overview"
      description="This surface links macro context to market movement so you can compare news intensity with price behavior."
    >
      <MarketContent />
    </OnboardingPageVisit>
  );
}
