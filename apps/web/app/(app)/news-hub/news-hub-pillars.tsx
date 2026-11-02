"use client";

import Link from "next/link";
import { useTranslation } from "react-i18next";

const pillars = [
  {
    href: "/newsnow/hottest",
    titleKey: "newsHub.pillars.newsnow.title",
    descriptionKey: "newsHub.pillars.newsnow.description",
    ctaKey: "newsHub.pillars.newsnow.cta",
  },
  {
    href: "/items",
    titleKey: "newsHub.pillars.items.title",
    descriptionKey: "newsHub.pillars.items.description",
    ctaKey: "newsHub.pillars.items.cta",
  },
  {
    href: "/events",
    titleKey: "newsHub.pillars.events.title",
    descriptionKey: "newsHub.pillars.events.description",
    ctaKey: "newsHub.pillars.events.cta",
  },
];

export function NewsHubPillars() {
  const { t } = useTranslation();
  return (
    <section className="grid grid-cols-1 gap-0 border-t-2 border-[var(--foreground)] md:grid-cols-3">
      {pillars.map((pillar, index) => (
        <article
          key={pillar.href}
          className={
            index === 0
              ? "flex flex-col gap-2 py-5 md:pr-6"
              : "flex flex-col gap-2 border-t border-[var(--border)] py-5 md:border-l md:border-t-0 md:px-6"
          }
        >
          <span className="kicker">{String(index + 1).padStart(2, "0")}</span>
          <h2 className="font-serif text-lg font-semibold text-[var(--foreground)]">{t(pillar.titleKey)}</h2>
          <p className="text-sm leading-6 text-[var(--muted-foreground)]">{t(pillar.descriptionKey)}</p>
          <Link href={pillar.href} className="mt-auto text-sm font-medium text-[var(--primary)] hover:underline">
            {t(pillar.ctaKey)} →
          </Link>
        </article>
      ))}
    </section>
  );
}
