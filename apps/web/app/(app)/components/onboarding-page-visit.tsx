"use client";

import { Tour } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from "react";

import {
  ONBOARDING_MODE_QUERY_KEY,
  ONBOARDING_TOUR_QUERY_KEY,
  type OnboardingStepKey,
} from "@/lib/onboarding";

import { useOnboarding } from "./onboarding-boundary";

interface OnboardingPageVisitProps extends PropsWithChildren {
  step: OnboardingStepKey;
  title: string;
  description: ReactNode;
}

export function OnboardingPageVisit({
  children,
  description,
  step,
  title,
}: OnboardingPageVisitProps) {
  const { ready, settings, markChecklistVisited, completeTour } = useOnboarding();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const targetRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!ready) {
      return;
    }
    markChecklistVisited(step);
  }, [markChecklistVisited, ready, step]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const requestedTour = searchParams.get(ONBOARDING_TOUR_QUERY_KEY);
    const shouldOpen = requestedTour === step && settings.completedTours[step] !== true;
    setOpen(shouldOpen);
  }, [ready, searchParams, settings.completedTours, step]);

  const handleFinish = () => {
    setOpen(false);
    completeTour(step);

    const next = new URLSearchParams(searchParams.toString());
    next.delete(ONBOARDING_TOUR_QUERY_KEY);
    next.delete(ONBOARDING_MODE_QUERY_KEY);
    const nextQuery = next.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    });
  };

  return (
    <>
      <div ref={targetRef}>{children}</div>
      <Tour
        open={open}
        onClose={handleFinish}
        steps={[
          {
            title,
            description,
            target: () => targetRef.current ?? document.body,
          },
        ]}
      />
    </>
  );
}
