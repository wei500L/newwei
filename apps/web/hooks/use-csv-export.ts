"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  buildCsv,
  type CsvBomMode,
  type CsvCellValue,
  downloadCsv,
  yieldToMain
} from "@/lib/data-export";

export interface CsvExportArgs {
  rows: CsvCellValue[][];
  filename: string;
  includeBom?: CsvBomMode;
}

export interface UseCsvExportResult {
  exporting: boolean;
  label: string;
  exportCsv: (args: CsvExportArgs) => Promise<void>;
}

export function useCsvExport(): UseCsvExportResult {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);

  const label = useMemo(() => {
    return exporting
      ? t("dashboard.charts.exporting", { defaultValue: "Exporting..." })
      : t("dashboard.charts.downloadCsv", { defaultValue: "Download CSV" });
  }, [exporting, t]);

  const exportCsv = useCallback(
    async ({ rows, filename, includeBom }: CsvExportArgs) => {
      if (exporting) return;
      setExporting(true);
      try {
        await yieldToMain();
        const csv = await buildCsv(rows);
        downloadCsv({ csv, filename, includeBom });
        toast.success(
          t("dashboard.charts.exportSuccess", { defaultValue: "Export completed" })
        );
      } catch {
        toast.error(t("dashboard.charts.exportFailed", { defaultValue: "Export failed" }));
      } finally {
        setExporting(false);
      }
    },
    [exporting, t]
  );

  return {
    exporting,
    label,
    exportCsv
  };
}

