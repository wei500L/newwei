const DATE_TAG = "$gqlDate";

/**
 * JSON.stringify drops `undefined`, turns `NaN`/`Infinity` into `null`, and
 * calls `Date#toJSON` before the replacer runs. Read the raw property so a
 * Date survives the Redis hop as a tagged value and comes back as a Date.
 * Non-finite numbers stay `null`, which matches the alert serializer: it
 * already maps non-finite metric numbers to `null` or `0`.
 */
export function encodeGraphqlSubscriptionPayload(payload: unknown): string {
  return JSON.stringify(payload, function replacer(
    this: object,
    key: string,
    value: unknown,
  ): unknown {
    if (key.length === 0) {
      return value;
    }
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Date) {
      return { [DATE_TAG]: raw.toISOString() };
    }
    return value;
  });
}

export function decodeGraphqlSubscriptionPayload(message: string): unknown {
  return JSON.parse(message, (_key, value: unknown) => reviveGraphqlValue(value));
}

function reviveGraphqlValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== DATE_TAG || typeof record[DATE_TAG] !== "string") {
    return value;
  }
  const parsed = new Date(record[DATE_TAG]);
  return Number.isNaN(parsed.getTime()) ? value : parsed;
}
