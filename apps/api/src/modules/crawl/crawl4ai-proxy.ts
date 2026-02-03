const LOCAL_PROXY_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function inferPort(parsed: URL): number {
  if (parsed.port) {
    const value = Number(parsed.port);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

function crawl4aiLikelyRunsInDocker(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const port = inferPort(parsed);
    if (hostname === "crawl4ai" || hostname === "host.docker.internal") {
      return true;
    }
    if (LOCAL_PROXY_HOSTS.has(hostname) && (port === 8082 || port === 11235)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function translateLocalhostProxyUrlForCrawl4ai(proxyUrl: string, crawl4aiBaseUrl: string) {
  const trimmed = proxyUrl.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (!crawl4aiLikelyRunsInDocker(crawl4aiBaseUrl)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    if (!LOCAL_PROXY_HOSTS.has(hostname)) {
      return trimmed;
    }
    parsed.hostname = "host.docker.internal";

    const hadNoPath = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+$/.test(trimmed);
    const next = parsed.toString();
    return hadNoPath && next.endsWith("/") ? next.slice(0, -1) : next;
  } catch {
    return trimmed;
  }
}

