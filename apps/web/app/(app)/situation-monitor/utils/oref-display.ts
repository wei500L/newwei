const OREF_HEBREW_TO_ZH_MAP: Record<string, string> = {
  "ירי רקטות וטילים": "火箭与导弹来袭",
  "חדירת כלי טיס עוין": "敌对飞行器入侵",
  "חשש לחדירת כלי טיס עוין": "疑似敌对飞行器入侵",
  "חדירת מחבלים": "武装渗透",
  "חשש לחדירת מחבלים": "疑似武装渗透",
  "רעידת אדמה": "地震",
  "צבע אדום": "红色警报",
};

function normalizeOrefText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseJerusalemLocalTimestamp(value: string): Date | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6] ?? "0");
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }

  const pad2 = (value: number) => String(value).padStart(2, "0");
  const targetDate = `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
  const targetTime = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  const target = `${targetDate} ${targetTime}`;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return null;
  }

  const formatAt = (ms: number): string => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(ms)).map((entry) => [entry.type, entry.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };

  const utc2 = Date.UTC(year, month - 1, day, hours - 2, minutes, seconds);
  const utc3 = Date.UTC(year, month - 1, day, hours - 3, minutes, seconds);
  const candidates = [utc2, utc3].filter((ms) => formatAt(ms) === target);
  const selected = candidates.length > 0 ? Math.min(...candidates) : utc2;
  return new Date(selected);
}

export function translateOrefTextForLocale(
  value: string,
  options?: { translateToZh?: boolean },
): string {
  const normalized = normalizeOrefText(value);
  if (!normalized) {
    return normalized;
  }
  if (!options?.translateToZh) {
    return normalized;
  }
  return OREF_HEBREW_TO_ZH_MAP[normalized] ?? normalized;
}

export function parseOrefTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const jerusalemParsed = parseJerusalemLocalTimestamp(trimmed);
  if (jerusalemParsed) {
    return jerusalemParsed;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed);
  }
  const normalized = trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed;
  const fallback = Date.parse(normalized);
  if (Number.isFinite(fallback)) {
    return new Date(fallback);
  }
  return null;
}

export function isRecentOrefTimestamp(
  value: string | null | undefined,
  options?: { windowMinutes?: number; nowMs?: number },
): boolean {
  const date = parseOrefTimestamp(value);
  if (!date) {
    return false;
  }
  const nowMs = options?.nowMs ?? Date.now();
  const windowMinutes = options?.windowMinutes ?? 30;
  if (windowMinutes <= 0) {
    return false;
  }
  const delta = nowMs - date.getTime();
  return delta >= 0 && delta <= windowMinutes * 60 * 1000;
}
