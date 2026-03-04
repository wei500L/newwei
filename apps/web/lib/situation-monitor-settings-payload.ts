export const SITUATION_MONITOR_SECRET_FIELD_NAMES = [
  "translationApiKey",
  "finnhubApiKey",
  "fredApiKey",
  "telegramApiHash",
  "telegramSession",
] as const;

export type SituationMonitorSecretFieldName =
  (typeof SITUATION_MONITOR_SECRET_FIELD_NAMES)[number];

export function applySituationMonitorSecretFields(
  payload: Record<string, unknown>,
  values: Partial<Record<SituationMonitorSecretFieldName, string | undefined>>,
  touchedSecrets: Partial<Record<SituationMonitorSecretFieldName, boolean>>
) {
  for (const fieldName of SITUATION_MONITOR_SECRET_FIELD_NAMES) {
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
