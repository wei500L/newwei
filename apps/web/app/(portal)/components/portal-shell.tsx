import Link from "next/link";
import type { ReactNode } from "react";

import type {
  PublicPortalChannelResponse,
  PublicPortalHomeResponse,
  PublicPortalStory,
  PublicPortalStoryResponse,
} from "@/lib/server-public-portal";

function formatTimestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatScore(value: number): string {
  return `${Math.round(value)}%`;
}

function PortalHeader(props: {
  ctaHref: string;
  ctaLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <header className="border-b border-black/10 bg-white/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div>
          <Link
            href="/"
            className="text-sm font-semibold uppercase tracking-[0.26em] text-slate-500"
          >
            Modular Public Briefing
          </Link>
          <p className="mt-1 text-sm text-slate-600">
            Public-facing news portal for fast situational awareness.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {props.secondaryHref && props.secondaryLabel ? (
            <Link
              href={props.secondaryHref}
              className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
            >
              {props.secondaryLabel}
            </Link>
          ) : null}
          <Link
            href={props.ctaHref}
            className="rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            {props.ctaLabel}
          </Link>
        </div>
      </div>
    </header>
  );
}

function StoryMeta({ story }: { story: PublicPortalStory }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
      <span>{story.topic}</span>
      <span aria-hidden="true">•</span>
      <span>{formatTimestamp(story.lastAt)}</span>
      <span aria-hidden="true">•</span>
      <span>{story.itemCount} sources</span>
      <span aria-hidden="true">•</span>
      <span>Credibility {formatScore(story.credibilityScore)}</span>
      {story.breaking ? (
        <>
          <span aria-hidden="true">•</span>
          <span className="text-rose-600">Breaking</span>
        </>
      ) : null}
    </div>
  );
}

export function PortalStoryCard(props: {
  story: PublicPortalStory;
  featured?: boolean;
}) {
  const baseClassName = props.featured
    ? "rounded-[2rem] border border-slate-200 bg-white/95 p-6 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.45)] sm:p-8"
    : "rounded-[1.6rem] border border-slate-200 bg-white/92 p-5 shadow-[0_18px_50px_-36px_rgba(15,23,42,0.4)]";

  return (
    <article className={baseClassName}>
      <StoryMeta story={props.story} />
      <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
        <Link href={`/article/${props.story.slug}`} className="hover:underline">
          {props.story.title}
        </Link>
      </h2>
      <p className="mt-4 text-sm leading-7 text-slate-600 sm:text-base">
        {props.story.summary}
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link
          href={`/article/${props.story.slug}`}
          className="rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          Read story
        </Link>
        <Link
          href={`/channel/${props.story.topicSlug}`}
          className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
        >
          More on {props.story.topic}
        </Link>
      </div>
    </article>
  );
}

function TopicLinks({ channels }: { channels: PublicPortalHomeResponse["channels"] }) {
  if (channels.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="portal-topics" className="mt-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">
            Channels
          </p>
          <h2
            id="portal-topics"
            className="mt-2 text-2xl font-semibold tracking-tight text-slate-950"
          >
            Browse by topic
          </h2>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        {channels.map((channel) => (
          <Link
            key={channel.topicSlug}
            href={`/channel/${channel.topicSlug}`}
            className="rounded-full border border-slate-300 bg-white/85 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-950"
          >
            {channel.topic} · {channel.storyCount}
          </Link>
        ))}
      </div>
    </section>
  );
}

function StoryGrid({ stories }: { stories: PublicPortalStory[] }) {
  if (stories.length === 0) {
    return (
      <div className="rounded-[1.6rem] border border-dashed border-slate-300 bg-white/70 p-8 text-sm text-slate-600">
        No public stories are available yet.
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {stories.map((story) => (
        <PortalStoryCard key={story.id} story={story} />
      ))}
    </div>
  );
}

export function PortalPageShell(props: {
  ctaHref: string;
  ctaLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(14,116,144,0.18),_transparent_34%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_52%,_#fff7ed_100%)] text-slate-950">
      <a
        href="#portal-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-white focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <PortalHeader
        ctaHref={props.ctaHref}
        ctaLabel={props.ctaLabel}
        secondaryHref={props.secondaryHref}
        secondaryLabel={props.secondaryLabel}
      />
      <main id="portal-main" className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        {props.children}
      </main>
    </div>
  );
}

export function PortalHomeView(props: {
  payload: PublicPortalHomeResponse | null;
  isAuthenticated: boolean;
}) {
  const ctaHref = props.isAuthenticated ? "/today" : "/login";
  const ctaLabel = props.isAuthenticated ? "Open workspace" : "Sign in";
  const secondaryHref = props.isAuthenticated ? undefined : "/login?callbackUrl=%2Fwelcome";
  const secondaryLabel = props.isAuthenticated ? undefined : "Start onboarding";

  return (
    <PortalPageShell
      ctaHref={ctaHref}
      ctaLabel={ctaLabel}
      secondaryHref={secondaryHref}
      secondaryLabel={secondaryLabel}
    >
      <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.26em] text-cyan-700">
            Public portal
          </p>
          <h1 className="mt-3 max-w-3xl text-balance text-4xl font-semibold tracking-tight text-slate-950 sm:text-6xl">
            Open intelligence stories, organized for ordinary readers.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-slate-600 sm:text-lg">
            Browse corroborated news events without signing in. The operator workspace remains available behind login for deeper analysis.
          </p>
        </div>
        <div className="rounded-[2rem] border border-slate-200 bg-white/80 p-6 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.4)]">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">
            Why this exists
          </p>
          <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
            <li>Public stories are filtered for corroboration and source credibility.</li>
            <li>Topic channels make it easier to follow one area over time.</li>
            <li>Signed-in users can continue into the full monitoring workspace.</li>
          </ul>
        </div>
      </section>

      {props.payload?.featuredStory ? (
        <section className="mt-10">
          <PortalStoryCard story={props.payload.featuredStory} featured />
        </section>
      ) : null}

      <TopicLinks channels={props.payload?.channels ?? []} />

      <section aria-labelledby="portal-latest" className="mt-10">
        <div className="mb-5">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">
            Latest stories
          </p>
          <h2
            id="portal-latest"
            className="mt-2 text-2xl font-semibold tracking-tight text-slate-950"
          >
            Current public briefing
          </h2>
        </div>
        <StoryGrid stories={props.payload?.latestStories ?? []} />
      </section>
    </PortalPageShell>
  );
}

export function PortalChannelView(props: {
  payload: PublicPortalChannelResponse;
  isAuthenticated: boolean;
}) {
  return (
    <PortalPageShell
      ctaHref={props.isAuthenticated ? "/today" : "/login"}
      ctaLabel={props.isAuthenticated ? "Open workspace" : "Sign in"}
    >
      <div className="max-w-3xl">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-700">
          Topic channel
        </p>
        <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
          {props.payload.topic}
        </h1>
        <p className="mt-4 text-base leading-8 text-slate-600">
          {props.payload.storyCount} corroborated stories are currently available in this channel.
        </p>
      </div>

      <section className="mt-10">
        <StoryGrid stories={props.payload.stories} />
      </section>
    </PortalPageShell>
  );
}

function BriefSection(props: { title: string; items: { text: string }[] }) {
  if (props.items.length === 0) {
    return null;
  }

  return (
    <section className="rounded-[1.5rem] border border-slate-200 bg-white/90 p-6">
      <h2 className="text-lg font-semibold text-slate-950">{props.title}</h2>
      <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
        {props.items.map((item) => (
          <li key={`${props.title}-${item.text}`}>{item.text}</li>
        ))}
      </ul>
    </section>
  );
}

export function PortalStoryDetailView(props: {
  payload: PublicPortalStoryResponse;
  isAuthenticated: boolean;
}) {
  const { payload } = props;
  const brief = payload.story.brief;

  return (
    <PortalPageShell
      ctaHref={props.isAuthenticated ? "/today" : "/login"}
      ctaLabel={props.isAuthenticated ? "Open workspace" : "Sign in"}
      secondaryHref={`/channel/${payload.story.topicSlug}`}
      secondaryLabel={`More on ${payload.story.topic}`}
    >
      <article className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <StoryMeta story={payload.story} />
          <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
            {payload.story.title}
          </h1>
          <p className="mt-5 text-base leading-8 text-slate-600 sm:text-lg">
            {payload.story.summary}
          </p>

          {brief ? (
            <div className="mt-8 grid gap-5">
              <section className="rounded-[1.6rem] border border-slate-200 bg-white/92 p-6">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">
                  TL;DR
                </p>
                <p className="mt-3 text-base leading-8 text-slate-700">
                  {brief.payload.tldr}
                </p>
              </section>
              <section className="rounded-[1.6rem] border border-slate-200 bg-white/92 p-6">
                <h2 className="text-lg font-semibold text-slate-950">What happened</h2>
                <p className="mt-3 text-sm leading-8 text-slate-600">
                  {brief.payload.detailed_summary}
                </p>
              </section>
              <BriefSection title="Key points" items={brief.payload.key_points} />
              <BriefSection
                title="Why it matters"
                items={brief.payload.why_it_matters}
              />
              <BriefSection
                title="What to watch"
                items={brief.payload.what_to_watch}
              />
            </div>
          ) : null}
        </div>

        <aside className="grid gap-5">
          <section className="rounded-[1.5rem] border border-slate-200 bg-white/90 p-6">
            <h2 className="text-lg font-semibold text-slate-950">Referenced sources</h2>
            <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
              {payload.story.referencedArticles.length > 0 ? (
                payload.story.referencedArticles.map((article) => (
                  <li key={article.id}>
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {article.title ?? article.url}
                    </a>
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">
                      {article.sourceLabel ?? "Source"} ·{" "}
                      {article.publishedAt ? formatTimestamp(article.publishedAt) : "Time unavailable"}
                    </div>
                  </li>
                ))
              ) : (
                <li>No referenced sources available yet.</li>
              )}
            </ul>
          </section>

          {payload.relatedStories.length > 0 ? (
            <section className="rounded-[1.5rem] border border-slate-200 bg-white/90 p-6">
              <h2 className="text-lg font-semibold text-slate-950">Related stories</h2>
              <div className="mt-4 space-y-3">
                {payload.relatedStories.map((story) => (
                  <div key={story.id} className="rounded-2xl border border-slate-200 p-4">
                    <Link
                      href={`/article/${story.slug}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {story.title}
                    </Link>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {story.summary}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </article>
    </PortalPageShell>
  );
}
