"use client";

import { Alert, Button, Card, Space, Tag, Typography } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMediaActivation } from "./use-media-activation";

type LiveNewsRegion = "global" | "europe" | "americas" | "middle-east" | "asia";

interface LiveNewsChannel {
  id: string;
  name: string;
  region: LiveNewsRegion;
  hlsUrl?: string;
  youtubeVideoId: string;
}

const LIVE_NEWS_REGIONS: { key: LiveNewsRegion; labelKey: string; defaultLabel: string }[] = [
  { key: "global", labelKey: "situationMonitor.liveNews.region.global", defaultLabel: "Global" },
  { key: "europe", labelKey: "situationMonitor.liveNews.region.europe", defaultLabel: "Europe" },
  { key: "americas", labelKey: "situationMonitor.liveNews.region.americas", defaultLabel: "Americas" },
  { key: "middle-east", labelKey: "situationMonitor.liveNews.region.middleEast", defaultLabel: "Middle East" },
  { key: "asia", labelKey: "situationMonitor.liveNews.region.asia", defaultLabel: "Asia" },
];

const LIVE_NEWS_CHANNELS: LiveNewsChannel[] = [
  { id: "bloomberg", name: "Bloomberg", region: "global", youtubeVideoId: "iEpJwprxDdk" },
  {
    id: "skynews",
    name: "Sky News",
    region: "europe",
    hlsUrl: "https://linear901-oo-hls0-prd-gtm.delivery.skycdp.com/17501/sde-fast-skynews/master.m3u8",
    youtubeVideoId: "9Auq9mYxFEE",
  },
  {
    id: "france24",
    name: "France 24",
    region: "europe",
    hlsUrl: "https://amg00106-france24-france24-samsunguk-qvpp8.amagi.tv/playlist/amg00106-france24-france24-samsunguk/playlist.m3u8",
    youtubeVideoId: "Ap-UM1O9RBU",
  },
  { id: "cnn", name: "CNN", region: "americas", youtubeVideoId: "w_Ma8oQLmSM" },
  { id: "cnbc", name: "CNBC", region: "americas", youtubeVideoId: "9NyxcX3rhQs" },
  {
    id: "aljazeera",
    name: "Al Jazeera",
    region: "middle-east",
    youtubeVideoId: "gCNeDWCI0vo",
  },
  {
    id: "alarabiya",
    name: "Al Arabiya",
    region: "middle-east",
    hlsUrl: "https://live.alarabiya.net/alarabiapublish/alarabiya.smil/playlist.m3u8",
    youtubeVideoId: "n7eQejkXbnM",
  },
  { id: "trtworld", name: "TRT World", region: "middle-east", youtubeVideoId: "ABfFhWzWs0s" },
  { id: "wion", name: "WION", region: "asia", youtubeVideoId: "L0R6h7QvoX8" },
  { id: "cna", name: "CNA", region: "asia", youtubeVideoId: "XWq5kBlakcQ" },
  { id: "nhk", name: "NHK World", region: "asia", youtubeVideoId: "f0lYfG_vY_U" },
];

const HLS_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

function buildYoutubeEmbedUrl(videoId: string): string {
  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    controls: "0",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
  });
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

function LiveNewsVideoTile(props: {
  channel: LiveNewsChannel;
  active: boolean;
  fallbackLabel: string;
  cooldownLabel: string;
  unavailableLabel: string;
}) {
  const { channel, active, fallbackLabel, cooldownLabel, unavailableLabel } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [forceYoutube, setForceYoutube] = useState(!channel.hlsUrl);
  const [hlsCooldownUntil, setHlsCooldownUntil] = useState<number | null>(null);

  const cooldownActive =
    typeof hlsCooldownUntil === "number" && hlsCooldownUntil > Date.now();
  const shouldUseYoutube = forceYoutube || !channel.hlsUrl || cooldownActive;

  const enableYoutubeFallback = useCallback(() => {
    setForceYoutube(true);
    if (channel.hlsUrl) {
      setHlsCooldownUntil(Date.now() + HLS_RETRY_COOLDOWN_MS);
    }
  }, [channel.hlsUrl]);

  useEffect(() => {
    setForceYoutube(!channel.hlsUrl);
    setHlsCooldownUntil(null);
  }, [channel.id, channel.hlsUrl]);

  useEffect(() => {
    if (typeof hlsCooldownUntil !== "number") {
      return;
    }

    const remaining = hlsCooldownUntil - Date.now();
    if (remaining <= 0) {
      setHlsCooldownUntil(null);
      setForceYoutube(!channel.hlsUrl);
      return;
    }

    const timer = setTimeout(() => {
      setHlsCooldownUntil(null);
      setForceYoutube(!channel.hlsUrl);
    }, remaining);

    return () => clearTimeout(timer);
  }, [channel.hlsUrl, hlsCooldownUntil]);

  useEffect(() => {
    if (!active) {
      return;
    }

    if (shouldUseYoutube) {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    let destroyed = false;
    let hlsInstance: {
      destroy: () => void;
      loadSource: (source: string) => void;
      attachMedia: (media: HTMLMediaElement) => void;
      on: (event: string, listener: (event: string, data: { fatal?: boolean }) => void) => void;
    } | null = null;

    const init = async () => {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = channel.hlsUrl ?? "";
        try {
          await video.play();
        } catch {
          enableYoutubeFallback();
        }
        return;
      }

      try {
        const hlsModule = (await import("hls.js")) as unknown as {
          default: new (config?: Record<string, unknown>) => {
            destroy: () => void;
            loadSource: (source: string) => void;
            attachMedia: (media: HTMLMediaElement) => void;
            on: (
              event: string,
              listener: (event: string, data: { fatal?: boolean }) => void,
            ) => void;
          };
          isSupported: () => boolean;
          Events: { ERROR: string };
        };

        if (destroyed || !hlsModule.isSupported()) {
          enableYoutubeFallback();
          return;
        }

        hlsInstance = new hlsModule.default({
          lowLatencyMode: true,
          backBufferLength: 90,
        });
        hlsInstance.loadSource(channel.hlsUrl ?? "");
        hlsInstance.attachMedia(video);
        hlsInstance.on(hlsModule.Events.ERROR, (_event, data) => {
          if (data?.fatal) {
            enableYoutubeFallback();
          }
        });
      } catch {
        enableYoutubeFallback();
      }
    };

    void init();

    return () => {
      destroyed = true;
      if (hlsInstance) {
        hlsInstance.destroy();
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [active, channel.hlsUrl, enableYoutubeFallback, shouldUseYoutube]);

  if (!active) {
    return (
      <div className="flex h-[180px] items-center justify-center rounded border border-[var(--border)] bg-black/20 text-xs text-[var(--text-muted)]">
        {unavailableLabel}
      </div>
    );
  }

  if (shouldUseYoutube) {
    return (
      <div className="relative h-[180px] overflow-hidden rounded border border-[var(--border)] bg-black">
        {channel.hlsUrl ? (
          <Tag color="orange" style={{ position: "absolute", top: 8, left: 8, zIndex: 2 }}>
            {cooldownActive ? cooldownLabel : fallbackLabel}
          </Tag>
        ) : null}
        <iframe
          title={`${channel.name} live`}
          src={buildYoutubeEmbedUrl(channel.youtubeVideoId)}
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          style={{ width: "100%", height: "100%", border: 0 }}
        />
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      controls={false}
      className="h-[180px] w-full rounded border border-[var(--border)] bg-black object-cover"
    />
  );
}

export function SituationMonitorLiveNewsPanel() {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activation = useMediaActivation(rootRef);
  const [region, setRegion] = useState<LiveNewsRegion>("global");

  const channels = useMemo(() => {
    const selected = LIVE_NEWS_CHANNELS.filter((channel) => channel.region === region);
    return selected.slice(0, 4);
  }, [region]);

  const inactiveReason = activation.hidden
    ? t("situationMonitor.liveNews.hidden", { defaultValue: "Background tab: stream paused." })
    : t("situationMonitor.liveNews.idle", { defaultValue: "Idle pause: move mouse or press key to resume." });

  return (
    <div ref={rootRef} className="h-full">
      <Card
        title={t("situationMonitor.liveNews.title", { defaultValue: "Live News" })}
        className="sm-panel-card glass-panel border border-[var(--border)] h-full"
        size="small"
      >
        <Space wrap size={6} style={{ marginBottom: 10 }}>
          {LIVE_NEWS_REGIONS.map((option) => (
            <Button
              key={option.key}
              size="small"
              type={option.key === region ? "primary" : "default"}
              onClick={() => setRegion(option.key)}
            >
              {t(option.labelKey, { defaultValue: option.defaultLabel })}
            </Button>
          ))}
        </Space>

        {!activation.active ? (
          <Alert type="info" showIcon message={inactiveReason} />
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {channels.map((channel) => (
              <div key={channel.id}>
                <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
                  {channel.name}
                </Typography.Text>
                <LiveNewsVideoTile
                  channel={channel}
                  active={activation.active}
                  fallbackLabel={t("situationMonitor.liveNews.hlsFallback", {
                    defaultValue: "HLS fallback",
                  })}
                  cooldownLabel={t("situationMonitor.liveNews.hlsCooldown", {
                    defaultValue: "HLS cooldown",
                  })}
                  unavailableLabel={t("situationMonitor.liveNews.unavailable", {
                    defaultValue: "Stream paused",
                  })}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
