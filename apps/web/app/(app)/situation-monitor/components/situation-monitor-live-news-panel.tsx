"use client";

import { SettingOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Checkbox, Modal, Space, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  buildDefaultLiveNewsChannelPreferences,
  canFallbackToYoutube,
  DEFAULT_MAX_VISIBLE_CHANNELS,
  getChannelHlsUrl,
  getHlsCooldownUntil,
  getOrderedRegionChannels,
  LIVE_NEWS_REGIONS,
  loadLiveNewsChannelPreferences,
  markHlsFailure,
  PROXIED_HLS_CHANNELS,
  reorderRegionChannelIds,
  resolveLiveNewsPlaybackMode,
  resolveRegionChannels,
  saveLiveNewsChannelPreferences,
  shouldResolveYoutubeLiveId,
  type LiveNewsChannel,
  type LiveNewsChannelPreferences,
  type LiveNewsRegion,
  type ProxiedHlsChannel,
} from "@/lib/situation-monitor-live-news";
import { fetchSituationMonitorYouTubeLiveInfo } from "@/lib/situation-monitor-youtube-live";

import { useMediaActivation } from "./use-media-activation";

type ProxyProbeState = "unknown" | "checking" | "configured" | "unconfigured";

const DEFAULT_PROXY_PROBE_STATE: Record<ProxiedHlsChannel, ProxyProbeState> = {
  cnn: "unknown",
  cnbc: "unknown",
};

function stopSituationMonitorInteractiveEvent(event: {
  stopPropagation: () => void;
}) {
  event.stopPropagation();
}

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

function asProxyConfigured(state: ProxyProbeState | undefined): boolean | undefined {
  if (state === "configured") {
    return true;
  }
  if (state === "unconfigured") {
    return false;
  }
  return undefined;
}

function LiveNewsVideoTile(props: {
  channel: LiveNewsChannel;
  active: boolean;
  cooldownUntil: number | null;
  proxyConfigured: boolean | undefined;
  onHlsFailure: (channelId: string) => void;
  fallbackLabel: string;
  cooldownLabel: string;
  hlsOnlyLabel: string;
  proxyUnavailableLabel: string;
  resolvingYoutubeLabel: string;
  youtubeUnavailableLabel: string;
  unavailableLabel: string;
}) {
  const {
    channel,
    active,
    cooldownUntil,
    proxyConfigured,
    onHlsFailure,
    fallbackLabel,
    cooldownLabel,
    hlsOnlyLabel,
    proxyUnavailableLabel,
    resolvingYoutubeLabel,
    youtubeUnavailableLabel,
    unavailableLabel,
  } = props;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [forceYoutube, setForceYoutube] = useState(channel.sourceMode === "youtube-only");
  const [resolvedYoutubeVideoId, setResolvedYoutubeVideoId] = useState<string | null>(
    channel.fallbackVideoId ?? null,
  );
  const [resolvingYoutube, setResolvingYoutube] = useState(false);

  const baseHlsUrl = useMemo(() => getChannelHlsUrl(channel), [channel]);
  const hlsUrl = useMemo(() => {
    if (channel.sourceMode === "hls-proxy" && proxyConfigured === false) {
      return null;
    }
    return baseHlsUrl;
  }, [baseHlsUrl, channel.sourceMode, proxyConfigured]);

  const cooldownActive =
    typeof cooldownUntil === "number" && cooldownUntil > Date.now();

  useEffect(() => {
    setForceYoutube(channel.sourceMode === "youtube-only");
    setResolvedYoutubeVideoId(channel.fallbackVideoId ?? null);
    setResolvingYoutube(false);
  }, [channel.fallbackVideoId, channel.id, channel.sourceMode]);

  useEffect(() => {
    if (channel.sourceMode === "youtube-only") {
      return;
    }
    if (cooldownActive) {
      return;
    }
    setForceYoutube(false);
  }, [channel.sourceMode, cooldownActive]);

  const playbackMode = resolveLiveNewsPlaybackMode({
    hlsUrl,
    cooldownUntil,
    forceYoutube,
    allowYoutubeFallback: channel.allowYoutubeFallback,
    youtubeVideoId: resolvedYoutubeVideoId,
  });

  const shouldTryHls = playbackMode === "hls";
  const shouldUseYoutube = playbackMode === "youtube";
  const hasYoutubeFallback = canFallbackToYoutube(channel);
  const shouldResolveYoutube = shouldResolveYoutubeLiveId({
    sourceMode: channel.sourceMode,
    youtubeHandle: channel.youtubeHandle,
    allowYoutubeFallback: channel.allowYoutubeFallback,
    forceYoutube,
    cooldownUntil,
    proxyConfigured,
  });

  useEffect(() => {
    if (!active || !shouldResolveYoutube || !channel.youtubeHandle) {
      return;
    }

    let cancelled = false;
    setResolvingYoutube(true);

    void fetchSituationMonitorYouTubeLiveInfo(channel.youtubeHandle)
      .then((info) => {
        if (cancelled) {
          return;
        }
        if (info.videoId) {
          setResolvedYoutubeVideoId(info.videoId);
        } else {
          setResolvedYoutubeVideoId(channel.fallbackVideoId ?? null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setResolvingYoutube(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, channel.fallbackVideoId, channel.youtubeHandle, shouldResolveYoutube]);

  useEffect(() => {
    if (!active || !shouldTryHls || !hlsUrl) {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    let destroyed = false;
    let handledFailure = false;
    let hlsInstance: {
      destroy: () => void;
      loadSource: (source: string) => void;
      attachMedia: (media: HTMLMediaElement) => void;
      on: (event: string, listener: (event: string, data: { fatal?: boolean }) => void) => void;
    } | null = null;

    const handleFailure = () => {
      if (handledFailure) {
        return;
      }
      handledFailure = true;
      onHlsFailure(channel.id);
      if (hasYoutubeFallback) {
        setForceYoutube(true);
      }
    };

    const onVideoError = () => {
      handleFailure();
    };

    const init = async () => {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hlsUrl;
        try {
          await video.play();
        } catch {
          handleFailure();
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
          handleFailure();
          return;
        }

        hlsInstance = new hlsModule.default({
          lowLatencyMode: true,
          backBufferLength: 90,
        });
        hlsInstance.loadSource(hlsUrl);
        hlsInstance.attachMedia(video);
        hlsInstance.on(hlsModule.Events.ERROR, (_event, data) => {
          if (data?.fatal) {
            handleFailure();
          }
        });
      } catch {
        handleFailure();
      }
    };

    video.addEventListener("error", onVideoError);
    void init();

    return () => {
      destroyed = true;
      video.removeEventListener("error", onVideoError);
      if (hlsInstance) {
        hlsInstance.destroy();
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [
    active,
    channel.id,
    hasYoutubeFallback,
    hlsUrl,
    onHlsFailure,
    shouldTryHls,
  ]);

  if (!active) {
    return (
      <div className="flex h-viz-xs items-center justify-center rounded border border-[var(--border)] bg-black/20 text-xs text-[var(--text-muted)]">
        {unavailableLabel}
      </div>
    );
  }

  if (shouldUseYoutube && resolvedYoutubeVideoId) {
    return (
      <div className="relative h-viz-xs overflow-hidden rounded border border-[var(--border)] bg-black">
        {hlsUrl ? (
          <Tag color="orange" style={{ position: "absolute", top: 8, left: 8, zIndex: 2 }}>
            {cooldownActive ? cooldownLabel : fallbackLabel}
          </Tag>
        ) : channel.sourceMode === "hls-proxy" && proxyConfigured === false ? (
          <Tag color="default" style={{ position: "absolute", top: 8, left: 8, zIndex: 2 }}>
            {proxyUnavailableLabel}
          </Tag>
        ) : null}
        <iframe
          title={`${channel.name} live`}
          src={buildYoutubeEmbedUrl(resolvedYoutubeVideoId)}
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          style={{ width: "100%", height: "100%", border: 0 }}
        />
      </div>
    );
  }

  if (!shouldTryHls && resolvingYoutube) {
    return (
      <div className="flex h-viz-xs items-center justify-center rounded border border-[var(--border)] bg-black/30 text-xs text-[var(--text-muted)]">
        {resolvingYoutubeLabel}
      </div>
    );
  }

  if (!shouldTryHls) {
    const statusLabel =
      channel.sourceMode === "youtube-only"
        ? youtubeUnavailableLabel
        : cooldownActive
          ? cooldownLabel
          : channel.sourceMode === "hls-proxy" && proxyConfigured === false
            ? proxyUnavailableLabel
            : hlsOnlyLabel;
    const statusColor =
      channel.sourceMode === "youtube-only" ? "default" : cooldownActive ? "orange" : "red";

    return (
      <div className="relative flex h-viz-xs items-center justify-center rounded border border-[var(--border)] bg-black/30 text-xs text-[var(--text-muted)]">
        <Tag color={statusColor} style={{ position: "absolute", top: 8, left: 8 }}>
          {statusLabel}
        </Tag>
        {statusLabel}
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
      className="h-viz-xs w-full rounded border border-[var(--border)] bg-black object-cover"
    />
  );
}

export function SituationMonitorLiveNewsPanel() {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activation = useMediaActivation(rootRef);

  const [region, setRegion] = useState<LiveNewsRegion>("global");
  const [preferences, setPreferences] = useState<LiveNewsChannelPreferences>(() =>
    loadLiveNewsChannelPreferences(),
  );
  const [manageOpen, setManageOpen] = useState(false);
  const [draggingChannelId, setDraggingChannelId] = useState<string | null>(null);
  const [proxyProbeState, setProxyProbeState] = useState<Record<ProxiedHlsChannel, ProxyProbeState>>(
    DEFAULT_PROXY_PROBE_STATE,
  );
  const [, setCooldownVersion] = useState(0);

  const hlsCooldownRef = useRef<Map<string, number>>(new Map());
  const hlsCooldownTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    saveLiveNewsChannelPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    return () => {
      for (const timer of hlsCooldownTimersRef.current.values()) {
        clearTimeout(timer);
      }
      hlsCooldownTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const probe = async (channel: ProxiedHlsChannel) => {
      setProxyProbeState((current) => ({
        ...current,
        [channel]: "checking",
      }));

      try {
        const response = await fetch(
          `/api/situation-monitor/hls-proxy?channel=${encodeURIComponent(channel)}&probe=1`,
          {
            method: "GET",
            cache: "no-store",
          },
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as { configured?: boolean };
        const configured = payload.configured === true;

        if (!cancelled) {
          setProxyProbeState((current) => ({
            ...current,
            [channel]: configured ? "configured" : "unconfigured",
          }));
        }
      } catch {
        if (!cancelled) {
          setProxyProbeState((current) => ({
            ...current,
            [channel]: "unconfigured",
          }));
        }
      }
    };

    for (const channel of PROXIED_HLS_CHANNELS) {
      void probe(channel);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const markChannelHlsFailure = useCallback((channelId: string) => {
    const cooldownUntil = markHlsFailure(hlsCooldownRef.current, channelId);

    const existingTimer = hlsCooldownTimersRef.current.get(channelId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      hlsCooldownRef.current.delete(channelId);
      hlsCooldownTimersRef.current.delete(channelId);
      setCooldownVersion((value) => value + 1);
    }, Math.max(0, cooldownUntil - Date.now()));

    hlsCooldownTimersRef.current.set(channelId, timer);
    setCooldownVersion((value) => value + 1);
  }, []);

  const channels = useMemo(
    () => resolveRegionChannels(region, preferences, DEFAULT_MAX_VISIBLE_CHANNELS),
    [preferences, region],
  );

  const orderedRegionChannels = useMemo(
    () => getOrderedRegionChannels(region, preferences),
    [preferences, region],
  );

  const regionEnabledSet = useMemo(
    () => new Set(preferences.regions[region].enabled),
    [preferences, region],
  );

  const inactiveReason = activation.hidden
    ? t("situationMonitor.liveNews.hidden")
    : t("situationMonitor.liveNews.idle");

  const handleToggleChannel = useCallback(
    (channelId: string, checked: boolean) => {
      setPreferences((current) => {
        const regionPreferences = current.regions[region];
        const enabledSet = new Set(regionPreferences.enabled);
        if (checked) {
          enabledSet.add(channelId);
        } else {
          enabledSet.delete(channelId);
        }

        return {
          ...current,
          regions: {
            ...current.regions,
            [region]: {
              ...regionPreferences,
              enabled: [...enabledSet],
            },
          },
        };
      });
    },
    [region],
  );

  const handleDropChannel = useCallback(
    (targetChannelId: string) => {
      if (!draggingChannelId || draggingChannelId === targetChannelId) {
        return;
      }

      setPreferences((current) => {
        const regionPreferences = current.regions[region];
        return {
          ...current,
          regions: {
            ...current.regions,
            [region]: {
              ...regionPreferences,
              order: reorderRegionChannelIds(regionPreferences.order, draggingChannelId, targetChannelId),
            },
          },
        };
      });
      setDraggingChannelId(null);
    },
    [draggingChannelId, region],
  );

  const handleResetRegion = useCallback(() => {
    const defaults = buildDefaultLiveNewsChannelPreferences();
    setPreferences((current) => ({
      ...current,
      regions: {
        ...current.regions,
        [region]: defaults.regions[region],
      },
    }));
  }, [region]);

  const interactiveControlProps = {
    "data-sm-interactive": true,
    onPointerDown: stopSituationMonitorInteractiveEvent,
    onMouseDown: stopSituationMonitorInteractiveEvent,
  } as const;

  return (
    <div ref={rootRef} className="h-full">
      <Card
        title={t("situationMonitor.liveNews.title")}
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

          <Tooltip
            title={t("situationMonitor.liveNews.manageHint")}
          >
            <Button
              size="small"
              icon={<SettingOutlined />}
              {...interactiveControlProps}
              onClick={() => setManageOpen(true)}
            >
              {t("situationMonitor.liveNews.manage")}
            </Button>
          </Tooltip>

          <Tag color="default">
            {t("situationMonitor.liveNews.visibleCount", {
              count: channels.length,
              max: DEFAULT_MAX_VISIBLE_CHANNELS,
            })}
          </Tag>
        </Space>

        {!activation.active ? (
          <Alert type="info" showIcon message={inactiveReason} />
        ) : channels.length === 0 ? (
          <Alert
            type="info"
            showIcon
            message={t("situationMonitor.liveNews.noChannelSelected")}
          />
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
                  cooldownUntil={getHlsCooldownUntil(hlsCooldownRef.current, channel.id)}
                  proxyConfigured={
                    channel.proxyChannel
                      ? asProxyConfigured(proxyProbeState[channel.proxyChannel])
                      : undefined
                  }
                  onHlsFailure={markChannelHlsFailure}
                  fallbackLabel={t("situationMonitor.liveNews.hlsFallback")}
                  cooldownLabel={t("situationMonitor.liveNews.hlsCooldown")}
                  hlsOnlyLabel={t("situationMonitor.liveNews.hlsOnly")}
                  proxyUnavailableLabel={t("situationMonitor.liveNews.proxyUnavailable")}
                  resolvingYoutubeLabel={t("situationMonitor.liveNews.resolvingYoutube")}
                  youtubeUnavailableLabel={t("situationMonitor.liveNews.youtubeUnavailable")}
                  unavailableLabel={t("situationMonitor.liveNews.unavailable")}
                />
              </div>
            ))}
          </div>
        )}

        <Modal
          title={t("situationMonitor.liveNews.manage")}
          open={manageOpen}
          onCancel={() => setManageOpen(false)}
          footer={[
            <Button key="reset" onClick={handleResetRegion}>
              {t("situationMonitor.liveNews.resetRegion")}
            </Button>,
            <Button key="close" type="primary" onClick={() => setManageOpen(false)}>
              {t("common.close")}
            </Button>,
          ]}
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            {t("situationMonitor.liveNews.manageHint")}
          </Typography.Paragraph>

          <div className="max-h-viz-lg overflow-auto pr-1">
            {orderedRegionChannels.map((channel) => {
              const enabled = regionEnabledSet.has(channel.id);
              const visible = enabled && channels.some((entry) => entry.id === channel.id);

              return (
                <div
                  key={channel.id}
                  draggable
                  onDragStart={() => setDraggingChannelId(channel.id)}
                  onDragOver={(event) => {
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    handleDropChannel(channel.id);
                  }}
                  onDragEnd={() => setDraggingChannelId(null)}
                  className="mb-2 flex items-center justify-between rounded border border-[var(--border)] px-2 py-1"
                >
                  <Space size={8} align="center">
                    <span
                      style={{
                        cursor: "grab",
                        fontSize: 12,
                        color: "var(--text-muted)",
                        userSelect: "none",
                      }}
                    >
                      ::
                    </span>
                    <Checkbox
                      checked={enabled}
                      onChange={(event) => handleToggleChannel(channel.id, event.target.checked)}
                    />
                    <Typography.Text>{channel.name}</Typography.Text>
                    {visible ? (
                      <Tag color="blue">
                        {t("situationMonitor.liveNews.inGrid")}
                      </Tag>
                    ) : null}
                  </Space>

                  <Tag color="default">{channel.sourceMode}</Tag>
                </div>
              );
            })}
          </div>
        </Modal>
      </Card>
    </div>
  );
}
