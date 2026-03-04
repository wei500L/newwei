export type LiveNewsRegion =
  | "global"
  | "europe"
  | "americas"
  | "middle-east"
  | "asia"
  | "africa"
  | "oceania";

export type LiveNewsSourceMode = "hls-direct" | "hls-proxy" | "youtube-only";

export type ProxiedHlsChannel = "cnn" | "cnbc";

export interface LiveNewsRegionOption {
  key: LiveNewsRegion;
  labelKey: string;
  defaultLabel: string;
}

export interface LiveNewsChannel {
  id: string;
  name: string;
  region: LiveNewsRegion;
  sourceMode: LiveNewsSourceMode;
  hlsUrl?: string;
  proxyChannel?: ProxiedHlsChannel;
  youtubeHandle?: string;
  fallbackVideoId?: string;
  allowYoutubeFallback: boolean;
}

export interface RegionChannelPreferences {
  order: string[];
  enabled: string[];
}

export interface LiveNewsChannelPreferences {
  version: 1;
  regions: Record<LiveNewsRegion, RegionChannelPreferences>;
}

export type LiveNewsPlaybackMode = "hls" | "youtube" | "hls-only";

export const HLS_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_VISIBLE_CHANNELS = 4;

const PREFERENCES_STORAGE_KEY = "situation-monitor-live-news-preferences-v1";

export const PROXIED_HLS_CHANNELS: readonly ProxiedHlsChannel[] = ["cnn", "cnbc"];

export const LIVE_NEWS_REGIONS: readonly LiveNewsRegionOption[] = [
  { key: "global", labelKey: "situationMonitor.liveNews.region.global", defaultLabel: "Global" },
  { key: "europe", labelKey: "situationMonitor.liveNews.region.europe", defaultLabel: "Europe" },
  { key: "americas", labelKey: "situationMonitor.liveNews.region.americas", defaultLabel: "Americas" },
  {
    key: "middle-east",
    labelKey: "situationMonitor.liveNews.region.middleEast",
    defaultLabel: "Middle East",
  },
  { key: "asia", labelKey: "situationMonitor.liveNews.region.asia", defaultLabel: "Asia" },
  { key: "africa", labelKey: "situationMonitor.liveNews.region.africa", defaultLabel: "Africa" },
  { key: "oceania", labelKey: "situationMonitor.liveNews.region.oceania", defaultLabel: "Oceania" },
] as const;

export const LIVE_NEWS_CHANNELS: readonly LiveNewsChannel[] = [
  {
    id: "bloomberg",
    name: "Bloomberg",
    region: "global",
    sourceMode: "youtube-only",
    youtubeHandle: "@markets",
    fallbackVideoId: "iEpJwprxDdk",
    allowYoutubeFallback: true,
  },
  {
    id: "sky-news",
    name: "Sky News",
    region: "global",
    sourceMode: "hls-direct",
    hlsUrl: "https://linear901-oo-hls0-prd-gtm.delivery.skycdp.com/17501/sde-fast-skynews/master.m3u8",
    youtubeHandle: "@SkyNews",
    fallbackVideoId: "9Auq9mYxFEE",
    allowYoutubeFallback: true,
  },
  {
    id: "euronews",
    name: "Euronews",
    region: "global",
    sourceMode: "hls-direct",
    hlsUrl: "https://dash4.antik.sk/live/test_euronews/playlist.m3u8",
    youtubeHandle: "@euronews",
    fallbackVideoId: "pykpO5kQJ98",
    allowYoutubeFallback: true,
  },
  {
    id: "dw",
    name: "DW",
    region: "global",
    sourceMode: "hls-direct",
    hlsUrl: "https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/master.m3u8",
    youtubeHandle: "@DWNews",
    fallbackVideoId: "LuKwFajn37U",
    allowYoutubeFallback: true,
  },

  {
    id: "france24",
    name: "France 24",
    region: "europe",
    sourceMode: "hls-direct",
    hlsUrl:
      "https://amg00106-france24-france24-samsunguk-qvpp8.amagi.tv/playlist/amg00106-france24-france24-samsunguk/playlist.m3u8",
    youtubeHandle: "@France24_en",
    fallbackVideoId: "Ap-UM1O9RBU",
    allowYoutubeFallback: true,
  },
  {
    id: "tagesschau24",
    name: "Tagesschau24",
    region: "europe",
    sourceMode: "hls-direct",
    hlsUrl: "https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8",
    youtubeHandle: "@tagesschau",
    fallbackVideoId: "fC_q9TkO1uU",
    allowYoutubeFallback: true,
  },
  {
    id: "tv5monde-info",
    name: "TV5Monde Info",
    region: "europe",
    sourceMode: "hls-direct",
    hlsUrl: "https://ott.tv5monde.com/Content/HLS/Live/channel(info)/index.m3u8",
    youtubeHandle: "@TV5MONDEInfo",
    allowYoutubeFallback: false,
  },
  {
    id: "rt",
    name: "RT",
    region: "europe",
    sourceMode: "hls-direct",
    hlsUrl: "https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8",
    allowYoutubeFallback: false,
  },
  {
    id: "bbc-news",
    name: "BBC News",
    region: "europe",
    sourceMode: "hls-direct",
    hlsUrl:
      "https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/iptv_hd_abr_v1.m3u8",
    youtubeHandle: "@BBCNews",
    fallbackVideoId: "bjgQzJzCZKs",
    allowYoutubeFallback: true,
  },
  {
    id: "nrk1",
    name: "NRK1",
    region: "europe",
    sourceMode: "hls-direct",
    hlsUrl: "https://nrk-nrk1.akamaized.net/21/0/hls/nrk_1/playlist.m3u8",
    youtubeHandle: "@nrk",
    allowYoutubeFallback: false,
  },

  {
    id: "cnn",
    name: "CNN",
    region: "americas",
    sourceMode: "hls-proxy",
    proxyChannel: "cnn",
    youtubeHandle: "@CNN",
    fallbackVideoId: "w_Ma8oQLmSM",
    allowYoutubeFallback: true,
  },
  {
    id: "cnbc",
    name: "CNBC",
    region: "americas",
    sourceMode: "hls-proxy",
    proxyChannel: "cnbc",
    youtubeHandle: "@CNBC",
    fallbackVideoId: "9NyxcX3rhQs",
    allowYoutubeFallback: true,
  },
  {
    id: "cbs-news",
    name: "CBS News",
    region: "americas",
    sourceMode: "hls-direct",
    hlsUrl: "https://cbsn-us.cbsnstream.cbsnews.com/out/v1/55a8648e8f134e82a470f83d562deeca/master.m3u8",
    youtubeHandle: "@CBSNews",
    fallbackVideoId: "R9L8sDK8iEc",
    allowYoutubeFallback: true,
  },
  {
    id: "fox-news",
    name: "Fox News",
    region: "americas",
    sourceMode: "hls-direct",
    hlsUrl: "https://247preview.foxnews.com/hls/live/2020027/fncv3preview/primary.m3u8",
    youtubeHandle: "@FoxNews",
    fallbackVideoId: "QaftgYkG-ek",
    allowYoutubeFallback: true,
  },
  {
    id: "abc-news",
    name: "ABC News",
    region: "americas",
    sourceMode: "youtube-only",
    youtubeHandle: "@ABCNews",
    allowYoutubeFallback: true,
  },
  {
    id: "nbc-news",
    name: "NBC News",
    region: "americas",
    sourceMode: "youtube-only",
    youtubeHandle: "@NBCNews",
    fallbackVideoId: "yMr0neQhu6c",
    allowYoutubeFallback: true,
  },

  {
    id: "alarabiya",
    name: "Al Arabiya",
    region: "middle-east",
    sourceMode: "hls-direct",
    hlsUrl: "https://live.alarabiya.net/alarabiapublish/alarabiya.smil/playlist.m3u8",
    youtubeHandle: "@AlArabiya",
    fallbackVideoId: "n7eQejkXbnM",
    allowYoutubeFallback: true,
  },
  {
    id: "trt-world",
    name: "TRT World",
    region: "middle-east",
    sourceMode: "hls-direct",
    hlsUrl: "https://tv-trtworld.medya.trt.com.tr/master.m3u8",
    youtubeHandle: "@TRTWorld",
    fallbackVideoId: "ABfFhWzWs0s",
    allowYoutubeFallback: true,
  },
  {
    id: "sky-news-arabia",
    name: "Sky News Arabia",
    region: "middle-east",
    sourceMode: "hls-direct",
    hlsUrl: "https://live-stream.skynewsarabia.com/c-horizontal-channel/horizontal-stream/index.m3u8",
    youtubeHandle: "@skynewsarabia",
    fallbackVideoId: "U--OjmpjF5o",
    allowYoutubeFallback: true,
  },
  {
    id: "al-hadath",
    name: "Al Hadath",
    region: "middle-east",
    sourceMode: "hls-direct",
    hlsUrl: "https://av.alarabiya.net/alarabiapublish/alhadath.smil/playlist.m3u8",
    youtubeHandle: "@AlHadath",
    fallbackVideoId: "xWXpl7azI8k",
    allowYoutubeFallback: true,
  },
  {
    id: "aljazeera",
    name: "Al Jazeera",
    region: "middle-east",
    sourceMode: "youtube-only",
    youtubeHandle: "@AlJazeeraEnglish",
    fallbackVideoId: "gCNeDWCI0vo",
    allowYoutubeFallback: true,
  },

  {
    id: "nhk-world",
    name: "NHK World",
    region: "asia",
    sourceMode: "hls-direct",
    hlsUrl: "https://nhkwlive-ojp.akamaized.net/hls/live/2003459/nhkwlive-ojp-en/index_4M.m3u8",
    youtubeHandle: "@NHKWORLDJAPAN",
    fallbackVideoId: "f0lYfG_vY_U",
    allowYoutubeFallback: true,
  },
  {
    id: "india-today",
    name: "India Today",
    region: "asia",
    sourceMode: "hls-direct",
    hlsUrl: "https://indiatodaylive.akamaized.net/hls/live/2014320/indiatoday/indiatodaylive/playlist.m3u8",
    youtubeHandle: "@indiatoday",
    fallbackVideoId: "sYZtOFzM78M",
    allowYoutubeFallback: true,
  },
  {
    id: "kan-11",
    name: "KAN 11",
    region: "asia",
    sourceMode: "hls-direct",
    hlsUrl: "https://kan11.media.kan.org.il/hls/live/2024514/2024514/master.m3u8",
    youtubeHandle: "@KAN11NEWS",
    fallbackVideoId: "TCnaIE_SAtM",
    allowYoutubeFallback: true,
  },
  {
    id: "wion",
    name: "WION",
    region: "asia",
    sourceMode: "youtube-only",
    youtubeHandle: "@WION",
    fallbackVideoId: "L0R6h7QvoX8",
    allowYoutubeFallback: true,
  },
  {
    id: "cna",
    name: "CNA",
    region: "asia",
    sourceMode: "youtube-only",
    youtubeHandle: "@channelnewsasia",
    fallbackVideoId: "XWq5kBlakcQ",
    allowYoutubeFallback: true,
  },

  {
    id: "arise-news",
    name: "Arise News",
    region: "africa",
    sourceMode: "hls-direct",
    hlsUrl: "https://liveedge-arisenews.visioncdn.com/live-hls/arisenews/arisenews/arisenews_web/master.m3u8",
    youtubeHandle: "@AriseNewsChannel",
    fallbackVideoId: "4uHZdlX-DT4",
    allowYoutubeFallback: true,
  },
  {
    id: "sabc-news",
    name: "SABC News",
    region: "africa",
    sourceMode: "hls-direct",
    hlsUrl: "https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/chunklist_b250000_t64MjQwcA==.m3u8",
    youtubeHandle: "@SABCDigitalNews",
    allowYoutubeFallback: false,
  },
  {
    id: "africanews",
    name: "Africanews",
    region: "africa",
    sourceMode: "youtube-only",
    youtubeHandle: "@africanews",
    allowYoutubeFallback: true,
  },
  {
    id: "channels-tv",
    name: "Channels TV",
    region: "africa",
    sourceMode: "youtube-only",
    youtubeHandle: "@ChannelsTelevision",
    allowYoutubeFallback: true,
  },
  {
    id: "ktn-news",
    name: "KTN News",
    region: "africa",
    sourceMode: "youtube-only",
    youtubeHandle: "@ktnnews_kenya",
    fallbackVideoId: "RmHtsdVb3mo",
    allowYoutubeFallback: true,
  },

  {
    id: "abc-news-au",
    name: "ABC News AU",
    region: "oceania",
    sourceMode: "hls-direct",
    hlsUrl: "https://abc-iview-mediapackagestreams-2.akamaized.net/out/v1/6e1cc6d25ec0480ea099a5399d73bc4b/index.m3u8",
    youtubeHandle: "@abcnewsaustralia",
    fallbackVideoId: "vOTiJkg1voo",
    allowYoutubeFallback: true,
  },
  {
    id: "sky-news-australia",
    name: "Sky News Australia",
    region: "oceania",
    sourceMode: "youtube-only",
    youtubeHandle: "@SkyNewsAustralia",
    allowYoutubeFallback: true,
  },
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function isProxiedHlsChannel(value: string): value is ProxiedHlsChannel {
  return PROXIED_HLS_CHANNELS.includes(value as ProxiedHlsChannel);
}

export function buildProxiedHlsPath(channel: ProxiedHlsChannel): string {
  return `/api/situation-monitor/hls-proxy?channel=${encodeURIComponent(channel)}`;
}

export function getChannelHlsUrl(channel: LiveNewsChannel): string | null {
  if (channel.sourceMode === "hls-direct") {
    return channel.hlsUrl ?? null;
  }
  if (channel.sourceMode === "hls-proxy" && channel.proxyChannel) {
    return buildProxiedHlsPath(channel.proxyChannel);
  }
  return null;
}

export function canFallbackToYoutube(channel: LiveNewsChannel): boolean {
  if (!channel.allowYoutubeFallback) {
    return false;
  }
  return Boolean(channel.fallbackVideoId || channel.youtubeHandle);
}

export function getChannelsByRegion(region: LiveNewsRegion): LiveNewsChannel[] {
  return LIVE_NEWS_CHANNELS.filter((channel) => channel.region === region);
}

function buildDefaultRegionPreferences(region: LiveNewsRegion): RegionChannelPreferences {
  const ids = getChannelsByRegion(region).map((channel) => channel.id);
  return {
    order: [...ids],
    enabled: [...ids],
  };
}

export function buildDefaultLiveNewsChannelPreferences(): LiveNewsChannelPreferences {
  return {
    version: 1,
    regions: {
      global: buildDefaultRegionPreferences("global"),
      europe: buildDefaultRegionPreferences("europe"),
      americas: buildDefaultRegionPreferences("americas"),
      "middle-east": buildDefaultRegionPreferences("middle-east"),
      asia: buildDefaultRegionPreferences("asia"),
      africa: buildDefaultRegionPreferences("africa"),
      oceania: buildDefaultRegionPreferences("oceania"),
    },
  };
}

function normalizeRegionPreferences(
  region: LiveNewsRegion,
  input: unknown,
): RegionChannelPreferences {
  const defaults = buildDefaultRegionPreferences(region);
  if (!isObject(input)) {
    return defaults;
  }

  const channelIds = new Set(defaults.order);
  const orderInput = Array.isArray(input.order) ? input.order : [];
  const enabledInput = Array.isArray(input.enabled) ? input.enabled : [];

  const order = orderInput
    .filter((value): value is string => typeof value === "string" && channelIds.has(value));
  const enabled = enabledInput
    .filter((value): value is string => typeof value === "string" && channelIds.has(value));

  const mergedOrder = [...order];
  for (const id of defaults.order) {
    if (!mergedOrder.includes(id)) {
      mergedOrder.push(id);
    }
  }

  const mergedEnabled = enabled.length > 0 ? [...new Set(enabled)] : [...defaults.enabled];

  return {
    order: mergedOrder,
    enabled: mergedEnabled,
  };
}

export function normalizeLiveNewsChannelPreferences(input: unknown): LiveNewsChannelPreferences {
  const defaults = buildDefaultLiveNewsChannelPreferences();
  if (!isObject(input) || !isObject(input.regions)) {
    return defaults;
  }

  return {
    version: 1,
    regions: {
      global: normalizeRegionPreferences("global", input.regions.global),
      europe: normalizeRegionPreferences("europe", input.regions.europe),
      americas: normalizeRegionPreferences("americas", input.regions.americas),
      "middle-east": normalizeRegionPreferences("middle-east", input.regions["middle-east"]),
      asia: normalizeRegionPreferences("asia", input.regions.asia),
      africa: normalizeRegionPreferences("africa", input.regions.africa),
      oceania: normalizeRegionPreferences("oceania", input.regions.oceania),
    },
  };
}

export function loadLiveNewsChannelPreferences(): LiveNewsChannelPreferences {
  if (typeof window === "undefined") {
    return buildDefaultLiveNewsChannelPreferences();
  }

  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return buildDefaultLiveNewsChannelPreferences();
    }
    return normalizeLiveNewsChannelPreferences(JSON.parse(raw));
  } catch {
    return buildDefaultLiveNewsChannelPreferences();
  }
}

export function saveLiveNewsChannelPreferences(preferences: LiveNewsChannelPreferences): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore quota and private-mode localStorage errors.
  }
}

export function getOrderedRegionChannels(
  region: LiveNewsRegion,
  preferences: LiveNewsChannelPreferences,
): LiveNewsChannel[] {
  const all = getChannelsByRegion(region);
  const byId = new Map(all.map((channel) => [channel.id, channel]));
  const order = preferences.regions[region].order;

  const ordered: LiveNewsChannel[] = [];
  for (const id of order) {
    const channel = byId.get(id);
    if (channel) {
      ordered.push(channel);
    }
  }

  for (const channel of all) {
    if (!ordered.some((entry) => entry.id === channel.id)) {
      ordered.push(channel);
    }
  }

  return ordered;
}

export function resolveRegionChannels(
  region: LiveNewsRegion,
  preferences: LiveNewsChannelPreferences,
  maxVisible = DEFAULT_MAX_VISIBLE_CHANNELS,
): LiveNewsChannel[] {
  const ordered = getOrderedRegionChannels(region, preferences);
  const enabled = new Set(preferences.regions[region].enabled);
  const visible = ordered.filter((channel) => enabled.has(channel.id));

  if (visible.length === 0) {
    return ordered.slice(0, maxVisible);
  }

  return visible.slice(0, maxVisible);
}

export function reorderRegionChannelIds(order: string[], fromId: string, toId: string): string[] {
  if (fromId === toId) {
    return order;
  }

  const fromIndex = order.indexOf(fromId);
  const toIndex = order.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0) {
    return order;
  }

  const next = [...order];
  next.splice(fromIndex, 1);
  next.splice(toIndex, 0, fromId);
  return next;
}

export function markHlsFailure(
  map: Map<string, number>,
  channelId: string,
  now = Date.now(),
  cooldownMs = HLS_RETRY_COOLDOWN_MS,
): number {
  const until = now + cooldownMs;
  map.set(channelId, until);
  return until;
}

export function getHlsCooldownUntil(
  map: Map<string, number>,
  channelId: string,
  now = Date.now(),
): number | null {
  const until = map.get(channelId);
  if (!until) {
    return null;
  }
  if (until <= now) {
    map.delete(channelId);
    return null;
  }
  return until;
}

export function shouldResolveYoutubeLiveId(params: {
  sourceMode: LiveNewsSourceMode;
  youtubeHandle?: string;
  allowYoutubeFallback: boolean;
  forceYoutube: boolean;
  cooldownUntil: number | null;
  proxyConfigured?: boolean;
  now?: number;
}): boolean {
  const {
    sourceMode,
    youtubeHandle,
    allowYoutubeFallback,
    forceYoutube,
    cooldownUntil,
    proxyConfigured,
    now = Date.now(),
  } = params;

  if (!youtubeHandle) {
    return false;
  }

  if (sourceMode === "youtube-only") {
    return true;
  }

  if (!allowYoutubeFallback) {
    return false;
  }

  const inCooldown = typeof cooldownUntil === "number" && cooldownUntil > now;
  if (forceYoutube || inCooldown) {
    return true;
  }

  if (sourceMode === "hls-proxy" && proxyConfigured === false) {
    return true;
  }

  return false;
}

export function resolveLiveNewsPlaybackMode(params: {
  hlsUrl: string | null;
  cooldownUntil: number | null;
  forceYoutube: boolean;
  allowYoutubeFallback: boolean;
  youtubeVideoId?: string | null;
  now?: number;
}): LiveNewsPlaybackMode {
  const {
    hlsUrl,
    cooldownUntil,
    forceYoutube,
    allowYoutubeFallback,
    youtubeVideoId,
    now = Date.now(),
  } = params;

  const inCooldown = typeof cooldownUntil === "number" && cooldownUntil > now;
  const canUseYoutube = Boolean(allowYoutubeFallback && youtubeVideoId);

  if (hlsUrl && !inCooldown && !(forceYoutube && canUseYoutube)) {
    return "hls";
  }

  if (canUseYoutube) {
    return "youtube";
  }

  return "hls-only";
}
