import "server-only";

import { serverEnv } from "./env.server";
import { logServerError } from "./server-logger";
import { createTraceHeaders } from "./trace";

export interface PublicPortalOrg {
  id: string;
  slug: string;
  name: string;
}

export interface PublicPortalStory {
  id: string;
  slug: string;
  title: string;
  summary: string;
  topic: string;
  topicSlug: string;
  primaryEntity: string | null;
  language: string | null;
  lastAt: string;
  startAt: string;
  itemCount: number;
  breaking: boolean;
  heatScore: number;
  credibilityScore: number;
  sourceType: "authoritative" | "mixed" | "blog" | "unknown";
  sourceEvidence: {
    uniqueSourceCount: number;
    authoritativeSourceCount: number;
    blogSourceCount: number;
    corroborated: boolean;
  };
}

export interface PublicPortalTopicSummary {
  topic: string;
  topicSlug: string;
  storyCount: number;
  latestAt: string;
}

export interface PublicPortalBriefPoint {
  text: string;
  citations: number[];
}

export interface PublicPortalStoryDetail extends PublicPortalStory {
  brief: {
    generatedAt: string;
    language: string;
    payload: {
      detailed_summary: string;
      tldr: string;
      key_points: PublicPortalBriefPoint[];
      why_it_matters: PublicPortalBriefPoint[];
      latest_update?: PublicPortalBriefPoint | null;
      what_to_watch: PublicPortalBriefPoint[];
      comparison?: {
        consensus: PublicPortalBriefPoint[];
        divergence: PublicPortalBriefPoint[];
      };
      limitations?: string | null;
    };
    sources: Array<{
      index: number;
      url: string;
      sourceLabel: string | null;
      title: string | null;
      publishedAt: string | null;
    }>;
  } | null;
  timeline: Array<{
    id: string;
    bucketStart: string;
    title: string | null;
    summary: string | null;
  }>;
  referencedArticles: Array<{
    id: string;
    url: string;
    sourceLabel: string | null;
    title: string | null;
    publishedAt: string | null;
  }>;
}

export interface PublicPortalHomeResponse {
  generatedAt: string;
  org: PublicPortalOrg;
  featuredStory: PublicPortalStory | null;
  latestStories: PublicPortalStory[];
  channels: PublicPortalTopicSummary[];
}

export interface PublicPortalChannelResponse {
  generatedAt: string;
  org: PublicPortalOrg;
  topic: string;
  topicSlug: string;
  storyCount: number;
  stories: PublicPortalStory[];
}

export interface PublicPortalStoryResponse {
  generatedAt: string;
  org: PublicPortalOrg;
  story: PublicPortalStoryDetail;
  relatedStories: PublicPortalStory[];
}

async function fetchPublicPortal<T>(path: string): Promise<T | null> {
  let response: Response;

  try {
    response = await fetch(`${serverEnv.apiBaseUrl}/public-portal/${path}`, {
      headers: createTraceHeaders(),
      next: {
        revalidate: 60,
      },
    });
  } catch (error) {
    logServerError("Public portal request failed", error, {
      meta: { path },
    });
    return null;
  }

  const traceId = response.headers.get("x-trace-id") ?? undefined;
  if (!response.ok) {
    if (response.status !== 404) {
      logServerError("Public portal response not ok", new Error(`Status ${response.status}`), {
        traceId,
        meta: { path, status: response.status },
      });
    }
    return null;
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    logServerError("Public portal response parse failed", error, {
      traceId,
      meta: { path },
    });
    return null;
  }
}

export async function fetchPublicPortalHome() {
  return fetchPublicPortal<PublicPortalHomeResponse>("home");
}

export async function fetchPublicPortalChannel(topic: string) {
  return fetchPublicPortal<PublicPortalChannelResponse>(
    `channels/${encodeURIComponent(topic)}`,
  );
}

export async function fetchPublicPortalStoryBySlug(slug: string) {
  return fetchPublicPortal<PublicPortalStoryResponse>(
    `stories/slug/${encodeURIComponent(slug)}`,
  );
}

export async function fetchPublicPortalStoryById(id: string) {
  return fetchPublicPortal<PublicPortalStoryResponse>(
    `stories/id/${encodeURIComponent(id)}`,
  );
}
