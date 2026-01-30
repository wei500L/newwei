export type EconomicDataValueTypeLike =
  | "fx"
  | "index"
  | "percent"
  | "price"
  | "quantity"
  | "spread"
  | "volume"
  | "yield"
  | string;

const UNIT_ALIASES: Record<string, string> = {
  "%": "%",
  "\uFF05": "%",
  percent: "%",
  percentage: "%",
  pct: "%",
  bp: "bp",
  bps: "bp",
  "basis point": "bp",
  "basis points": "bp",
};

export function normalizeUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  return UNIT_ALIASES[normalized] ?? trimmed;
}

export function deriveUnitFromValueType(
  dataType: EconomicDataValueTypeLike | null | undefined,
): string | null {
  if (!dataType) return null;
  switch (dataType) {
    case "percent":
    case "yield":
      return "%";
    case "spread":
      return "bp";
    default:
      return null;
  }
}

export interface ResolveEconomicUnitParams {
  unit?: string | null;
  defaultUnit?: string | null;
  dataType?: EconomicDataValueTypeLike | null;
}

export function resolveEconomicUnit({
  unit,
  defaultUnit,
  dataType,
}: ResolveEconomicUnitParams): string | null {
  return normalizeUnit(unit) ?? normalizeUnit(defaultUnit) ?? deriveUnitFromValueType(dataType);
}

