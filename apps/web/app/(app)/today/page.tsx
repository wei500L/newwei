import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { OnboardingPageVisit } from "../components/onboarding-page-visit";
import { TodayContent } from "./today-content";

export default async function TodayPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return (
    <OnboardingPageVisit
      step="today"
      title="Daily briefing"
      description="This page is the fastest way to understand what changed today before you branch into deeper views."
    >
      <TodayContent />
    </OnboardingPageVisit>
  );
}
