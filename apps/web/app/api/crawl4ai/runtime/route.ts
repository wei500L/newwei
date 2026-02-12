import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { isDisplayDependencyError } from "@/lib/crawl-runtime";

export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CACHE_TTL_MS = 30_000;
const PROBE_URL = "https://example.com/";

type Permission = "crawl.read" | "crawl.write";

interface ProbeResult {
  ok: boolean;
  durationMs: number;
  status?: number;
  error?: string;
}

interface RuntimeProbeResponse {
  checkedAt: string;
  baseUrl: string;
  headless: ProbeResult;
  headed: ProbeResult;
  xvfb: {
    supported: boolean;
    reason?: string;
  };
  xvfbEnv?: {
    enabled?: string;
    displayNum?: string;
    screen?: string;
  };
}

let cached: {
  checkedAt: number;
  payload: RuntimeProbeResponse;
} | null = null;

function hasAnyPermission(
  permissions: string[],
  required: Permission[],
): boolean {
  return required.some((perm) => permissions.includes(perm));
}

function normalizeErrorMessage(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value instanceof Error && value.message.trim())
    return value.message.trim();
  return undefined;
}

async function runProbe(
  baseUrl: string,
  headless: boolean,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const url = new URL("/crawl", baseUrl);
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");

    const apiKey = process.env.CRAWL4AI_API_KEY?.trim();
    if (apiKey) {
      headers.set("x-api-key", apiKey);
    }

    const payload = {
      urls: [PROBE_URL],
      browser_config: { type: "BrowserConfig", params: { headless } },
      crawler_config: {
        type: "CrawlerRunConfig",
        params: {
          cache_mode: "bypass",
          only_text: true,
          word_count_threshold: 5,
          exclude_external_links: true,
          remove_overlay_elements: true,
          process_iframes: true,
        },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const record =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    const results =
      record && Array.isArray(record.results)
        ? (record.results as unknown[])
        : [];
    const first =
      results.length > 0 &&
      results[0] &&
      typeof results[0] === "object" &&
      !Array.isArray(results[0])
        ? (results[0] as Record<string, unknown>)
        : null;
    const ok = response.ok && first?.success === true;
    const error = ok
      ? undefined
      : (normalizeErrorMessage(first?.error_message) ??
        normalizeErrorMessage(first?.errorMessage) ??
        normalizeErrorMessage(first?.error) ??
        normalizeErrorMessage(record?.error) ??
        (response.ok ? "crawl failed" : `HTTP ${response.status}`));

    return {
      ok,
      durationMs: Date.now() - startedAt,
      status: response.status,
      error,
    };
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: isAbortError
        ? "probe timed out"
        : (normalizeErrorMessage(error) ?? "probe failed"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const permissions = session.permissions ?? session.user?.permissions ?? [];
  if (!hasAnyPermission(permissions, ["crawl.read", "crawl.write"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = Date.now();
  if (cached && now - cached.checkedAt < PROBE_CACHE_TTL_MS) {
    return NextResponse.json(cached.payload, { status: 200 });
  }

  const baseUrl = process.env.CRAWL4AI_BASE_URL?.trim();
  if (!baseUrl) {
    return NextResponse.json(
      { error: "CRAWL4AI_BASE_URL is not configured" },
      { status: 500 },
    );
  }

  const [headless, headed] = await Promise.all([
    runProbe(baseUrl, true),
    runProbe(baseUrl, false),
  ]);
  const displayIssue = headed.error
    ? isDisplayDependencyError(headed.error)
    : false;
  const xvfb = {
    supported: headed.ok,
    reason: headed.ok
      ? undefined
      : displayIssue
        ? "DISPLAY/Xvfb not available for headless=false"
        : headed.error,
  };

  const payload: RuntimeProbeResponse = {
    checkedAt: new Date(now).toISOString(),
    baseUrl,
    headless,
    headed,
    xvfb,
    xvfbEnv: {
      enabled: process.env.CRAWL4AI_XVFB_ENABLED?.trim() || undefined,
      displayNum: process.env.CRAWL4AI_XVFB_DISPLAY_NUM?.trim() || undefined,
      screen: process.env.CRAWL4AI_XVFB_SCREEN?.trim() || undefined,
    },
  };

  cached = { checkedAt: now, payload };
  return NextResponse.json(payload, { status: 200 });
}
