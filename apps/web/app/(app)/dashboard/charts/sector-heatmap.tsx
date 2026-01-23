"use client";

import { useQuery } from "@tanstack/react-query";
import { App, Button, Skeleton, Tag } from "antd";
import axios from "axios";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import dayjs from "@/lib/dayjs";
import { formatUpdatedAt, resolveLocale } from "@/lib/i18n";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";
import { useDashboardFiltersStore } from "@/store/dashboard-filters";
import { useDashboardRangeStore } from "@/store/time-range";

interface SectorHeatmapCell {
  x: number;
  y: number;
  name: string;
  value: number;
  change: number;
  unit?: string | null;
  sourceField?: string;
}

interface SectorHeatmapResponse {
  xLabels: string[];
  yLabels: string[];
  cells: SectorHeatmapCell[];
  updatedAt?: string;
}

type HeatmapValue = [number, number, number, string, number];

type SectorHeatmapFieldMismatchPayload = {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  items?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const extractSectorHeatmapFieldMismatch = (error: unknown) => {
  if (!axios.isAxiosError(error)) {
    return null;
  }
  const payload = error.response?.data as SectorHeatmapFieldMismatchPayload | undefined;
  if (!payload || !isRecord(payload)) {
    return null;
  }
  if (payload.code !== "DASHBOARD_SECTOR_HEATMAP_FIELD_MAPPING_MISMATCH") {
    return null;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const details = items
    .slice(0, 8)
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
      const slug = typeof item.slug === "string" ? item.slug.trim() : "";
      const name = displayName || slug || "Unknown item";
      const available = Array.isArray(item.availableSourceFields)
        ? item.availableSourceFields.filter(
            (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
          )
        : [];
      return {
        name,
        available: available.slice(0, 10)
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return {
    message: typeof payload.message === "string" ? payload.message : "Sector heatmap error",
    detail: typeof payload.detail === "string" ? payload.detail : undefined,
    items: details
  };
};

const escapeCsvValue = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
};

const yieldToMain = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });

const buildCsv = async (rows: (string | number | null | undefined)[][]) => {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) {
      continue;
    }
    lines.push(row.map(escapeCsvValue).join(","));
    if (i > 0 && i % 500 === 0) {
      await yieldToMain();
    }
  }
  return lines.join("\n");
};

const downloadCsvFile = (csv: string, filename: string) => {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const sanitizeFilename = (value: string) => {
  const normalized = value.trim().replace(/[^a-zA-Z0-9-_]+/g, "-");
  const trimmed = normalized.replace(/^-+|-+$/g, "");
  return trimmed || "export";
};

const formatDateForFilename = (date: Date) => {
  return dayjs.utc(date).format("YYYY-MM-DD");
};

export function SectorHeatmap() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const { data: session, status: sessionStatus } = useSession();
  const { range, start, end } = useDashboardRangeStore();
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const { selectedSector, setSelectedSector } = useDashboardFiltersStore();
  const [exportingCsv, setExportingCsv] = useState(false);
  const emptyTitle = t("dashboard.dataEmpty", { defaultValue: "No data" });
  const emptyHint = t("dashboard.dataEmptyHint", {
    defaultValue: "No data for the selected range. Try expanding the range."
  });
  const valueLabel = t("dashboard.charts.sectorHeatmapValueLabel", { defaultValue: "Value" });
  const changeLabel = t("dashboard.charts.sectorHeatmapChangeLabel", { defaultValue: "Change" });
  const windowLabel = `${formatDateForFilename(start)} - ${formatDateForFilename(end)}`;

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const {
    data,
    isLoading,
    isError,
    error,
    refetch
  } = useQuery({
    queryKey: [
      "dashboard",
      "sector-heatmap",
      start.toISOString(),
      end.toISOString()
    ],
    queryFn: async () => {
      const response = await apiClient.get<SectorHeatmapResponse>(
        "dashboard/sector-heatmap",
        {
          params: {
            start: start.toISOString(),
            end: end.toISOString()
          }
        }
      );
      return response.data;
    },
    staleTime: 60_000,
    enabled: Boolean(session?.accessToken)
  });

  const updatedAtLabel = useMemo(() => {
    const iso = data?.updatedAt;
    if (!iso) return null;
    const formatted = formatUpdatedAt(iso, locale);
    return formatted ? formatted : null;
  }, [data?.updatedAt, locale]);

  const heatmapStats = useMemo(() => {
    if (!data) {
      return {
        totalCells: 0,
        filteredCells: 0,
        selectedCells: null as number | null,
        uniqueSectors: 0,
        xLabels: 0,
        yLabels: 0
      };
    }

    const unique = new Set<string>();
    let selectedCount = 0;
    for (const cell of data.cells) {
      unique.add(cell.name);
      if (selectedSector && cell.name === selectedSector) {
        selectedCount += 1;
      }
    }

    return {
      totalCells: data.cells.length,
      filteredCells: selectedSector ? selectedCount : data.cells.length,
      selectedCells: selectedSector ? selectedCount : null,
      uniqueSectors: unique.size,
      xLabels: data.xLabels.length,
      yLabels: data.yLabels.length
    };
  }, [data, selectedSector]);

  const option = useMemo<EChartsOption>(() => {
    if (!data || data.cells.length === 0) return {};
    const heatmapData = data.cells.map((cell) => {
      const isSelected = selectedSector === cell.name;
      return {
        value: [cell.x, cell.y, cell.change, cell.name, cell.value] as HeatmapValue,
        unit: cell.unit ?? null,
        sourceField: cell.sourceField ?? null,
        itemStyle: {
          borderColor: isSelected ? (colors?.primary ?? "#1f3b7b") : (colors?.border ?? "#e2e8f0"),
          borderWidth: isSelected ? 4 : 2,
          borderRadius: 8
        }
      };
    });
    
    const maxChange = Math.max(
      1,
      ...data.cells.map((cell) => Math.abs(cell.change))
    );

    return {
      tooltip: {
        position: "top",
        backgroundColor: colors?.tooltipBg ?? "#0f172a",
        borderColor: colors?.primary ?? "#1f3b7b",
        textStyle: { color: colors?.tooltipText ?? "#f8fafc", fontFamily },
        formatter: (params: any) => {
          const value = params.value;
          if (!Array.isArray(value)) return "";
          const unit =
            params?.data && typeof params.data.unit === "string" ? params.data.unit : null;
          const sourceField =
            params?.data && typeof params.data.sourceField === "string"
              ? params.data.sourceField
              : null;
          const [, , change, name, valuePoint] = value as HeatmapValue;
          const valueText = unit ? `${valuePoint} ${unit}` : String(valuePoint);
          const sourceText = sourceField ? `<br/>Source: ${sourceField}` : "";
          return `<b>${name}</b><br/>${changeLabel}: ${change}%<br/>${valueLabel}: ${valueText}${sourceText}<br/>Window: ${windowLabel}`;
        }
      },
      grid: {
        height: "90%",
        top: "5%",
        bottom: "5%",
        left: "2%",
        right: "2%"
      },
      xAxis: {
        type: "category",
        data: data.xLabels,
        show: false
      },
      yAxis: {
        type: "category",
        data: data.yLabels,
        show: false
      },
      visualMap: {
        min: -maxChange,
        max: maxChange,
        calculable: false, // Cleaner look
        show: false, // Hide the bar, rely on color
        inRange: {
          color: [
            colors?.bearish ?? "#d95f02",
            "#cbd5e1",
            colors?.bullish ?? "#1b9e77"
          ]
        }
      },
      series: [
        {
          name: "Market Sectors",
          type: "heatmap",
          data: heatmapData,
          label: {
            show: true,
            fontFamily,
            fontSize: 10,
            color: colors?.tooltipText ?? "#f8fafc",
            formatter: (params: any) => {
              const value = params.value;
              if (!Array.isArray(value)) return "";
              const [, , change, name] = value as HeatmapValue;
              return `${name}\n${change}%`;
            }
          },
          itemStyle: {
            borderColor: colors?.border ?? "#e2e8f0",
            borderWidth: 2
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowColor: '#fff',
              borderColor: '#fff'
            }
          }
        }
      ]
    };
  }, [changeLabel, colors, data, fontFamily, selectedSector, valueLabel, windowLabel]);

  const handleCsvExport = useCallback(async () => {
    if (!data || data.cells.length === 0) return;
    setExportingCsv(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const filteredCells = selectedSector
        ? data.cells.filter((cell) => cell.name === selectedSector)
        : data.cells;
      const rows = [
        ["Sector", "Group", "Row", valueLabel, "Unit", "Source field", changeLabel],
        ...filteredCells.map((cell) => {
          const xLabel = data.xLabels[cell.x] ?? String(cell.x);
          const yLabel = data.yLabels[cell.y] ?? String(cell.y);
          return [
            cell.name,
            xLabel,
            yLabel,
            cell.value,
            cell.unit ?? "",
            cell.sourceField ?? "",
            cell.change
          ];
        })
      ];
      const csv = await buildCsv(rows);
      const startLabel = formatDateForFilename(start);
      const endLabel = formatDateForFilename(end);
      const suffix = selectedSector ? `-${sanitizeFilename(selectedSector)}` : "";
      const filename = `sector-heatmap${suffix}-${startLabel}-${endLabel}.csv`;
      downloadCsvFile(csv, filename);
      toast.success(
        t("dashboard.charts.downloadSuccess", { defaultValue: "Download completed" })
      );
    } catch {
      toast.error(
        t("dashboard.charts.downloadFailed", { defaultValue: "Download failed" })
      );
    } finally {
      setExportingCsv(false);
    }
  }, [changeLabel, data, end, selectedSector, start, t, valueLabel]);

  const csvLabel = exportingCsv
    ? t("dashboard.charts.exporting", { defaultValue: "Exporting..." })
    : t("dashboard.charts.downloadCsv", { defaultValue: "Download CSV" });

  if (sessionStatus === "loading") {
    return (
      <div className="h-[300px] flex items-center transition-all duration-300">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="h-[300px] flex items-center transition-all duration-300">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (isError && !data) {
    const fieldMismatch = extractSectorHeatmapFieldMismatch(error);
    if (fieldMismatch) {
      const list = fieldMismatch.items
        .map((entry) => `${entry.name}: ${entry.available.join(", ") || "no source fields"}`)
        .join("\n");
      return (
        <div className="h-[300px] transition-all duration-300">
          <ChartEmptyState
            variant="error"
            title={t("dashboard.charts.sectorHeatmap.configErrorTitle", {
              defaultValue: "Sector heatmap configuration error"
            })}
            description={
              <div className="flex flex-col items-center gap-1">
                <span>
                  {t("dashboard.charts.sectorHeatmap.configErrorDescription", {
                    defaultValue:
                      "Some economic indicators have no matching source field for the heatmap."
                  })}
                </span>
                <span className="font-mono text-[10px] opacity-80">
                  code: DASHBOARD_SECTOR_HEATMAP_FIELD_MAPPING_MISMATCH
                </span>
                {fieldMismatch.detail ? (
                  <span className="font-mono text-[10px] opacity-80">{fieldMismatch.detail}</span>
                ) : null}
                {list ? (
                  <pre className="max-w-[520px] whitespace-pre-wrap text-left font-mono text-[10px] opacity-80">
                    {list}
                  </pre>
                ) : null}
              </div>
            }
            actionLabel={t("common.retry", { defaultValue: "Retry" })}
            onAction={() => void refetch()}
          />
        </div>
      );
    }

    const emptyState = buildRequestErrorEmptyState({ t, error, onRetry: () => refetch() });
    return (
      <div className="h-[300px] transition-all duration-300">
        <ChartEmptyState {...emptyState} />
      </div>
    );
  }

  if (!data || data.cells.length === 0) {
    return (
      <div className="h-[300px] transition-all duration-300">
        <ChartEmptyState title={emptyTitle} description={emptyHint} />
      </div>
    );
  }

  return (
    <div className="relative h-[300px] transition-all duration-300">
      <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-2">
        <Tag color="default" className="text-xs">
          Range: {range}
        </Tag>
        <Tag color="default" className="text-xs">
          Window: {windowLabel}
        </Tag>
        <Tag color="default" className="text-xs">
          {t("dashboard.charts.dataStats.points", { defaultValue: "Points" })}:{" "}
          {heatmapStats.filteredCells.toLocaleString(locale)} / {heatmapStats.totalCells.toLocaleString(locale)}
        </Tag>
        <Tag color="default" className="text-xs">
          {t("dashboard.charts.sectorHeatmapStats.sectors", { defaultValue: "Sectors" })}:{" "}
          {heatmapStats.uniqueSectors.toLocaleString(locale)}
        </Tag>
        <Tag color="default" className="text-xs">
          {t("dashboard.charts.sectorHeatmapStats.grid", { defaultValue: "Grid" })}: {heatmapStats.xLabels}x{heatmapStats.yLabels}
        </Tag>
        {selectedSector ? (
          <Tag
            className="text-xs"
            color={heatmapStats.selectedCells === 0 ? "red" : "geekblue"}
            closable
            onClose={() => setSelectedSector(null)}
          >
            {t("dashboard.charts.sectorSelected", {
              sector: selectedSector,
              defaultValue: `Selected: ${selectedSector}`
            })}
            {typeof heatmapStats.selectedCells === "number"
              ? ` (${heatmapStats.selectedCells.toLocaleString(locale)})`
              : ""}
          </Tag>
        ) : null}
        <Tag color="geekblue" className="text-xs">
          Aggregation: window snapshot
        </Tag>
        {updatedAtLabel ? (
          <Tag color="default" className="text-xs">
            {t("dashboard.updatedAt", {
              time: updatedAtLabel,
              defaultValue: "Updated: {{time}}"
            })}
          </Tag>
        ) : null}
      </div>
      <DashboardChart
        option={option}
        theme={echartsTheme}
        height="100%"
        exportFilename={`sector-heatmap-${formatDateForFilename(start)}-${formatDateForFilename(
          end
        )}`}
        showExportImage
        actions={
          <Button
            size="small"
            type="default"
            onClick={handleCsvExport}
            loading={exportingCsv}
            disabled={!data || data.cells.length === 0}
          >
            {csvLabel}
          </Button>
        }
        onEvents={[
          {
            type: "click",
            handler: (params: any) => {
              const value = params.value as HeatmapValue | undefined;
              if (Array.isArray(value)) {
                const sectorName = value[3];
                const newSelection = selectedSector === sectorName ? null : sectorName;
                setSelectedSector(newSelection);
                if (newSelection) {
                  message.info(t("dashboard.charts.sectorSelected", { sector: newSelection, defaultValue: `Selected: ${newSelection}` }));
                }
              }
            }
          }
        ]}
      />
      {isLoading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : null}
    </div>
  );
}
