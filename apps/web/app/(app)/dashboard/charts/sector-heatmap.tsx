"use client";

import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton, message } from "antd";
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
  const { t } = useTranslation();
  const { data: session } = useSession();
  const { start, end } = useDashboardRangeStore();
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const { selectedSector, setSelectedSector } = useDashboardFiltersStore();
  const [exportingCsv, setExportingCsv] = useState(false);
  const emptyMessage = t("dashboard.dataEmpty", { defaultValue: "No data" });
  const valueLabel = t("dashboard.charts.sectorHeatmapValueLabel", { defaultValue: "Value" });
  const changeLabel = t("dashboard.charts.sectorHeatmapChangeLabel", { defaultValue: "Change" });

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
          return `<b>${name}</b><br/>${changeLabel}: ${change}%<br/>${valueLabel}: ${valueText}${sourceText}`;
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
  }, [changeLabel, colors, data, fontFamily, selectedSector, valueLabel]);

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

  if (isLoading && !data) {
    return (
      <div className="h-[300px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="h-[300px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error instanceof Error ? error.message : emptyMessage}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      </div>
    );
  }

  if (!data || data.cells.length === 0) {
    return (
      <div className="h-[300px]">
        <ChartEmptyState description={emptyMessage} />
      </div>
    );
  }

  return (
    <div className="relative h-[300px]">
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
