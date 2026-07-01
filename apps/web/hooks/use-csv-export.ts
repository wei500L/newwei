"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  buildCsv,
  type CsvBomMode,
  type CsvCellValue,
  downloadBlobFile,
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
  exportCsvBlob: (args: CsvBlobExportArgs) => Promise<void>;
}

export interface CsvBlobExportArgs {
  filename: string;
  fetchBlob: () => Promise<Blob>;
  successMessage?: string;
  errorMessage?: string;
}

export function useCsvExport(): UseCsvExportResult {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);

  const label = useMemo(() => {
    return exporting
      ? t("dashboard.charts.exporting")
      : t("dashboard.charts.downloadCsv");
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
          t("dashboard.charts.exportSuccess")
        );
      } catch {
        toast.error(t("dashboard.charts.exportFailed"));
      } finally {
        setExporting(false);
      }
    },
    [exporting, t]
  );

  const exportCsvBlob = useCallback(
    async ({ filename, fetchBlob, successMessage, errorMessage }: CsvBlobExportArgs) => {
      if (exporting) return;
      setExporting(true);
      try {
        await yieldToMain();
        const blob = await fetchBlob();
        downloadBlobFile(blob, filename);
        toast.success(
          successMessage ??
            t("dashboard.charts.exportSuccess")
        );
      } catch {
        toast.error(
          errorMessage ??
            t("dashboard.charts.exportFailed")
        );
      } finally {
        setExporting(false);
      }
    },
    [exporting, t]
  );

  return {
    exporting,
    label,
    exportCsv,
    exportCsvBlob
  };
}
