"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

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
    <main
      id="welcome-main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-8"
      aria-labelledby="welcome-title"
    >
      <a
        href="#welcome-content"
        className="sr-only focus:not-sr-only focus:rounded-full focus:bg-white focus:px-4 focus:py-2"
      >
        {t("pages.welcome.skipToChecklist")}
      </a>

      <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-[linear-gradient(135deg,rgba(14,165,233,0.10),rgba(249,115,22,0.10),rgba(255,255,255,0.92))] p-6 shadow-[0_24px_80px_-44px_rgba(15,23,42,0.45)] sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.26em] text-cyan-700">
          {t("pages.welcome.eyebrow")}
        </p>
        <h1
          id="welcome-title"
          className="mt-3 max-w-3xl text-balance text-3xl font-semibold tracking-tight text-slate-950 sm:text-5xl"
        >
          {t("pages.welcome.title")}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-8 text-slate-600">
          {t("pages.welcome.description")}
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <div className="min-w-[14rem] flex-1 rounded-[1.4rem] border border-slate-200 bg-white/80 p-4">
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>{t("pages.welcome.progress")}</span>
              <span>{completedCount}/{ONBOARDING_STEPS.length}</span>
            </div>
            <div className="mt-3 h-2 rounded-full bg-slate-200">
              <div
                className="h-2 rounded-full bg-slate-950 transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              completeOnboarding();
              router.push("/today");
            }}
            className="rounded-full bg-slate-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            {t("pages.welcome.enterWorkspace")}
          </button>
          <button
            type="button"
            onClick={() => {
              dismissOnboarding();
              router.push("/today");
            }}
            className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-950"
          >
            {t("pages.welcome.skipForNow")}
          </button>
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
              className="group rounded-[1.5rem] border border-slate-200 bg-white/88 p-5 shadow-[0_18px_50px_-38px_rgba(15,23,42,0.35)] transition hover:-translate-y-0.5 hover:border-slate-900"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
                  {entry.label}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${
                    done
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {done ? t("pages.welcome.status.done") : t("pages.welcome.status.start")}
                </span>
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-slate-950">
                {entry.title}
              </h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                {entry.description}
              </p>
            </Link>
          );
        })}
      </section>
    </main>
  );
}
