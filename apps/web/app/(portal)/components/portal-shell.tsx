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
    <header className="border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div>
          <Link
            href="/"
            className="text-sm font-semibold uppercase tracking-[0.26em] text-muted-foreground"
          >
            Modular Public Briefing
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            Public-facing news portal for fast situational awareness.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {props.secondaryHref && props.secondaryLabel ? (
            <Link
              href={props.secondaryHref}
              className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition hover:border-[var(--border-strong)]"
            >
              {props.secondaryLabel}
            </Link>
          ) : null}
          <Link
            href={props.ctaHref}
            className="rounded-full bg-[var(--foreground)] px-4 py-2 text-sm font-medium text-[var(--background)] transition hover:opacity-90"
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
    <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
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
          <span className="text-destructive">Breaking</span>
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
    ? "content-card p-6 sm:p-8"
    : "content-card p-5";

  return (
    <article className={baseClassName}>
      <StoryMeta story={props.story} />
      <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight text-[var(--foreground)] sm:text-3xl">
        <Link href={`/article/${props.story.slug}`} className="hover:underline">
          {props.story.title}
        </Link>
      </h2>
      <p className="mt-4 text-sm leading-7 text-muted-foreground sm:text-base">
        {props.story.summary}
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link
          href={`/article/${props.story.slug}`}
          className="rounded-full bg-[var(--foreground)] px-4 py-2 text-sm font-medium text-[var(--background)] transition hover:opacity-90"
        >
          Read story
        </Link>
        <Link
          href={`/channel/${props.story.topicSlug}`}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition hover:border-[var(--border-strong)]"
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
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Channels
          </p>
          <h2
            id="portal-topics"
            className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]"
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
            className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition hover:border-[var(--border-strong)]"
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
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-muted)] p-8 text-sm text-muted-foreground">
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
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <a
        href="#portal-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[var(--surface)] focus:px-4 focus:py-2"
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
          <p className="kicker">
            Public portal
          </p>
          <h1 className="mt-3 max-w-3xl text-balance text-4xl font-serif font-semibold tracking-tight text-[var(--foreground)] sm:text-6xl">
            Open intelligence stories, organized for ordinary readers.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
            Browse corroborated news events without signing in. The operator workspace remains available behind login for deeper analysis.
          </p>
        </div>
        <div className="content-card p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Why this exists
          </p>
          <ul className="mt-4 space-y-3 text-sm leading-7 text-muted-foreground">
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
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Latest stories
          </p>
          <h2
            id="portal-latest"
            className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]"
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
        <p className="kicker">
          Topic channel
        </p>
        <h1 className="mt-3 text-balance text-4xl font-serif font-semibold tracking-tight text-[var(--foreground)] sm:text-5xl">
          {props.payload.topic}
        </h1>
        <p className="mt-4 text-base leading-8 text-muted-foreground">
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
    <section className="content-card p-6">
      <h2 className="text-lg font-semibold text-[var(--foreground)]">{props.title}</h2>
      <ul className="mt-4 space-y-3 text-sm leading-7 text-muted-foreground">
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
          <h1 className="mt-3 text-balance text-4xl font-serif font-semibold tracking-tight text-[var(--foreground)] sm:text-5xl">
            {payload.story.title}
          </h1>
          <p className="mt-5 text-base leading-8 text-muted-foreground sm:text-lg">
            {payload.story.summary}
          </p>

          {brief ? (
            <div className="mt-8 grid gap-5">
              <section className="content-card p-6">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  TL;DR
                </p>
                <p className="mt-3 text-base leading-8 text-slate-700 dark:text-slate-300">
                  {brief.payload.tldr}
                </p>
              </section>
              <section className="content-card p-6">
                <h2 className="text-lg font-semibold text-[var(--foreground)]">What happened</h2>
                <p className="mt-3 text-sm leading-8 text-muted-foreground">
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
          <section className="content-card p-6">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">Referenced sources</h2>
            <ul className="mt-4 space-y-3 text-sm leading-7 text-muted-foreground">
              {payload.story.referencedArticles.length > 0 ? (
                payload.story.referencedArticles.map((article) => (
                  <li key={article.id}>
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-[var(--foreground)] hover:underline"
                    >
                      {article.title ?? article.url}
                    </a>
                    <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
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
            <section className="content-card p-6">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Related stories</h2>
              <div className="mt-4 space-y-3">
                {payload.relatedStories.map((story) => (
                  <div key={story.id} className="rounded-lg border border-[var(--border)] p-4">
                    <Link
                      href={`/article/${story.slug}`}
                      className="font-medium text-[var(--foreground)] hover:underline"
                    >
                      {story.title}
                    </Link>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
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
