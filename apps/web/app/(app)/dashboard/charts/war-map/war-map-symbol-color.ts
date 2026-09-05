/**
 * War Map 符号颜色归一化（FE-批4B：自 war-map-symbols.tsx 拆出）。
 *
 * 颜色安全归一化的唯一事实源：#rgb / #rrggbb / rgb() / rgba() 归一化为
 * #rrggbb；非法或恶意输入回落 fallback，不透传进 SVG/data URL。
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseHexColor(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return [
      Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = trimmed.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+\s*)?\)$/i,
  );
  if (!rgbMatch) {
    return null;
  }

  return [
    clamp(Number.parseInt(rgbMatch[1] ?? "0", 10), 0, 255),
    clamp(Number.parseInt(rgbMatch[2] ?? "0", 10), 0, 255),
    clamp(Number.parseInt(rgbMatch[3] ?? "0", 10), 0, 255),
  ];
}

export function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((value) =>
      clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"),
    )
    .join("")}`;
}

export function mixHex(base: string, target: string, ratio: number): string {
  const baseRgb = parseHexColor(base) ?? [59, 130, 246];
  const targetRgb = parseHexColor(target) ?? [255, 255, 255];
  const progress = clamp(ratio, 0, 1);
  return rgbToHex([
    Math.round(baseRgb[0] + (targetRgb[0] - baseRgb[0]) * progress),
    Math.round(baseRgb[1] + (targetRgb[1] - baseRgb[1]) * progress),
    Math.round(baseRgb[2] + (targetRgb[2] - baseRgb[2]) * progress),
  ]);
}

export function withAlpha(color: string, alpha: number): string {
  const rgb = parseHexColor(color) ?? [59, 130, 246];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1)})`;
}

export function coerceHexColor(
  value: string | undefined,
  fallback = "#3b82f6",
): string {
  if (!value) {
    return fallback;
  }
  const parsed = parseHexColor(value);
  return parsed ? rgbToHex(parsed) : fallback;
}
