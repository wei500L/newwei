import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

const originalBaseUrl = process.env.CRAWL4AI_BASE_URL;
const originalApiKey = process.env.CRAWL4AI_API_KEY;
const originalSsrfProxyUrl = process.env.CRAWL4AI_SSRF_PROXY_URL;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();

  if (originalBaseUrl === undefined) {
    delete process.env.CRAWL4AI_BASE_URL;
  } else {
    process.env.CRAWL4AI_BASE_URL = originalBaseUrl;
  }

  if (originalApiKey === undefined) {
    delete process.env.CRAWL4AI_API_KEY;
  } else {
    process.env.CRAWL4AI_API_KEY = originalApiKey;
  }

  if (originalSsrfProxyUrl === undefined) {
    delete process.env.CRAWL4AI_SSRF_PROXY_URL;
  } else {
    process.env.CRAWL4AI_SSRF_PROXY_URL = originalSsrfProxyUrl;
  }
});

function buildProbeResponse(ok: boolean, error?: string) {
  return new Response(
    JSON.stringify({
      results: [
        {
          success: ok,
          error_message: error,
        },
      ],
    }),
    {
      status: ok ? 200 : 502,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

async function loadRuntimeRoute() {
  const routeModule = await import("../app/api/crawl4ai/runtime/route");
  const authModule = await import("@/lib/auth");
  return {
    GET: routeModule.GET,
    authMock: vi.mocked(authModule.auth),
  };
}

describe("crawl4ai runtime route", () => {
  it("returns disabled SSRF proxy state when CRAWL4AI_SSRF_PROXY_URL is unset", async () => {
    const { GET, authMock } = await loadRuntimeRoute();
    process.env.CRAWL4AI_BASE_URL = "http://crawl4ai:11235";
    delete process.env.CRAWL4AI_SSRF_PROXY_URL;
    authMock.mockResolvedValue({
      permissions: ["crawl.read"],
    } as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildProbeResponse(true))
      .mockResolvedValueOnce(buildProbeResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();
    const body = (await response.json()) as {
      ssrfProxy?: {
        enabled?: boolean;
        url?: string;
        probe?: { ok?: boolean };
      };
    };

    expect(response.status).toBe(200);
    expect(body.ssrfProxy).toEqual({
      enabled: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("probes the worker-side SSRF proxy when configured", async () => {
    const { GET, authMock } = await loadRuntimeRoute();
    process.env.CRAWL4AI_BASE_URL = "http://crawl4ai:11235";
    process.env.CRAWL4AI_SSRF_PROXY_URL = "http://127.0.0.1:18080";
    authMock.mockResolvedValue({
      permissions: ["crawl.write"],
    } as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildProbeResponse(true))
      .mockResolvedValueOnce(buildProbeResponse(true))
      .mockResolvedValueOnce(buildProbeResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();
    const body = (await response.json()) as {
      ssrfProxy?: {
        enabled?: boolean;
        url?: string;
        probe?: { ok?: boolean };
      };
    };

    expect(response.status).toBe(200);
    expect(body.ssrfProxy?.enabled).toBe(true);
    expect(body.ssrfProxy?.url).toBe("http://127.0.0.1:18080");
    expect(body.ssrfProxy?.probe?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const proxyProbeCall = fetchMock.mock.calls[2];
    const proxyProbeBody = JSON.parse(String(proxyProbeCall?.[1]?.body)) as {
      browser_config?: {
        params?: {
          proxy_config?: {
            server?: string;
          };
        };
      };
    };

    expect(proxyProbeBody.browser_config?.params?.proxy_config?.server).toBe(
      "http://127.0.0.1:18080",
    );
  });
});
