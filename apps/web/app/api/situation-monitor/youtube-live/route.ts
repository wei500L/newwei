export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const YOUTUBE_FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SUCCESS_CACHE_CONTROL = "public, max-age=300, s-maxage=300, stale-while-revalidate=60";

interface YouTubeLiveResponse {
  videoId: string | null;
  isLive: boolean;
  channelExists: boolean;
  channelName: string | null;
  hlsUrl: string | null;
}

function json(status: number, payload: unknown, cacheControl: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
    },
  });
}

function normalizeChannelHandle(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!/^[A-Za-z0-9_.-]{2,64}$/.test(normalized)) {
    return null;
  }

  return `@${normalized}`;
}

function extractYouTubeLiveInfo(html: string): YouTubeLiveResponse {
  const channelExists = html.includes('"channelId"') || html.includes("og:url");

  let channelName: string | null = null;
  const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
  if (ownerMatch) {
    channelName = ownerMatch[1] ?? null;
  } else {
    const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/);
    if (authorMatch) {
      channelName = authorMatch[1] ?? null;
    }
  }

  let videoId: string | null = null;
  const detailsIndex = html.indexOf('"videoDetails"');
  if (detailsIndex >= 0) {
    const detailsBlock = html.substring(detailsIndex, detailsIndex + 8_000);
    const videoIdMatch = detailsBlock.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
    const isLive =
      /"isLive"\s*:\s*true/.test(detailsBlock) || /"isLiveContent"\s*:\s*true/.test(detailsBlock);
    if (videoIdMatch && isLive) {
      videoId = videoIdMatch[1] ?? null;
    }
  }

  let hlsUrl: string | null = null;
  const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
  if (hlsMatch && videoId) {
    hlsUrl = (hlsMatch[1] ?? "").replace(/\\u0026/g, "&");
  }

  return {
    videoId,
    isLive: Boolean(videoId),
    channelExists,
    channelName,
    hlsUrl,
  };
}

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const channelHandle = normalizeChannelHandle(requestUrl.searchParams.get("channel"));

  if (!channelHandle) {
    return json(400, { error: "Invalid channel handle" }, "no-store");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_FETCH_TIMEOUT_MS);

  try {
    const youtubeResponse = await fetch(`https://www.youtube.com/${channelHandle}/live`, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
      },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!youtubeResponse.ok) {
      return json(
        youtubeResponse.status === 404 ? 404 : 502,
        {
          videoId: null,
          isLive: false,
          channelExists: false,
          channelName: null,
          hlsUrl: null,
          upstreamStatus: youtubeResponse.status,
        },
        "no-store",
      );
    }

    const html = await youtubeResponse.text();
    return json(200, extractYouTubeLiveInfo(html), SUCCESS_CACHE_CONTROL);
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === "AbortError";
    return json(
      isAbortError ? 504 : 502,
      {
        videoId: null,
        isLive: false,
        channelExists: false,
        channelName: null,
        hlsUrl: null,
        timeout: isAbortError,
      },
      "no-store",
    );
  } finally {
    clearTimeout(timeout);
  }
}
