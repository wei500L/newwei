import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env.server", () => ({
  serverEnv: {
    apiBaseUrl: "http://api:4000/api",
    NEXTAUTH_SECRET: "dev-nextauth-secret-123456",
  },
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { getToken } from "next-auth/jwt";

import { GET } from "../app/api/situation-monitor/hls-proxy/route";

const getTokenMock = vi.mocked(getToken);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("situation monitor hls proxy route", () => {
  it("rejects invalid channel key", async () => {
    const response = await GET(
      new Request("http://localhost/api/situation-monitor/hls-proxy?channel=unknown"),
    );

    expect(response.status).toBe(400);
  });

  it("returns 401 when request has no session token", async () => {
    getTokenMock.mockResolvedValueOnce(null as never);

    const response = await GET(
      new Request("http://localhost/api/situation-monitor/hls-proxy?channel=cnn"),
    );

    expect(response.status).toBe(401);
  });

  it("returns probe status for configured/unconfigured channels", async () => {
    getTokenMock.mockResolvedValue({ accessToken: "token-1" } as never);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("channel=cnn")) {
        return new Response(
          JSON.stringify({
            configured: true,
            upstreamUrl: "https://media.example.net/live/cnn/master.m3u8",
            referer: "https://example.com",
            allowedHosts: ["media.example.net"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          configured: false,
          upstreamUrl: null,
          referer: null,
          allowedHosts: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const configured = await GET(
      new Request("http://localhost/api/situation-monitor/hls-proxy?channel=cnn&probe=1"),
    );
    const configuredBody = (await configured.json()) as { configured?: boolean };

    const unconfigured = await GET(
      new Request("http://localhost/api/situation-monitor/hls-proxy?channel=cnbc&probe=1"),
    );
    const unconfiguredBody = (await unconfigured.json()) as { configured?: boolean };

    expect(configured.status).toBe(200);
    expect(configuredBody.configured).toBe(true);
    expect(unconfigured.status).toBe(200);
    expect(unconfiguredBody.configured).toBe(false);
  });

  it("returns 503 when channel is not configured", async () => {
    getTokenMock.mockResolvedValue({ accessToken: "token-2" } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ configured: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const response = await GET(
      new Request("http://localhost/api/situation-monitor/hls-proxy?channel=cnn"),
    );

    expect(response.status).toBe(503);
  });

  it("blocks non-allowlisted upstream hosts", async () => {
    getTokenMock.mockResolvedValue({ accessToken: "token-3" } as never);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          upstreamUrl: "https://media.example.net/live/cnn/master.m3u8",
          referer: "https://example.com",
          allowedHosts: ["media.example.net"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(
        "http://localhost/api/situation-monitor/hls-proxy?channel=cnn&upstream=https%3A%2F%2Fforbidden.example.com%2Flive.m3u8",
      ),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rewrites manifest segment and key URIs to proxy URLs", async () => {
    getTokenMock.mockResolvedValue({ accessToken: "token-4" } as never);

    const manifest = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
      "segment-001.ts",
      "",
    ].join("\n");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes("/situation-monitor/live-hls-proxy-config?channel=cnbc")) {
        return new Response(
          JSON.stringify({
            configured: true,
            upstreamUrl: "https://cdn-ca2-na.lncnetworks.host/hls/cnbc_live/index.m3u8",
            referer: "https://livenewschat.eu/",
            allowedHosts: ["cdn-ca2-na.lncnetworks.host"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      expect(init?.headers).toBeTruthy();
      return new Response(manifest, {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request("http://localhost/api/situation-monitor/hls-proxy?channel=cnbc"),
    );

    expect(response.status).toBe(200);
    const body = await response.text();

    const expectedSegment = encodeURIComponent(
      "https://cdn-ca2-na.lncnetworks.host/hls/cnbc_live/segment-001.ts",
    );
    const expectedKey = encodeURIComponent(
      "https://cdn-ca2-na.lncnetworks.host/hls/cnbc_live/key.bin",
    );

    expect(body).toContain(
      `/api/situation-monitor/hls-proxy?channel=cnbc&upstream=${expectedSegment}`,
    );
    expect(body).toContain(
      `URI=\"/api/situation-monitor/hls-proxy?channel=cnbc&upstream=${expectedKey}\"`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const upstreamRequestInit = (fetchMock.mock.calls[1]?.[1] ?? {}) as RequestInit;
    const headers = new Headers((upstreamRequestInit.headers ?? {}) as HeadersInit);
    expect(headers.get("referer")).toBe("https://livenewschat.eu/");
  });

  it("forwards range headers and streams non-manifest payload", async () => {
    getTokenMock.mockResolvedValue({ accessToken: "token-5" } as never);

    const chunk = Uint8Array.from([0, 1, 2, 3, 4]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/situation-monitor/live-hls-proxy-config?channel=cnbc")) {
        return new Response(
          JSON.stringify({
            configured: true,
            upstreamUrl: "https://cdn-ca2-na.lncnetworks.host/hls/cnbc_live/index.m3u8",
            referer: null,
            allowedHosts: ["cdn-ca2-na.lncnetworks.host"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(chunk, {
        status: 206,
        headers: {
          "content-type": "video/mp2t",
          "content-length": String(chunk.byteLength),
          "content-range": "bytes 0-4/1200",
          "accept-ranges": "bytes",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(
        "http://localhost/api/situation-monitor/hls-proxy?channel=cnbc&upstream=https%3A%2F%2Fcdn-ca2-na.lncnetworks.host%2Fhls%2Fcnbc_live%2Fsegment-001.ts",
        {
          headers: {
            range: "bytes=0-4",
          },
        },
      ),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp2t");
    expect(response.headers.get("content-range")).toBe("bytes 0-4/1200");

    const requestInit = (fetchMock.mock.calls[1]?.[1] ?? {}) as RequestInit;
    const upstreamHeaders = new Headers((requestInit.headers ?? {}) as HeadersInit);
    expect(upstreamHeaders.get("range")).toBe("bytes=0-4");

    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(chunk));
  });
});
