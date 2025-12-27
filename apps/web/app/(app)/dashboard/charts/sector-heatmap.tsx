"use client";

import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Spin, message } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { DashboardChart } from "@/components/echart";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { createApiClient } from "@/lib/api-client";
import dayjs from "@/lib/dayjs";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { useDashboardFiltersStore } from "@/store/dashboard-filters";
import { useDashboardRangeStore } from "@/store/time-range";

interface SectorHeatmapCell {
  x: number;
  y: number;
  name: string;
  value: number;
  change: number;
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

const buildCsv = async (rows: Array<Array<string | number | null | undefined>>) => {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    lines.push(rows[i].map(escapeCsvValue).join(","));
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
  const { echartsTheme, colors } = useChartTheme();
  const { selectedSector, setSelectedSector } = useDashboardFiltersStore();
  const [exportingCsv, setExportingCsv] = useState(false);
  const emptyMessage = t("dashboard.charts.noDataRange", {
    defaultValue: "No Data Found for Selected Range"
  });

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
        itemStyle: {
          borderColor: isSelected ? (colors?.primary ?? "#1677ff") : (colors?.background ?? "#fff"),
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
        formatter: (params: any) => {
          const value = params.value;
          if (!Array.isArray(value)) return "";
          const [, , change, name, volume] = value as HeatmapValue;
          return `<b>${name}</b><br/>Change: ${change}%<br/>Volume: ${volume}`;
        }
      },
      grid: {
        height: "80%",
        top: "10%"
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
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        inRange: {
          color: [
            colors?.bearish ?? "#ef4444",
            "#f3f4f6",
            colors?.bullish ?? "#22c55e"
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
            formatter: (params: any) => {
              const value = params.value;
              if (!Array.isArray(value)) return "";
              const [, , change, name] = value as HeatmapValue;
              return `${name}\n${change}%`;
            }
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowColor: 'rgba(0, 0, 0, 0.5)'
            }
          }
        }
      ]
    };
  }, [colors, data, selectedSector]);

  const handleCsvExport = useCallback(async () => {
    if (!data || data.cells.length === 0) return;
    setExportingCsv(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const filteredCells = selectedSector
        ? data.cells.filter((cell) => cell.name === selectedSector)
        : data.cells;
      const rows = [
        ["Sector", "Group", "Row", "Value", "Change"],
        ...filteredCells.map((cell) => {
          const xLabel = data.xLabels[cell.x] ?? String(cell.x);
          const yLabel = data.yLabels[cell.y] ?? String(cell.y);
          return [cell.name, xLabel, yLabel, cell.value, cell.change];
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
    } catch (error) {
      toast.error(
        t("dashboard.charts.downloadFailed", { defaultValue: "Download failed" })
      );
    } finally {
      setExportingCsv(false);
    }
  }, [data, end, selectedSector, start, t]);

  const csvLabel = exportingCsv
    ? t("dashboard.charts.exporting", { defaultValue: "Exporting..." })
    : t("dashboard.charts.downloadCsv", { defaultValue: "Download CSV" });

  if (isLoading && !data) {
    return (
      <div className="flex h-[300px] items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="flex h-[300px] items-center justify-center">
        <Alert
          type="error"
          showIcon
          message={t("dashboard.widgets.loadFailed", {
            defaultValue: "Failed to load data"
          })}
          description={error instanceof Error ? error.message : undefined}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t("common.retry")}
            </Button>
          }
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
          <Spin />
        </div>
      ) : null}
    </div>
  );
}
