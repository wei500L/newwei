import { describe, expect, it } from "vitest";

import {
  buildCsv,
  buildExportBaseName,
  buildExportFilename,
  escapeCsvValue,
  filenameFromContentDisposition,
  formatDateForFilename,
  sanitizeExportFilename,
  sanitizeFilename,
  sanitizeFilenameSegment,
  shouldIncludeCsvBom
} from "../lib/data-export";

describe("data-export", () => {
  it("sanitizes filename segments", () => {
    expect(sanitizeFilenameSegment("  Hello world  ")).toBe("Hello-world");
    expect(sanitizeFilenameSegment(" --- ")).toBe("");
  });

  it("sanitizes filenames with fallback", () => {
    expect(sanitizeFilename("  ", "chart")).toBe("chart");
    expect(sanitizeFilename("a/b", "chart")).toBe("a-b");
  });

  it("sanitizes export filenames while keeping extension", () => {
    expect(sanitizeExportFilename(" Report 2024.csv ")).toBe("Report-2024.csv");
    expect(sanitizeExportFilename("bad.name..csv")).toBe("bad-name.csv");
  });

  it("extracts safe filenames from content disposition headers", () => {
    expect(
      filenameFromContentDisposition(
        'attachment; filename="wei user data.json"',
      ),
    ).toBe("wei-user-data.json");
    expect(
      filenameFromContentDisposition(
        "attachment; filename*=UTF-8''wei%20%E4%B8%AD%E6%96%87.json",
      ),
    ).toBe("wei.json");
    expect(filenameFromContentDisposition(undefined)).toBeNull();
  });

  it("builds export base names and filenames", () => {
    const baseName = buildExportBaseName({
      base: "sector-heatmap",
      suffixes: ["Energy & Utilities"],
      start: "2026-01-01",
      end: "2026-01-31"
    });
    expect(baseName).toBe("sector-heatmap-Energy-Utilities-2026-01-01-2026-01-31");
    expect(
      buildExportFilename({
        base: "sector-heatmap",
        suffixes: ["Energy & Utilities"],
        start: "2026-01-01",
        end: "2026-01-31",
        extension: ".csv"
      })
    ).toBe("sector-heatmap-Energy-Utilities-2026-01-01-2026-01-31.csv");
  });

  it("escapes CSV values", () => {
    expect(escapeCsvValue("a,b")).toBe("\"a,b\"");
    expect(escapeCsvValue("\"quote\"")).toBe("\"\"\"quote\"\"\"");
    expect(escapeCsvValue("=1+1")).toBe("'=1+1");
    expect(escapeCsvValue("-123")).toBe("-123");
    expect(escapeCsvValue("-1+2")).toBe("'-1+2");
  });

  it("builds CSV content", async () => {
    const csv = await buildCsv([
      ["a", "b"],
      ["x,y", 2]
    ]);
    expect(csv).toBe("a,b\n\"x,y\",2");
  });

  it("formats dates for filenames", () => {
    expect(formatDateForFilename(new Date("2026-02-01T00:00:00Z"))).toBe("2026-02-01");
  });

  it("infers when CSV should include BOM", () => {
    expect(shouldIncludeCsvBom("a,b\nc,d")).toBe(false);
    expect(shouldIncludeCsvBom("\u4e2d\u6587,a")).toBe(true);
    expect(shouldIncludeCsvBom("\u4e2d\u6587,a", false)).toBe(false);
    expect(shouldIncludeCsvBom("a,b", true)).toBe(true);
  });
});
