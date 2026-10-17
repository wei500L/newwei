import { ServiceUnavailableException } from "@nestjs/common";

import {
  SituationMonitorLockError,
  withMysqlSessionLock,
} from "../situation-monitor/situation-monitor-user-lock";

// The whole LLM gateway profile document is one global JSON singleton
// (SystemSetting.key = "llm_gateway_profiles"), so every read-modify-write cycle
// on it must be serialised across API instances. The lock name is deliberately
// free of orgId/userId: this is a single global row, not a per-tenant one.
//
// The name matches apps/api-go/internal/llmgatewayprofiles lock name so that
// NestJS and Go writers exclude each other during the strangler rollout.
export const LLM_GATEWAY_PROFILES_LOCK_NAME = "llm-gateway:profiles:write:v1";

/**
 * Runs `fn` while holding the global LLM gateway profiles MySQL session lock.
 *
 * Wrap only the six profile write operations (create, update, delete, and the
 * three active selections). Reads keep using the best-effort 60 second cache.
 *
 * A lock acquisition failure is mapped to 503 so the caller never continues
 * without mutual exclusion:
 * `{statusCode:503, message:"Internal server error", error:"Service Unavailable"}`.
 * The connection/DSN is never part of the response.
 */
export async function withLlmGatewayProfilesLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withMysqlSessionLock(
      process.env.DATABASE_URL ?? "",
      LLM_GATEWAY_PROFILES_LOCK_NAME,
      fn,
    );
  } catch (error) {
    if (error instanceof SituationMonitorLockError) {
      throw new ServiceUnavailableException();
    }
    throw error;
  }
}
