"use client";

import { Alert, Button, Card, Space, Tag, Typography } from "antd";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMediaActivation } from "./use-media-activation";

type WebcamRegion = "all" | "iran" | "middle-east" | "europe" | "americas" | "asia";

interface WebcamFeed {
  id: string;
  city: string;
  country: string;
  region: Exclude<WebcamRegion, "all">;
  videoId: string;
}

const WEBCAM_FEEDS: WebcamFeed[] = [
  { id: "iran-tehran", city: "Tehran", country: "Iran", region: "iran", videoId: "-zGuR1qVKrU" },
  { id: "iran-telaviv", city: "Tel Aviv", country: "Israel", region: "iran", videoId: "gmtlJ_m2r5A" },
  { id: "iran-jerusalem", city: "Jerusalem", country: "Israel", region: "iran", videoId: "JHwwZRH2wz8" },
  { id: "iran-multicam", city: "Middle East", country: "Multi", region: "iran", videoId: "4E-iFtUM2kk" },
  { id: "jerusalem", city: "Jerusalem", country: "Israel", region: "middle-east", videoId: "UyduhBUpO7Q" },
  { id: "tehran", city: "Tehran", country: "Iran", region: "middle-east", videoId: "-zGuR1qVKrU" },
  { id: "tel-aviv", city: "Tel Aviv", country: "Israel", region: "middle-east", videoId: "gmtlJ_m2r5A" },
  { id: "mecca", city: "Mecca", country: "Saudi Arabia", region: "middle-east", videoId: "DEcpmPUbkDQ" },
  { id: "kyiv", city: "Kyiv", country: "Ukraine", region: "europe", videoId: "-Q7FuPINDjA" },
  { id: "odessa", city: "Odessa", country: "Ukraine", region: "europe", videoId: "e2gC37ILQmk" },
  { id: "paris", city: "Paris", country: "France", region: "europe", videoId: "OzYp4NRZlwQ" },
  { id: "st-petersburg", city: "St. Petersburg", country: "Russia", region: "europe", videoId: "CjtIYbmVfck" },
  { id: "london", city: "London", country: "UK", region: "europe", videoId: "Lxqcg1qt0XU" },
  { id: "washington", city: "Washington DC", country: "USA", region: "americas", videoId: "1wV9lLe14aU" },
  { id: "new-york", city: "New York", country: "USA", region: "americas", videoId: "4qyZLflp-sI" },
  { id: "los-angeles", city: "Los Angeles", country: "USA", region: "americas", videoId: "EO_1LWqsCNE" },
  { id: "miami", city: "Miami", country: "USA", region: "americas", videoId: "5YCajRjvWCg" },
  { id: "taipei", city: "Taipei", country: "Taiwan", region: "asia", videoId: "z_fY1pj1VBw" },
  { id: "shanghai", city: "Shanghai", country: "China", region: "asia", videoId: "76EwqI5XZIc" },
  { id: "tokyo", city: "Tokyo", country: "Japan", region: "asia", videoId: "4pu9sF5Qssw" },
  { id: "seoul", city: "Seoul", country: "South Korea", region: "asia", videoId: "-JhoMGoAfFc" },
  { id: "sydney", city: "Sydney", country: "Australia", region: "asia", videoId: "7pcL-0Wo77U" },
];

const REGION_OPTIONS: { key: WebcamRegion; labelKey: string; defaultLabel: string }[] = [
  { key: "iran", labelKey: "situationMonitor.liveWebcams.region.iran", defaultLabel: "Iran Attacks" },
  { key: "all", labelKey: "situationMonitor.liveWebcams.region.all", defaultLabel: "All" },
  { key: "middle-east", labelKey: "situationMonitor.liveWebcams.region.middleEast", defaultLabel: "Middle East" },
  { key: "europe", labelKey: "situationMonitor.liveWebcams.region.europe", defaultLabel: "Europe" },
  { key: "americas", labelKey: "situationMonitor.liveWebcams.region.americas", defaultLabel: "Americas" },
  { key: "asia", labelKey: "situationMonitor.liveWebcams.region.asia", defaultLabel: "Asia" },
];

const ALL_REGION_IDS = ["jerusalem", "tehran", "kyiv", "washington"] as const;

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

export function SituationMonitorLiveWebcamsPanel() {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activation = useMediaActivation(rootRef);
  const [region, setRegion] = useState<WebcamRegion>("iran");

  const feeds = useMemo(() => {
    if (region === "all") {
      return ALL_REGION_IDS.map((id) => WEBCAM_FEEDS.find((entry) => entry.id === id)).filter(
        (entry): entry is WebcamFeed => Boolean(entry),
      );
    }
    return WEBCAM_FEEDS.filter((entry) => entry.region === region).slice(0, 4);
  }, [region]);

  const inactiveReason = activation.hidden
    ? t("situationMonitor.liveWebcams.hidden")
    : t("situationMonitor.liveWebcams.idle");

  return (
    <div ref={rootRef} className="h-full">
      <Card
        title={t("situationMonitor.liveWebcams.title")}
        className="sm-panel-card glass-panel border border-[var(--border)] h-full"
        size="small"
      >
        <Space wrap size={6} style={{ marginBottom: 10 }}>
          {REGION_OPTIONS.map((option) => (
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
            {feeds.map((feed) => (
              <div key={feed.id}>
                <Space size={6} wrap style={{ marginBottom: 6 }}>
                  <Typography.Text strong>{feed.city}</Typography.Text>
                  <Tag color="default">{feed.country}</Tag>
                </Space>
                <iframe
                  title={`${feed.city} webcam`}
                  src={buildYoutubeEmbedUrl(feed.videoId)}
                  allow="autoplay; encrypted-media; picture-in-picture"
                  referrerPolicy="strict-origin-when-cross-origin"
                  style={{
                    width: "100%",
                    height: 180,
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    background: "#000",
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
