/**
 * FX field name constants mapping
 * Maps locale-independent keys to Chinese API field names
 * These values must match the exact field names returned by the backend API
 */
export const FX_FIELD_NAMES = {
  USD: '美元',
  EUR: '欧元',
  JPY: '日元',
} as const;

export type FxFieldKey = keyof typeof FX_FIELD_NAMES;
