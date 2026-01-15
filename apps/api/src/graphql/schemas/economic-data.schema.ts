import { z } from "zod";

/**
 * Schema for validating metadata fields in economic data.
 * Accepts a record of string keys to unknown values, or null.
 */
export const metadataSchema = z.record(z.string(), z.unknown()).nullable();

export type Metadata = z.infer<typeof metadataSchema>;

/**
 * Safely parse and validate metadata value.
 * Returns validated data or null for invalid/missing data.
 *
 * @param value - The value to parse as metadata
 * @returns Validated metadata record or null
 */
export function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }

  // Check if value is a plain object (not array, not primitive)
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const result = metadataSchema.safeParse(value);
  return result.success ? result.data : null;
}
