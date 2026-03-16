export const REALTIME_SIGNALS_SECRET_FIELD_NAMES = [
  "openskyClientSecret",
  "relaySharedSecret",
  "aisApiKey",
  "acledOauthPassword",
  "cloudflareApiToken",
  "wingbitsApiKey",
] as const;

export type RealtimeSignalsSecretFieldName =
  (typeof REALTIME_SIGNALS_SECRET_FIELD_NAMES)[number];

export function applyRealtimeSignalsSecretFields(
  payload: Record<string, unknown>,
  values: Partial<Record<RealtimeSignalsSecretFieldName, string | undefined>>,
  touchedSecrets: Partial<Record<RealtimeSignalsSecretFieldName, boolean>>,
) {
  for (const fieldName of REALTIME_SIGNALS_SECRET_FIELD_NAMES) {
    const nextValue = values[fieldName]?.trim();
    if (nextValue) {
      payload[fieldName] = nextValue;
      continue;
    }
    if (touchedSecrets[fieldName]) {
      payload[fieldName] = null;
    }
  }
  return payload;
}
