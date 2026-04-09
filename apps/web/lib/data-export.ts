export type CsvCellValue = string | number | null | undefined;

export interface BuildCsvOptions {
  yieldEvery?: number;
}

export interface ExportBaseNameOptions {
  base: string;
  suffixes?: (string | null | undefined)[];
  start?: string;
  end?: string;
  fallback?: string;
}

export interface ExportFilenameOptions extends ExportBaseNameOptions {
  extension: string;
}

const INVALID_FILENAME_CHARS = /[^a-zA-Z0-9-_]+/g;

export function sanitizeFilenameSegment(value: string): string {
  const normalized = value.trim().replace(INVALID_FILENAME_CHARS, "-");
  return normalized.replace(/^-+|-+$/g, "");
}

export function sanitizeFilename(value: string, fallback = "export"): string {
  const sanitized = sanitizeFilenameSegment(value);
  const safeFallback = sanitizeFilenameSegment(fallback) || "export";
  return sanitized || safeFallback;
}

export function sanitizeExportFilename(filename: string, fallbackBase = "export"): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return sanitizeFilename(fallbackBase);
  }

  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
    return sanitizeFilename(trimmed, fallbackBase);
  }

  const base = trimmed.slice(0, dotIndex);
  const ext = trimmed.slice(dotIndex + 1);
  const safeBase = sanitizeFilename(base, fallbackBase);
  const safeExt = sanitizeFilenameSegment(ext);
  return safeExt ? `${safeBase}.${safeExt}` : safeBase;
}

export function buildExportBaseName({
  base,
  suffixes,
  start,
  end,
  fallback = "export"
}: ExportBaseNameOptions): string {
  const parts: string[] = [sanitizeFilename(base, fallback)];

  for (const suffix of suffixes ?? []) {
    if (typeof suffix !== "string") {
      continue;
    }
    const sanitized = sanitizeFilenameSegment(suffix);
    if (sanitized) {
      parts.push(sanitized);
    }
  }

  const sanitizedStart = typeof start === "string" ? sanitizeFilenameSegment(start) : "";
  const sanitizedEnd = typeof end === "string" ? sanitizeFilenameSegment(end) : "";
  if (sanitizedStart) {
    parts.push(sanitizedStart);
  }
  if (sanitizedEnd) {
    parts.push(sanitizedEnd);
  }

  const name = parts.filter(Boolean).join("-");
  return name || sanitizeFilename(fallback);
}

export function buildExportFilename(options: ExportFilenameOptions): string {
  const { extension, ...baseNameOptions } = options;
  const baseName = buildExportBaseName(baseNameOptions);
  const ext = sanitizeFilenameSegment(extension.replace(/^\./, ""));
  return ext ? `${baseName}.${ext}` : baseName;
}

export function formatDateForFilename(date: Date): string {
  try {
    return date.toISOString().slice(0, 10);
  } catch {
    return "unknown-date";
  }
}

export function escapeCsvValue(value: CsvCellValue): string {
  const text = value === null || value === undefined ? "" : String(value);

  if (typeof value === "string") {
    const trimmedStart = text.replace(/^\s+/, "");
    if (/^[=+\-@]/.test(trimmedStart) && !/^-?\d+(\.\d+)?$/.test(trimmedStart)) {
      return escapeCsvValue(`'${text}`);
    }
  }

  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

export const yieldToMain = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });

export async function buildCsv(
  rows: CsvCellValue[][],
  { yieldEvery = 500 }: BuildCsvOptions = {}
): Promise<string> {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) {
      continue;
    }
    lines.push(row.map(escapeCsvValue).join(","));
    if (yieldEvery > 0 && i > 0 && i % yieldEvery === 0) {
      await yieldToMain();
    }
  }
  return lines.join("\n");
}

const ensureBrowser = () => {
  if (typeof document === "undefined") {
    throw new Error("File download is only supported in the browser");
  }
};

export function downloadBlobFile(blob: Blob, filename: string): void {
  ensureBrowser();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeExportFilename(filename);
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadTextFile(text: string, filename: string, mimeType: string): void {
  ensureBrowser();
  const blob = new Blob([text], { type: mimeType });
  downloadBlobFile(blob, filename);
}

export interface DownloadCsvOptions {
  csv: string;
  filename: string;
  includeBom?: CsvBomMode;
}

const containsNonAscii = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) > 0x7f);

export type CsvBomMode = boolean | "auto";

export function shouldIncludeCsvBom(csv: string, mode: CsvBomMode = "auto"): boolean {
  if (mode === "auto") {
    return containsNonAscii(csv);
  }
  return mode;
}

export function downloadCsv({
  csv,
  filename,
  includeBom = "auto"
}: DownloadCsvOptions): void {
  const payload = shouldIncludeCsvBom(csv, includeBom) ? `\ufeff${csv}` : csv;
  downloadTextFile(payload, filename, "text/csv;charset=utf-8");
}

export function downloadDataUrlFile(dataUrl: string, filename: string): void {
  ensureBrowser();
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = sanitizeExportFilename(filename);
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
