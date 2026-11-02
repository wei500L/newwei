"use client";

import { Button } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { usePageTitle } from "@/hooks/use-page-title";
import {
  ONBOARDING_MODE_QUERY_KEY,
  ONBOARDING_TOUR_QUERY_KEY,
  ONBOARDING_STEPS,
  type OnboardingStepKey,
} from "@/lib/onboarding";

import { useOnboarding } from "../components/onboarding-boundary";

const STEP_ROUTES: Record<OnboardingStepKey, string> = {
  today: `/today?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=today`,
  events: `/events?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=events`,
  map: `/map?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=map`,
  finance: `/finance?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=finance`,
};

export default function WelcomePage() {
  const router = useRouter();
  const { t } = useTranslation();
  usePageTitle(t("pages.welcome.title"));
  const { settings, completeOnboarding, dismissOnboarding } = useOnboarding();
  const completedCount = ONBOARDING_STEPS.filter((step) => settings.checklist[step]).length;
  const progress = Math.round((completedCount / ONBOARDING_STEPS.length) * 100);
  const stepCopy: Record<
    OnboardingStepKey,
    { label: string; title: string; description: string; href: string }
  > = {
    today: {
      label: t("pages.welcome.steps.today.label"),
      title: t("pages.welcome.steps.today.title"),
      description: t("pages.welcome.steps.today.description"),
      href: STEP_ROUTES.today,
    },
    events: {
      label: t("pages.welcome.steps.events.label"),
      title: t("pages.welcome.steps.events.title"),
      description: t("pages.welcome.steps.events.description"),
      href: STEP_ROUTES.events,
    },
    map: {
      label: t("pages.welcome.steps.map.label"),
      title: t("pages.welcome.steps.map.title"),
      description: t("pages.welcome.steps.map.description"),
      href: STEP_ROUTES.map,
    },
    finance: {
      label: t("pages.welcome.steps.finance.label"),
      title: t("pages.welcome.steps.finance.title"),
      description: t("pages.welcome.steps.finance.description"),
      href: STEP_ROUTES.finance,
    },
  };

  return (
    <section
      id="welcome-main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-8"
      aria-labelledby="welcome-title"
    >
      <a
        href="#welcome-content"
        className="sr-only focus:not-sr-only focus:rounded-full focus:bg-[var(--surface)] focus:px-4 focus:py-2"
      >
        {t("pages.welcome.skipToChecklist")}
      </a>

      <section className="content-card p-6 sm:p-8">
        <p className="kicker">
          {t("pages.welcome.eyebrow")}
        </p>
        <h1
          id="welcome-title"
          className="m-0 mt-2 max-w-3xl font-serif text-3xl font-semibold leading-tight text-[var(--foreground)] sm:text-4xl"
        >
          {t("pages.welcome.title")}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-8 text-muted-foreground">
          {t("pages.welcome.description")}
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <div className="surface-inset min-w-[14rem] flex-1">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{t("pages.welcome.progress")}</span>
              <span>{completedCount}/{ONBOARDING_STEPS.length}</span>
            </div>
            <div className="mt-3 h-2 rounded-full bg-[var(--border)]">
              <div
                className="h-2 rounded-full bg-[var(--foreground)] transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          <Button
            type="primary"
            onClick={() => {
              completeOnboarding();
              router.push("/today");
            }}
          >
            {t("pages.welcome.enterWorkspace")}
          </Button>
          <Button
            onClick={() => {
              dismissOnboarding();
              router.push("/today");
            }}
          >
            {t("pages.welcome.skipForNow")}
          </Button>
        </div>
      </section>

      <section id="welcome-content" className="grid gap-5 md:grid-cols-2">
        {ONBOARDING_STEPS.map((step) => {
          const entry = stepCopy[step];
          const done = settings.checklist[step];

          return (
            <Link
              key={step}
              href={entry.href}
              className="group rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 transition hover:-translate-y-0.5 hover:border-[var(--border-strong)]"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="kicker">
                  {entry.label}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${
                    done
                      ? "text-[var(--bullish)]"
                      : "bg-[var(--surface-muted)] text-muted-foreground"
                  }`}
                >
                  {done ? t("pages.welcome.status.done") : t("pages.welcome.status.start")}
                </span>
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-[var(--foreground)]">
                {entry.title}
              </h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                {entry.description}
              </p>
            </Link>
          );
        })}
      </section>
    </section>
  );
}
