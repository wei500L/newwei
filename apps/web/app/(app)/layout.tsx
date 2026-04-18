import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AuraBackground } from "@/components/aura-background";
import { auth } from "@/lib/auth";

import { OnboardingBoundary } from "./components/onboarding-boundary";
import { ShellLayout } from "./components/shell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return (
    <>
      <AuraBackground />
      <ShellLayout>
        <OnboardingBoundary>{children}</OnboardingBoundary>
      </ShellLayout>
    </>
  );
}
