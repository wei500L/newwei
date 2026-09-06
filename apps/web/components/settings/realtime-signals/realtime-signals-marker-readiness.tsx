"use client";

import { Alert, Card, Col, Descriptions, Row, Statistic } from "antd";
import { useTranslation } from "react-i18next";

import type { RealtimeSignalsRuntimeDiagnosticsResponse } from "./realtime-signals-types";

export interface RealtimeSignalsMarkerReadinessProps {
  markerReadiness: RealtimeSignalsRuntimeDiagnosticsResponse["markerReadiness"];
  formatTimestamp: (value?: string) => string;
}

export function RealtimeSignalsMarkerReadiness({
  markerReadiness,
  formatTimestamp,
}: RealtimeSignalsMarkerReadinessProps) {
  const { t } = useTranslation();

  return (
    <>
      {!markerReadiness.newsMarkersReady ? (
        <Alert
          type="warning"
          showIcon
          message={t(
            "systemSettings.realtimeSignals.runtime.markerWarning.title",
          )}
          description={t(
            "systemSettings.realtimeSignals.runtime.markerWarning.body",
          )}
        />
      ) : null}

      <Descriptions
        size="small"
        column={1}
        bordered
        title={t("systemSettings.realtimeSignals.runtime.markerReadiness")}
      >
        <Descriptions.Item
          label={t(
            "systemSettings.realtimeSignals.runtime.markerWindow",
          )}
        >
          {markerReadiness.windowHours}h
        </Descriptions.Item>
        <Descriptions.Item
          label={t(
            "systemSettings.realtimeSignals.runtime.markerRecentArticles",
          )}
        >
          {markerReadiness.recentProcessedArticles}
        </Descriptions.Item>
        <Descriptions.Item
          label={t(
            "systemSettings.realtimeSignals.runtime.markerRecentArticlesWithLocation",
          )}
        >
          {markerReadiness.recentProcessedArticlesWithLocation}
        </Descriptions.Item>
        <Descriptions.Item
          label={t(
            "systemSettings.realtimeSignals.runtime.markerRecentMongo",
          )}
        >
          {markerReadiness.recentMongoProcessedItems}
        </Descriptions.Item>
        <Descriptions.Item
          label={t(
            "systemSettings.realtimeSignals.runtime.markerRecentMongoWithLocation",
          )}
        >
          {markerReadiness.recentMongoProcessedItemsWithLocation}
        </Descriptions.Item>
        <Descriptions.Item
          label={t(
            "systemSettings.realtimeSignals.runtime.markerLatestArticle",
          )}
        >
          {formatTimestamp(markerReadiness.latestProcessedArticleAt)}
        </Descriptions.Item>
        <Descriptions.Item
          label={t(
            "systemSettings.realtimeSignals.runtime.markerLatestMongo",
          )}
        >
          {formatTimestamp(markerReadiness.latestProcessedItemAt)}
        </Descriptions.Item>
      </Descriptions>
    </>
  );
}

export interface RealtimeSignalsInsightsProps {
  insight: RealtimeSignalsRuntimeDiagnosticsResponse["insight"];
}

export function RealtimeSignalsInsights({ insight }: RealtimeSignalsInsightsProps) {
  const { t } = useTranslation();

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} sm={8}>
        <Card size="small">
          <Statistic
            title={t(
              "systemSettings.realtimeSignals.runtime.insight.keywordSpikes",
            )}
            value={insight.keywordSpikes.length}
          />
        </Card>
      </Col>
      <Col xs={24} sm={8}>
        <Card size="small">
          <Statistic
            title={t(
              "systemSettings.realtimeSignals.runtime.insight.predictionLeads",
            )}
            value={insight.predictionLeads.length}
          />
        </Card>
      </Col>
      <Col xs={24} sm={8}>
        <Card size="small">
          <Statistic
            title={t(
              "systemSettings.realtimeSignals.runtime.insight.tensions",
            )}
            value={insight.tensions.length}
          />
        </Card>
      </Col>
    </Row>
  );
}
