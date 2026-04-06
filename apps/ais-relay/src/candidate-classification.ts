export const NAVAL_PREFIX_RE =
  /^(USS|USNS|HMS|HMAS|HMCS|INS|JS|ROKS|TCG|FS|BNS|RFS|PLAN|PLA|CGC|PNS|KRI|ITS|SNS|MMSI)(?:\b|[-\s])/i;

export function normalizeString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeMmsi(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  return normalizeString(value);
}

export function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

export function isLikelyMilitaryCandidate(meta: Record<string, unknown>) {
  const shipType = getNumber(meta.ShipType);
  const name = normalizeString(meta.ShipName)?.toUpperCase();

  if (
    typeof shipType === "number" &&
    (shipType === 35 || (shipType >= 50 && shipType <= 59))
  ) {
    return true;
  }

  if (name && NAVAL_PREFIX_RE.test(name)) {
    return true;
  }

  return false;
}
