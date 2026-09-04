/**
 * URL query 状态的通用 codec 原语（FE-批3 / FE-01）。
 *
 * 设计约束：
 * - 纯函数、无 React / Next 依赖，可独立测试。
 * - 不携带任何业务枚举：合法值集合由调用方传入。
 * - 读取方向（parse*）：非法值一律安全回退到默认值，不抛错。
 * - 写入方向（serialize*）：默认值不写入 URL；数组去重 + 确定性排序，
 *   保证同一状态序列化结果稳定（写回循环防护的前提）。
 */

export type UrlAllowedValues = readonly string[];

/** 单值枚举：空串/未知值回退默认值。 */
export function parseUrlStringEnum(
  raw: string | null | undefined,
  allowed: UrlAllowedValues,
  fallback: string,
): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return fallback;
  }
  return allowed.includes(value) ? value : fallback;
}

/** 多值枚举集合：过滤未知值、去重、确定性排序。 */
export function parseUrlStringSet(
  rawValues: string[] | null | undefined,
  allowed: UrlAllowedValues,
): string[] {
  if (!rawValues || rawValues.length === 0) {
    return [];
  }
  const allowedSet = new Set(allowed);
  const result = new Set<string>();
  for (const raw of rawValues) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value && allowedSet.has(value)) {
      result.add(value);
    }
  }
  return [...result].sort();
}

/** 正整数：非数字、非整数、< 1 一律回退默认值。 */
export function parseUrlPositiveInt(
  raw: string | null | undefined,
  fallback: number,
): number {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

/** 离散整数选项（如 pageSize）：不在选项内回退默认值。 */
export function parseUrlIntChoice(
  raw: string | null | undefined,
  allowed: readonly number[],
  fallback: number,
): number {
  const parsed = parseUrlPositiveInt(raw, fallback);
  return allowed.includes(parsed) ? parsed : fallback;
}

const URL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 严格 YYYY-MM-DD：拒绝格式错误与日历非法日期（如 2026-02-31）。
 * 日期字符串保持本地时区语义（与 dayjs 本地解析一致）。
 */
export function parseUrlDateParam(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!URL_DATE_PATTERN.test(trimmed)) {
    return null;
  }
  const date = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  // 回读校验：拒绝被 Date 静默进位的日期（2026-02-31 → 2026-03-03）
  if (
    date.getFullYear() !== Number(trimmed.slice(0, 4)) ||
    date.getMonth() !== Number(trimmed.slice(5, 7)) - 1 ||
    date.getDate() !== Number(trimmed.slice(8, 10))
  ) {
    return null;
  }
  return trimmed;
}

/** 日期区间：两端都合法且 from <= to（YYYY-MM-DD 字典序即时间序）。 */
export function isValidUrlDateRange(from: string | null, to: string | null): boolean {
  return Boolean(from && to && from <= to);
}

/**
 * 序列化单值参数：空串或默认值 → 从 URL 删除；其余写入（trim 后）。
 * 调用方序列化契约：必须完整拥有自己的 key（先删后写），不得触碰未拥有参数。
 */
export function serializeUrlValue(
  params: URLSearchParams,
  key: string,
  value: string,
  defaultValue: string,
): void {
  const trimmed = value.trim();
  if (trimmed && trimmed !== defaultValue) {
    params.set(key, trimmed);
  } else {
    params.delete(key);
  }
}

/** 序列化多值参数：重复 key 形式（与 items 页一致），稳定排序、去重。 */
export function serializeUrlStringSet(
  params: URLSearchParams,
  key: string,
  values: readonly string[],
): void {
  params.delete(key);
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  for (const value of unique) {
    params.append(key, value);
  }
}

/** 序列化正整数参数：默认值（含 < 1）→ 从 URL 删除。 */
export function serializeUrlPositiveInt(
  params: URLSearchParams,
  key: string,
  value: number,
  defaultValue: number,
): void {
  if (Number.isSafeInteger(value) && value >= 1 && value !== defaultValue) {
    params.set(key, String(value));
  } else {
    params.delete(key);
  }
}
