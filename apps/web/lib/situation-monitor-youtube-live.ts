export interface SituationMonitorYouTubeLiveInfo {
  videoId: string | null;
  isLive: boolean;
  channelExists: boolean;
  channelName?: string | null;
  hlsUrl?: string | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const liveInfoCache = new Map<string, { timestamp: number; value: SituationMonitorYouTubeLiveInfo }>();

function normalizeHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export async function fetchSituationMonitorYouTubeLiveInfo(
  channelHandle: string,
): Promise<SituationMonitorYouTubeLiveInfo> {
  const normalizedHandle = normalizeHandle(channelHandle);
  if (!normalizedHandle) {
    return {
      videoId: null,
      isLive: false,
      channelExists: false,
      channelName: null,
      hlsUrl: null,
    };
  }

  const cached = liveInfoCache.get(normalizedHandle);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const response = await fetch(
      `/api/situation-monitor/youtube-live?channel=${encodeURIComponent(normalizedHandle)}`,
      {
        method: "GET",
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as Partial<SituationMonitorYouTubeLiveInfo>;
    const value: SituationMonitorYouTubeLiveInfo = {
      videoId: typeof data.videoId === "string" ? data.videoId : null,
      isLive: data.isLive === true,
      channelExists: data.channelExists !== false,
      channelName: typeof data.channelName === "string" ? data.channelName : null,
      hlsUrl: typeof data.hlsUrl === "string" ? data.hlsUrl : null,
    };

    liveInfoCache.set(normalizedHandle, {
      timestamp: Date.now(),
      value,
    });

    return value;
  } catch {
    return {
      videoId: null,
      isLive: false,
      channelExists: false,
      channelName: null,
      hlsUrl: null,
    };
  }
}

export function __clearSituationMonitorYouTubeLiveCacheForTests(): void {
  liveInfoCache.clear();
}
