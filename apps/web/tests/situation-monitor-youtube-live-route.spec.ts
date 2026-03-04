import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "../app/api/situation-monitor/youtube-live/route";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("situation monitor youtube live route", () => {
  it("rejects invalid channel handles", async () => {
    const response = await GET(
      new Request("http://localhost/api/situation-monitor/youtube-live?channel=bad/value"),
    );

    expect(response.status).toBe(400);
  });

  it("extracts videoId and hlsManifestUrl from html", async () => {
    const html = `
      <html>
        <script>
          var data = {
            "ownerChannelName":"CNN",
            "videoDetails":{"videoId":"w_Ma8oQLmSM","isLive":true},
            "hlsManifestUrl":"https://example.com/live.m3u8\\u0026foo=bar"
          };
        </script>
      </html>
    `;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const response = await GET(
      new Request("http://localhost/api/situation-monitor/youtube-live?channel=@CNN"),
    );
    const body = (await response.json()) as {
      videoId?: string | null;
      isLive?: boolean;
      channelName?: string | null;
      hlsUrl?: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.videoId).toBe("w_Ma8oQLmSM");
    expect(body.isLive).toBe(true);
    expect(body.channelName).toBe("CNN");
    expect(body.hlsUrl).toBe("https://example.com/live.m3u8&foo=bar");
  });
});
