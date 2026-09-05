"use client";

import { Button, Space, Tag, Tooltip, Typography } from "antd";

import {
  AIS_SECTION_CARD_CLASS_NAME,
  ControlsChoiceButton,
  OVERLAY_PANEL_AIS_MODE_GRID_CLASS_NAME,
  OVERLAY_PANEL_MODE_HINT_CLASS_NAME,
  TransportSectionHeader,
} from "./war-map-controls-primitives";
import type { WarMapControlsPanelTransportAis } from "./war-map-controls-types";
import { LegendItemsGrid } from "./war-map-legend-sections";
import {
  OVERLAY_NEUTRAL_TAG_CLASS_NAME,
  OVERLAY_SECTION_TITLE_CLASS_NAME,
  OVERLAY_STATUS_TAG_CLASS_NAME,
  resolveOverlayButtonClassName,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import type { WarMapLegendItem } from "./war-map-symbols";

/**
 * Transport 节 AIS 卡片（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * 模式选择、降级提示、候选高亮与状态 Tag 区。
 */
export function AisControlsCard({
  ais,
  aisReferenceItems,
  onOpenLegend,
  t,
}: {
  ais: WarMapControlsPanelTransportAis;
  aisReferenceItems: WarMapLegendItem[];
  onOpenLegend: () => void;
  t: WarMapTranslateFn;
}) {
  const aisPresentation = ais.presentation;
  const aisStatusReason = aisPresentation.aisResolvedStatusReason ?? null;
  const aisHighlightCandidatesHint = t(
    "dashboard.charts.warMap.overlay.aisHighlightCandidatesHint",
  );
  const aisCandidatesOnlyHint = t(
    "dashboard.charts.warMap.overlay.aisCandidatesOnlyHint",
  );
  const aisAllVesselsHint = t(
    "dashboard.charts.warMap.overlay.aisAllVesselsHint",
  );
  const aisSectionDescription = t(
    aisPresentation.aisAllModeDegraded
      ? "dashboard.charts.warMap.overlay.aisSectionDescriptionUnavailable"
      : "dashboard.charts.warMap.overlay.aisSectionDescription",
  );
  const aisAllUnavailableInlineHint = t(
    "dashboard.charts.warMap.overlay.aisAllUnavailableInlineHint",
  );

  return (
    <div className={AIS_SECTION_CARD_CLASS_NAME}>
      <TransportSectionHeader
        eyebrow={t("dashboard.charts.warMap.overlay.maritimeEyebrow")}
        title={t("dashboard.charts.warMap.layerNames.ais")}
        description={aisSectionDescription}
      />
      {ais.visible ? (
        <>
          <div className={OVERLAY_PANEL_AIS_MODE_GRID_CLASS_NAME}>
            <ControlsChoiceButton
              active={ais.mode === "all"}
              tooltip={
                aisPresentation.aisAllModeDegraded
                  ? aisPresentation.aisAllModeDegradedLabel
                  : aisAllVesselsHint
              }
              onClick={() => ais.onModeChange("all")}
            >
              {t("dashboard.charts.warMap.stats.aisModeAll")}
            </ControlsChoiceButton>
            <ControlsChoiceButton
              active={ais.mode === "military"}
              tooltip={aisCandidatesOnlyHint}
              onClick={() => ais.onModeChange("military")}
            >
              {t("dashboard.charts.warMap.stats.aisModeMilitary")}
            </ControlsChoiceButton>
            <ControlsChoiceButton
              active={ais.mode === "density"}
              onClick={() => ais.onModeChange("density")}
            >
              {t("dashboard.charts.warMap.stats.aisModeDensity")}
            </ControlsChoiceButton>
          </div>
          {aisPresentation.aisAllModeDegraded ? (
            <div className={OVERLAY_PANEL_MODE_HINT_CLASS_NAME}>
              <Typography.Text className="block text-inherit">
                {aisPresentation.aisAllModeDegradedLabel ??
                  aisAllUnavailableInlineHint}
              </Typography.Text>
            </div>
          ) : null}
          {ais.mode === "military" ? (
            <div className={OVERLAY_PANEL_MODE_HINT_CLASS_NAME}>
              <Typography.Text className="block text-inherit">
                {t(
                  "dashboard.charts.warMap.overlay.aisCandidatesOnlyActiveHint",
                )}
              </Typography.Text>
              <Button
                type="link"
                size="small"
                className={resolveOverlayButtonClassName({
                  tone: "link",
                })}
                style={{ padding: 0, height: "auto", marginTop: 8 }}
                onClick={() => ais.onModeChange("all")}
              >
                {t("dashboard.charts.warMap.overlay.aisShowAllAction")}
              </Button>
            </div>
          ) : null}
          {ais.mode === "density" ? (
            <div className={OVERLAY_PANEL_MODE_HINT_CLASS_NAME}>
              <Typography.Text className="block text-inherit">
                {t("dashboard.charts.warMap.overlay.aisDensityOnlyActiveHint")}
              </Typography.Text>
              <Button
                type="link"
                size="small"
                className={resolveOverlayButtonClassName({
                  tone: "link",
                })}
                style={{ padding: 0, height: "auto", marginTop: 8 }}
                onClick={() => ais.onModeChange("all")}
              >
                {t("dashboard.charts.warMap.overlay.aisShowAllAction")}
              </Button>
            </div>
          ) : null}
          {ais.mode === "all" ? (
            <div className="mt-3">
              <ControlsChoiceButton
                active={ais.highlightCandidates}
                tooltip={aisHighlightCandidatesHint}
                onClick={() =>
                  ais.onHighlightCandidatesChange(!ais.highlightCandidates)
                }
              >
                {t("dashboard.charts.warMap.stats.aisHighlightCandidates")}
              </ControlsChoiceButton>
            </div>
          ) : null}
          <Space size={[8, 8]} wrap className="mt-3">
            <Tooltip
              title={
                aisPresentation.aisTooltipText ? (
                  <span className="whitespace-pre-line">
                    {aisPresentation.aisTooltipText}
                  </span>
                ) : null
              }
            >
              <Tag
                color={aisPresentation.aisSourceStatusColor}
                className={OVERLAY_STATUS_TAG_CLASS_NAME}
              >
                {t("dashboard.charts.warMap.layerNames.ais")}:{" "}
                {aisPresentation.aisSourceStatusLabel}
              </Tag>
            </Tooltip>
            {aisStatusReason ? (
              <Tooltip title={aisStatusReason}>
                <Tag color="volcano" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.stats.aisIssue")}
                </Tag>
              </Tooltip>
            ) : null}
            <Tooltip
              title={
                aisPresentation.aisTooltipText ? (
                  <span className="whitespace-pre-line">
                    {aisPresentation.aisTooltipText}
                  </span>
                ) : null
              }
            >
              <Tag color="cyan" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                {aisPresentation.aisEffectiveModeLabel}
              </Tag>
            </Tooltip>
            {ais.mode === "all" ? (
              <Tooltip title={aisHighlightCandidatesHint}>
                <Tag
                  color={ais.highlightCandidates ? "orange" : "default"}
                  className={
                    ais.highlightCandidates
                      ? OVERLAY_STATUS_TAG_CLASS_NAME
                      : OVERLAY_NEUTRAL_TAG_CLASS_NAME
                  }
                >
                  {ais.highlightCandidates
                    ? t("dashboard.charts.warMap.stats.aisHighlightOn")
                    : t("dashboard.charts.warMap.stats.aisHighlightOff")}
                </Tag>
              </Tooltip>
            ) : null}
            {typeof aisPresentation.aisRelayVesselCount === "number" ? (
              <Tooltip
                title={
                  aisPresentation.aisTooltipText ? (
                    <span className="whitespace-pre-line">
                      {aisPresentation.aisTooltipText}
                    </span>
                  ) : null
                }
              >
                <Tag color="blue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.stats.aisTrackedVessels")}:{" "}
                  {aisPresentation.aisRelayVesselCount}
                </Tag>
              </Tooltip>
            ) : null}
            {aisPresentation.aisSnapshotRelative ? (
              <Tooltip
                title={
                  aisPresentation.aisSnapshotExact
                    ? `${t(
                        "dashboard.charts.warMap.stats.aisSnapshotUpdated",
                      )}: ${aisPresentation.aisSnapshotExact}`
                    : undefined
                }
              >
                <Tag
                  color={
                    aisPresentation.aisFreshness === "stale"
                      ? "gold"
                      : "default"
                  }
                  className={
                    aisPresentation.aisFreshness === "stale"
                      ? OVERLAY_STATUS_TAG_CLASS_NAME
                      : OVERLAY_NEUTRAL_TAG_CLASS_NAME
                  }
                >
                  {t("dashboard.charts.warMap.stats.aisSnapshotUpdated")}:{" "}
                  {aisPresentation.aisSnapshotRelative}
                </Tag>
              </Tooltip>
            ) : null}
            {typeof aisPresentation.aisPrimaryCountValue === "number" ? (
              <Tooltip
                title={
                  aisPresentation.aisTooltipText ? (
                    <span className="whitespace-pre-line">
                      {aisPresentation.aisTooltipText}
                    </span>
                  ) : null
                }
              >
                <Tag color="geekblue" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {aisPresentation.aisPrimaryCountLabel}:{" "}
                  {aisPresentation.aisPrimaryCountValue}
                </Tag>
              </Tooltip>
            ) : null}
            {typeof ais.highlightedCandidateCount === "number" &&
            aisPresentation.aisHighlightCountLabel ? (
              <Tooltip
                title={
                  aisPresentation.aisTooltipText ? (
                    <span className="whitespace-pre-line">
                      {aisPresentation.aisTooltipText}
                    </span>
                  ) : null
                }
              >
                <Tag color="orange" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {aisPresentation.aisHighlightCountLabel}:{" "}
                  {ais.highlightedCandidateCount}
                </Tag>
              </Tooltip>
            ) : null}
            {typeof aisPresentation.aisDisruptionsCount === "number" ? (
              <Tooltip
                title={
                  aisPresentation.aisTooltipText ? (
                    <span className="whitespace-pre-line">
                      {aisPresentation.aisTooltipText}
                    </span>
                  ) : null
                }
              >
                <Tag color="orange" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.stats.aisDisruptions")}:{" "}
                  {aisPresentation.aisDisruptionsCount}
                </Tag>
              </Tooltip>
            ) : null}
            {ais.effectiveMode === "all" &&
            aisPresentation.aisAllModeDegraded ? (
              <Tooltip title={aisPresentation.aisAllModeDegradedLabel}>
                <Tag color="magenta" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                  {t("dashboard.charts.warMap.stats.aisAllUnavailable")}
                </Tag>
              </Tooltip>
            ) : null}
            {aisPresentation.aisViewportEmptyStateActive &&
            aisPresentation.aisViewportEmptyStateLabel ? (
              <Tag color="gold" className={OVERLAY_STATUS_TAG_CLASS_NAME}>
                {aisPresentation.aisViewportEmptyStateLabel}
              </Tag>
            ) : null}
          </Space>
          {aisPresentation.aisViewportEmptyStateActive &&
          aisPresentation.aisViewportEmptyStateHint ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {aisPresentation.aisViewportEmptyStateHint}
            </p>
          ) : null}
        </>
      ) : (
        <Typography.Text type="secondary" className="text-xs">
          {t("dashboard.charts.warMap.overlay.aisStatusHint")}
        </Typography.Text>
      )}
      <AisReferenceSection
        items={aisReferenceItems}
        onOpenLegend={onOpenLegend}
        t={t}
      />
    </div>
  );
}

function AisReferenceSection({
  items,
  onOpenLegend,
  t,
}: {
  items: WarMapLegendItem[];
  onOpenLegend: () => void;
  t: WarMapTranslateFn;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4 dark:bg-slate-950/55">
      <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
        {t("dashboard.charts.warMap.legend.aisTitle")}
      </Typography.Text>
      <Typography.Text type="secondary" className="mt-2 block text-xs">
        {t("dashboard.charts.warMap.overlay.transportLegendHint")}
      </Typography.Text>
      <LegendItemsGrid items={items} compact t={t} />
      <Button
        type="link"
        size="small"
        className={resolveOverlayButtonClassName({ tone: "link" })}
        style={{ padding: 0, height: "auto" }}
        onClick={onOpenLegend}
      >
        {t("dashboard.charts.warMap.overlay.openFullLegend")}
      </Button>
    </div>
  );
}
