"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  ONBOARDING_MODE_QUERY_KEY,
  ONBOARDING_TOUR_QUERY_KEY,
  ONBOARDING_STEPS,
  type OnboardingStepKey,
} from "@/lib/onboarding";

import { useOnboarding } from "../components/onboarding-boundary";

const STEP_COPY: Record<
  OnboardingStepKey,
  { title: string; description: string; href: string }
> = {
  today: {
    title: "Read the daily briefing",
    description: "Start with the curated overview that pulls the most important updates into one page.",
    href: `/today?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=today`,
  },
  events: {
    title: "Review live events",
    description: "See how the event model groups coverage, confidence, and corroboration into one feed.",
    href: `/events?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=events`,
  },
  map: {
    title: "Scan the map",
    description: "Open the regional map to understand where alerts and geo-linked news are accumulating.",
    href: `/map?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=map`,
  },
  finance: {
    title: "Check market signals",
    description: "Inspect the finance workspace for macro pulse, sector heat, and candlestick context.",
    href: `/finance?${ONBOARDING_MODE_QUERY_KEY}=1&${ONBOARDING_TOUR_QUERY_KEY}=finance`,
  },
};

export default function WelcomePage() {
  const router = useRouter();
  const { settings, completeOnboarding, dismissOnboarding } = useOnboarding();
  const completedCount = ONBOARDING_STEPS.filter((step) => settings.checklist[step]).length;
  const progress = Math.round((completedCount / ONBOARDING_STEPS.length) * 100);

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
        Skip to checklist
      </a>

      <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-[linear-gradient(135deg,rgba(14,165,233,0.10),rgba(249,115,22,0.10),rgba(255,255,255,0.92))] p-6 shadow-[0_24px_80px_-44px_rgba(15,23,42,0.45)] sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.26em] text-cyan-700">
          Onboarding
        </p>
        <h1
          id="welcome-title"
          className="mt-3 max-w-3xl text-balance text-3xl font-semibold tracking-tight text-slate-950 sm:text-5xl"
        >
          Learn the workspace in four short stops.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-8 text-slate-600">
          The workspace is data-dense by design. This guide pushes you through the pages that matter most so the rest of the console feels predictable.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <div className="min-w-[14rem] flex-1 rounded-[1.4rem] border border-slate-200 bg-white/80 p-4">
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>Progress</span>
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
            Enter workspace
          </button>
          <button
            type="button"
            onClick={() => {
              dismissOnboarding();
              router.push("/today");
            }}
            className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-950"
          >
            Skip for now
          </button>
        </div>
      </section>

      <section id="welcome-content" className="grid gap-5 md:grid-cols-2">
        {ONBOARDING_STEPS.map((step) => {
          const entry = STEP_COPY[step];
          const done = settings.checklist[step];

          return (
            <Link
              key={step}
              href={entry.href}
              className="group rounded-[1.5rem] border border-slate-200 bg-white/88 p-5 shadow-[0_18px_50px_-38px_rgba(15,23,42,0.35)] transition hover:-translate-y-0.5 hover:border-slate-900"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
                  {step}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${
                    done
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {done ? "Done" : "Start"}
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
