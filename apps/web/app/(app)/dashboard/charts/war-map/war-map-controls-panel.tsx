"use client";

import { CloseOutlined } from "@ant-design/icons";
import { Button, Tooltip, Typography } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ControlsHeaderSummary } from "./war-map-controls-header";
import {
  ControlsChoiceButton,
  OVERLAY_PANEL_TAB_GRID_CLASS_NAME,
  renderControlsTabLabel,
} from "./war-map-controls-primitives";
import type { WarMapControlsPanelProps } from "./war-map-controls-types";
import { FeedsSection } from "./war-map-feed-controls";
import { LegendSectionsList, LegendInteractionStrip } from "./war-map-legend-sections";
import { TransportSection } from "./war-map-transport-controls";
import { ViewSection } from "./war-map-view-section";
import {
  OVERLAY_SECTION_TITLE_CLASS_NAME,
  resolveOverlayButtonClassName,
  type OverlayControlsSection,
} from "./war-map-overlay-model";

/**
 * Controls 面板根编排层（FE-批4B：原 1746 行拆分后收敛为编排）。
 * 头部（标题/摘要/页签）+ 各领域 section（view/transport/feeds/legend）
 * 的分节渲染与头部尺寸测量（ResizeObserver/RAF）。
 */
function resolveActiveControlsSection(
  controlsSection: OverlayControlsSection,
): Exclude<OverlayControlsSection, "overview"> {
  return controlsSection === "overview" ? "view" : controlsSection;
}

export function WarMapControlsPanel({
  layoutVariant,
  controlsSection,
  controlsSectionMeta,
  controlsTabs,
  useDrawerControls,
  overlayPanelMaxHeight,
  overviewMetricCards,
  summaryStatusCards,
  summaryDataLabel,
  overviewDataTagLabel,
  windowLabel,
  feedSummaryCards,
  detailedChainStatuses,
  legendSections,
  interactionLegendItems,
  view,
  transport,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  onControlsSectionChange,
  onClose,
  t,
}: WarMapControlsPanelProps) {
  const standaloneLayout = layoutVariant === "standalone";
  const activeControlsSection = resolveActiveControlsSection(controlsSection);
  const activeControlsSectionMeta = controlsSectionMeta[activeControlsSection];
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const showCloseButton =
    (useDrawerControls || standaloneLayout) && typeof onClose === "function";

  useEffect(() => {
    const headerNode = headerRef.current;
    if (!headerNode) {
      return;
    }

    let frameId: number | null = null;
    const updateHeight = () => {
      const nextHeight = Math.ceil(headerNode.getBoundingClientRect().height);
      setHeaderHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    };
    const measure = () => {
      if (
        typeof window !== "undefined" &&
        typeof window.requestAnimationFrame === "function"
      ) {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
        frameId = window.requestAnimationFrame(updateHeight);
        return;
      }

      updateHeight();
    };

    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        measure();
      });
      observer.observe(headerNode);

      return () => {
        if (
          frameId !== null &&
          typeof window !== "undefined" &&
          typeof window.cancelAnimationFrame === "function"
        ) {
          window.cancelAnimationFrame(frameId);
        }
        observer.disconnect();
      };
    }

    window.addEventListener("resize", measure);

    return () => {
      if (
        frameId !== null &&
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("resize", measure);
    };
  }, [
    activeControlsSection,
    controlsTabs,
    overviewDataTagLabel,
    overviewMetricCards,
    summaryDataLabel,
    summaryStatusCards,
    windowLabel,
  ]);

  let controlsSectionContent: ReactNode;
  switch (activeControlsSection) {
    case "view":
      controlsSectionContent = (
        <ViewSection view={view} t={t} layoutVariant={layoutVariant} />
      );
      break;
    case "transport":
      controlsSectionContent = (
        <TransportSection
          transport={transport}
          legendSections={legendSections}
          layoutVariant={layoutVariant}
          t={t}
        />
      );
      break;
    case "feeds":
      controlsSectionContent = (
        <FeedsSection
          feedSummaryCards={feedSummaryCards}
          detailedChainStatuses={detailedChainStatuses}
          layoutVariant={layoutVariant}
        />
      );
      break;
    case "legend":
      controlsSectionContent = (
        <LegendSection
          legendSections={legendSections}
          interactionLegendItems={interactionLegendItems}
          activeLegendKey={activeLegendKey}
          highlightedLegendKey={highlightedLegendKey}
          onLegendItemHover={onLegendItemHover}
          onLegendItemFocus={onLegendItemFocus}
          t={t}
        />
      );
      break;
    default:
      controlsSectionContent = (
        <ViewSection view={view} t={t} layoutVariant={layoutVariant} />
      );
      break;
  }
  const controlsBodyMaxHeight =
    !useDrawerControls && !standaloneLayout && headerHeight > 0
      ? Math.max(112, overlayPanelMaxHeight - headerHeight)
      : undefined;

  return (
    <div className="flex h-full min-h-0 max-h-full flex-col">
      <div
        ref={headerRef}
        className={`border-b border-[var(--border)] bg-gradient-to-b from-white to-slate-50/90 dark:from-slate-950/90 dark:to-slate-900/90 ${
          standaloneLayout ? "px-6 py-5" : "px-4 py-3"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Typography.Text
              strong
              className="block text-base text-slate-900 dark:text-slate-100"
            >
              {activeControlsSectionMeta.label}
            </Typography.Text>
            {activeControlsSection === "view" ? (
              <Typography.Text
                type="secondary"
                className="mt-1 block text-[13px] leading-5"
              >
                {activeControlsSectionMeta.description}
              </Typography.Text>
            ) : null}
          </div>
          {showCloseButton ? (
            <Button
              type="default"
              aria-label={t("common.close")}
              className={resolveOverlayButtonClassName({
                tone: "neutral",
                iconOnly: true,
                extraClassName: "!h-10 !min-w-10 !rounded-full",
              })}
              icon={<CloseOutlined />}
              onClick={onClose}
            />
          ) : null}
        </div>
        {activeControlsSection === "view" ? (
          <ControlsHeaderSummary
            overviewMetricCards={overviewMetricCards}
            summaryStatusCards={summaryStatusCards}
            summaryDataLabel={summaryDataLabel}
            overviewDataTagLabel={overviewDataTagLabel}
            windowLabel={windowLabel}
            t={t}
          />
        ) : null}
        <div
          className={`rounded-[20px] border border-[var(--border)] bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:bg-slate-950/55 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${standaloneLayout ? "p-2.5" : "p-2"} ${OVERLAY_PANEL_TAB_GRID_CLASS_NAME}`}
        >
          {controlsTabs.map((tab) => {
            const isActive = activeControlsSection === tab.key;
            const button = (
              <ControlsChoiceButton
                active={isActive}
                align="center"
                onClick={() => onControlsSectionChange(tab.key)}
              >
                {renderControlsTabLabel(tab, isActive)}
              </ControlsChoiceButton>
            );

            if (tab.attentionTooltip) {
              return (
                <Tooltip key={tab.key} title={tab.attentionTooltip}>
                  {button}
                </Tooltip>
              );
            }

            return <span key={tab.key}>{button}</span>;
          })}
        </div>
      </div>
      <div
        className={`min-h-0 overflow-y-auto overscroll-contain ${
          standaloneLayout ? "px-6 py-5" : "px-4 py-4"
        }`}
        style={
          controlsBodyMaxHeight
            ? { maxHeight: controlsBodyMaxHeight }
            : undefined
        }
      >
        {controlsSectionContent}
      </div>
    </div>
  );
}

function LegendSection({
  legendSections,
  interactionLegendItems,
  activeLegendKey,
  highlightedLegendKey,
  onLegendItemHover,
  onLegendItemFocus,
  t,
}: Pick<
  WarMapControlsPanelProps,
  "legendSections" | "interactionLegendItems" | "t"
> & {
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-3">
      <Typography.Text strong className={OVERLAY_SECTION_TITLE_CLASS_NAME}>
        {t("dashboard.charts.warMap.legend.title")}
      </Typography.Text>
      <LegendInteractionStrip items={interactionLegendItems} t={t} />
      <LegendSectionsList
        legendSections={legendSections}
        activeLegendKey={activeLegendKey}
        highlightedLegendKey={highlightedLegendKey}
        onLegendItemHover={onLegendItemHover}
        onLegendItemFocus={onLegendItemFocus}
        t={t}
      />
      <div className="rounded-2xl border border-dashed border-[var(--border)] bg-white/62 px-3 py-2.5 dark:bg-slate-950/48">
        <Typography.Text type="secondary" className="text-xs">
          {t("dashboard.charts.warMap.legend.radius")}
        </Typography.Text>
      </div>
    </div>
  );
}
