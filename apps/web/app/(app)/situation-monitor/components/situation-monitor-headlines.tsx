"use client";

import { FileSearchOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { Button, Popover, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type {
  SituationMonitorEventCluster,
  SituationMonitorHeadline,
} from "../types/situation-monitor-content";
import type { SituationMonitorMatchResult } from "../types/situation-monitor-monitors";
import {
  buildMonitorMatchKey,
  collectMonitorMatchesForKeys,
  getDefaultMonitorReasonLabel,
} from "../utils/monitor-matches";

export interface UseSituationMonitorHeadlinesOptions {
  translateToZh: boolean;
  monitorMatchesByKey: Map<string, SituationMonitorMatchResult[]>;
  monitorColorById: Map<string, string>;
}

export function useSituationMonitorHeadlines(
  options: UseSituationMonitorHeadlinesOptions,
) {
  const { t } = useTranslation();
  const { translateToZh, monitorMatchesByKey, monitorColorById } = options;

  const renderHeadlineSummary = (entry: SituationMonitorHeadline) => {
    const rawSummary = translateToZh
      ? (entry.summaryZh ?? entry.summary)
      : entry.summary;
    const summary = typeof rawSummary === "string" ? rawSummary.trim() : "";
    if (!summary) return null;
    return (
      <Typography.Paragraph
        type="secondary"
        ellipsis={{ rows: 2 }}
        style={{ marginBottom: 0 }}
      >
        {summary}
      </Typography.Paragraph>
    );
  };

  const renderHeadlineTopics = (entry: SituationMonitorHeadline, limit = 3) => {
    const topics = Array.isArray(entry.topics)
      ? entry.topics
          .filter(
            (topic) => typeof topic === "string" && topic.trim().length > 0,
          )
          .slice(0, limit)
      : [];
    if (topics.length === 0) return null;
    return topics.map((topic) => (
      <Tag
        key={`${entry.id}:${topic}`}
        color="default"
        className="cursor-pointer"
        onClick={() =>
          window.open(
            `/search?q=${encodeURIComponent(topic)}`,
            "_blank",
            "noopener,noreferrer",
          )
        }
      >
        {topic}
      </Tag>
    ));
  };

  const renderHeadlineDetails = (entry: SituationMonitorHeadline) => {
    const summarySource = translateToZh
      ? (entry.summaryZh ?? entry.summary)
      : entry.summary;
    const summary =
      typeof summarySource === "string" ? summarySource.trim() : "";

    const keyPointsSource = translateToZh
      ? (entry.keyPointsZh ?? entry.keyPoints)
      : entry.keyPoints;
    const keyPoints = Array.isArray(keyPointsSource)
      ? keyPointsSource
          .filter(
            (point) => typeof point === "string" && point.trim().length > 0,
          )
          .slice(0, 5)
      : [];
    const topics = Array.isArray(entry.topics)
      ? entry.topics
          .filter(
            (topic) => typeof topic === "string" && topic.trim().length > 0,
          )
          .slice(0, 12)
      : [];

    if (!summary && keyPoints.length === 0 && topics.length === 0) {
      return null;
    }

    const title = t("situationMonitor.headlines.summary");

    return (
      <Popover
        trigger="click"
        placement="left"
        title={title}
        content={
          <Space direction="vertical" size={8} style={{ maxWidth: 420 }}>
            {summary ? (
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                {summary}
              </Typography.Paragraph>
            ) : null}
            {keyPoints.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {keyPoints.map((point) => (
                  <li key={point}>
                    <Typography.Text>{point}</Typography.Text>
                  </li>
                ))}
              </ul>
            ) : null}
            {topics.length > 0 ? (
              <Space size={4} wrap>
                {topics.map((topic) => (
                  <Tag
                    key={topic}
                    color="default"
                    className="cursor-pointer"
                    onClick={() =>
                      window.open(
                        `/search?q=${encodeURIComponent(topic)}`,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    {topic}
                  </Tag>
                ))}
              </Space>
            ) : null}
          </Space>
        }
      >
        <Button
          size="small"
          type="text"
          icon={<InfoCircleOutlined />}
          aria-label={title}
        />
      </Popover>
    );
  };

  const renderHeadlineItemLink = (entry: SituationMonitorHeadline) => {
    if (!entry.itemMetaId) {
      return null;
    }
    const title = t("situationMonitor.headlines.openItem");
    return (
      <Button
        size="small"
        type="text"
        icon={<FileSearchOutlined />}
        aria-label={title}
        onClick={() =>
          window.open(
            `/items/${encodeURIComponent(entry.itemMetaId!)}`,
            "_blank",
            "noopener,noreferrer",
          )
        }
      />
    );
  };

  const collectMonitorMatches = (keys: string[]) => {
    return collectMonitorMatchesForKeys(monitorMatchesByKey, keys);
  };

  const renderMonitorMatches = (keys: string[], scopeKey: string) => {
    const matches = collectMonitorMatches(keys);
    if (!matches || matches.length === 0) {
      return null;
    }

    const title = t("situationMonitor.monitors.matchTitle");

    const preview = matches.slice(0, 2);
    const remaining = Math.max(0, matches.length - preview.length);

    return (
      <Popover
        trigger="hover"
        placement="bottom"
        title={title}
        content={
          <Space direction="vertical" size={6} style={{ maxWidth: 520 }}>
            {matches.map((match) => (
              <Space
                key={`${scopeKey}:${match.itemKey}:${match.monitorId}`}
                size={6}
                wrap
              >
                <Tag color={monitorColorById.get(match.monitorId)}>
                  {match.monitorName}
                </Tag>
                {match.matchedTerms.map((term) => (
                  <Tag
                    key={`${match.itemKey}:${match.monitorId}:${term}`}
                    color="default"
                    className="cursor-pointer"
                    onClick={() =>
                      window.open(
                        `/search?q=${encodeURIComponent(term)}`,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    {term}
                  </Tag>
                ))}
                {match.reasons.map((reason) => (
                  <Tag
                    key={`${match.itemKey}:${match.monitorId}:${reason.code}`}
                    color="default"
                  >
                    {t(`situationMonitor.monitors.reason.${reason.code}`, {
                      defaultValue:
                        reason.label ||
                        getDefaultMonitorReasonLabel(reason.code),
                    })}
                  </Tag>
                ))}
              </Space>
            ))}
          </Space>
        }
      >
        <Space size={4} wrap>
          {preview.map((match) => (
            <Tag
              key={`${scopeKey}:${match.itemKey}:${match.monitorId}`}
              color={monitorColorById.get(match.monitorId)}
            >
              {match.monitorName}
            </Tag>
          ))}
          {remaining > 0 ? <Tag color="default">+{remaining}</Tag> : null}
        </Space>
      </Popover>
    );
  };

  const renderHeadlineMonitorMatches = (entry: SituationMonitorHeadline) =>
    renderMonitorMatches(
      [buildMonitorMatchKey(entry.itemMetaId, entry.link, entry.title)],
      `headline:${entry.id}`,
    );

  const renderClusterMonitorMatches = (cluster: SituationMonitorEventCluster) =>
    renderMonitorMatches(
      cluster.items.map((entry) =>
        buildMonitorMatchKey(entry.itemMetaId, entry.link, entry.title),
      ),
      `cluster:${cluster.id}`,
    );

  return {
    renderHeadlineSummary,
    renderHeadlineTopics,
    renderHeadlineDetails,
    renderHeadlineItemLink,
    renderMonitorMatches,
    renderHeadlineMonitorMatches,
    renderClusterMonitorMatches,
  };
}
