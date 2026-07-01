import { getToken } from "next-auth/jwt";

import type { TokenPayload } from "@/lib/auth";
import { serverEnv } from "@/lib/env.server";
import { isProxiedHlsChannel, type ProxiedHlsChannel } from "@/lib/situation-monitor-live-news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUEST_TIMEOUT_MS = 10_000;
const CONFIG_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const PROXY_ROUTE_PATH = "/api/situation-monitor/hls-proxy";

interface ProxiedHlsConfig {
  upstreamUrl: string;
  referer?: string;
  allowedHosts: Set<string>;
}

interface ProxyConfigFetchResult {
  status: number;
  configured: boolean;
  config: ProxiedHlsConfig | null;
  error?: string;
}

interface LiveHlsProxyConfigResponse {
  configured?: boolean;
  upstreamUrl?: string | null;
  referer?: string | null;
  allowedHosts?: string[];
}

interface UpstreamFetchResult {
  upstreamResponse: Response;
  finalUpstream: URL;
}

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function buildProxyUrl(channel: ProxiedHlsChannel, upstreamUrl: string): string {
  const params = new URLSearchParams({ channel, upstream: upstreamUrl });
  return `${PROXY_ROUTE_PATH}?${params.toString()}`;
}

function isManifest(upstream: URL, contentType: string): boolean {
  return (
    upstream.pathname.toLowerCase().endsWith(".m3u8") ||
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("application/x-mpegurl") ||
    contentType.includes("audio/mpegurl")
  );
}

function resolveManifestReference(upstream: URL, reference: string): string {
  const trimmed = reference.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const resolved = new URL(trimmed, upstream);
    if (resolved.protocol !== "https:") {
      return trimmed;
    }
    return resolved.toString();
  } catch {
    return trimmed;
  }
}

function rewriteManifest(manifest: string, upstream: URL, channel: ProxiedHlsChannel): string {
  const lines = manifest.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const fullUrl = resolveManifestReference(upstream, trimmed);
    if (!fullUrl.startsWith("https://")) {
      return line;
    }
    return buildProxyUrl(channel, fullUrl);
  });

  const withKeyUris = rewritten.join("\n").replace(/URI="([^"]+)"/g, (_whole, uri: string) => {
    const fullUrl = resolveManifestReference(upstream, uri);
    if (!fullUrl.startsWith("https://")) {
      return `URI="${uri}"`;
    }
    return `URI="${buildProxyUrl(channel, fullUrl)}"`;
  });

  return withKeyUris;
}

function resolveUpstream(requestUrl: URL, config: ProxiedHlsConfig): URL | null {
  const upstreamRaw = requestUrl.searchParams.get("upstream")?.trim() || config.upstreamUrl;
  if (!upstreamRaw) {
    return null;
  }

  try {
    return new URL(upstreamRaw);
  } catch {
    return null;
  }
}

function isAllowedUpstream(upstream: URL, allowedHosts: Set<string>): boolean {
  if (upstream.protocol !== "https:") {
    return false;
  }
  return allowedHosts.has(upstream.hostname.toLowerCase());
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function buildUpstreamHeaders(request: Request, referer?: string): Headers {
  const headers = new Headers();
  headers.set("accept", "*/*");
  headers.set(
    "user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  );

  const range = request.headers.get("range");
  if (range) {
    headers.set("range", range);
  }

  if (referer) {
    headers.set("referer", referer);
  }

  return headers;
}

async function getAccessToken(request: Request): Promise<string | null> {
  try {
    const token = (await getToken({
      req: request,
      secret: serverEnv.NEXTAUTH_SECRET,
    })) as TokenPayload | null;
    return token?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function fetchProxyConfig(
  request: Request,
  channel: ProxiedHlsChannel,
): Promise<ProxyConfigFetchResult> {
  const accessToken = await getAccessToken(request);
  if (!accessToken) {
    return {
      status: 401,
      configured: false,
      config: null,
      error: "Unauthorized",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);

  try {
    const endpoint = `${serverEnv.apiBaseUrl}/situation-monitor/live-hls-proxy-config?channel=${encodeURIComponent(channel)}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        status: response.status,
        configured: false,
        config: null,
        error: `Failed to load proxy config (${response.status})`,
      };
    }

    const payload = (await response.json()) as LiveHlsProxyConfigResponse;
    const configured = payload.configured === true;
    if (!configured || typeof payload.upstreamUrl !== "string") {
      return {
        status: 200,
        configured: false,
        config: null,
      };
    }

    let upstream: URL;
    try {
      upstream = new URL(payload.upstreamUrl);
      if (upstream.protocol !== "https:") {
        return {
          status: 503,
          configured: false,
          config: null,
          error: "Invalid upstream URL protocol",
        };
      }
    } catch {
      return {
        status: 503,
        configured: false,
        config: null,
        error: "Invalid upstream URL",
      };
    }

    const allowedHosts = new Set(
      Array.isArray(payload.allowedHosts)
        ? payload.allowedHosts
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
        : [],
    );
    allowedHosts.add(upstream.hostname.toLowerCase());

    return {
      status: 200,
      configured: true,
      config: {
        upstreamUrl: upstream.toString(),
        referer: typeof payload.referer === "string" ? payload.referer : undefined,
        allowedHosts,
      },
    };
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === "AbortError";
    return {
      status: isAbortError ? 504 : 502,
      configured: false,
      config: null,
      error: isAbortError ? "Config request timeout" : "Config request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchValidatedUpstream(
  request: Request,
  upstream: URL,
  config: ProxiedHlsConfig,
  signal: AbortSignal,
): Promise<UpstreamFetchResult | Response> {
  let currentUpstream = upstream;
  let redirectCount = 0;

  for (;;) {
    const upstreamResponse = await fetch(currentUpstream, {
      method: "GET",
      headers: buildUpstreamHeaders(request, config.referer),
      redirect: "manual",
      cache: "no-store",
      signal,
    });

    if (!isRedirectStatus(upstreamResponse.status)) {
      return {
        upstreamResponse,
        finalUpstream: currentUpstream,
      };
    }

    if (redirectCount >= MAX_REDIRECTS) {
      return json(502, { error: "Too many upstream redirects" });
    }

    const location = upstreamResponse.headers.get("location");
    if (!location) {
      return json(502, { error: "Upstream redirect missing location" });
    }

    let redirectTarget: URL;
    try {
      redirectTarget = new URL(location, currentUpstream);
    } catch {
      return json(502, { error: "Invalid upstream redirect location" });
    }

    if (!isAllowedUpstream(redirectTarget, config.allowedHosts)) {
      return json(403, { error: "Upstream redirect host not allowed" });
    }

    currentUpstream = redirectTarget;
    redirectCount += 1;
  }
}

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const channelParam = requestUrl.searchParams.get("channel")?.trim().toLowerCase();
  if (!channelParam || !isProxiedHlsChannel(channelParam)) {
    return json(400, { error: "Invalid channel" });
  }

  const configResult = await fetchProxyConfig(request, channelParam);
  if (requestUrl.searchParams.get("probe") === "1") {
    if (configResult.status !== 200) {
      return json(configResult.status, {
        channel: channelParam,
        configured: false,
        error: configResult.error ?? "Probe failed",
      });
    }

    return json(200, {
      channel: channelParam,
      configured: configResult.configured,
    });
  }

  if (configResult.status !== 200) {
    return json(configResult.status, {
      error: configResult.error ?? "Failed to load proxy config",
    });
  }

  const config = configResult.config;
  if (!config) {
    return json(503, {
      error: `HLS proxy is not configured for channel: ${channelParam}`,
      code: "PROXY_NOT_CONFIGURED",
    });
  }

  const upstream = resolveUpstream(requestUrl, config);
  if (!upstream) {
    return json(400, { error: "Invalid upstream URL" });
  }

  if (!isAllowedUpstream(upstream, config.allowedHosts)) {
    return json(403, { error: "Upstream host not allowed" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamFetchResult = await fetchValidatedUpstream(
      request,
      upstream,
      config,
      controller.signal,
    );
    if (upstreamFetchResult instanceof Response) {
      return upstreamFetchResult;
    }

    const { upstreamResponse, finalUpstream } = upstreamFetchResult;

    if (!upstreamResponse.ok) {
      return json(upstreamResponse.status, {
        error: `Upstream error: ${upstreamResponse.status}`,
      });
    }

    const contentType = (upstreamResponse.headers.get("content-type") ?? "").toLowerCase();

    if (isManifest(finalUpstream, contentType)) {
      const manifest = await upstreamResponse.text();
      const rewritten = rewriteManifest(manifest, finalUpstream, channelParam);
      return new Response(rewritten, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          "cache-control": "no-store",
        },
      });
    }

    const passthroughHeaders = new Headers();
    passthroughHeaders.set("cache-control", "no-store");
    passthroughHeaders.set("content-type", contentType || "application/octet-stream");

    const forwardHeaderKeys = ["content-length", "content-range", "accept-ranges"];
    for (const headerKey of forwardHeaderKeys) {
      const value = upstreamResponse.headers.get(headerKey);
      if (value) {
        passthroughHeaders.set(headerKey, value);
      }
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: passthroughHeaders,
    });
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === "AbortError";
    return json(isAbortError ? 504 : 502, {
      error: isAbortError ? "Upstream timeout" : "Proxy request failed",
    });
  } finally {
    clearTimeout(timeout);
  }
}
