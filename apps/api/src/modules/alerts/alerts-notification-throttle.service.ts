import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CLIENT } from "../cache/cache.tokens";
import { EnvService } from "../config/config.service";

const PACE_LUA_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval_ms = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])

if interval_ms <= 0 then
  return 0
end

local next_time = redis.call('GET', key)
if next_time then
  next_time = tonumber(next_time)
else
  next_time = now
end

local scheduled = now
if next_time > scheduled then
  scheduled = next_time
end

local new_next = scheduled + interval_ms
redis.call('SET', key, tostring(new_next), 'PX', ttl_ms)

return scheduled - now
`;

const LUA_KEYS = 1;

export type MuteUntilInput = string | number | null | undefined;

@Injectable()
export class AlertsNotificationThrottleService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly env: EnvService
  ) {}

  parseMuteUntilMs(value: MuteUntilInput): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  isMutedNow(muteUntilMs: number | null, nowMs = Date.now()): boolean {
    return muteUntilMs !== null && nowMs < muteUntilMs;
  }

  async reserveNotificationScheduleMs(input: { channelType: "email" | "webhook"; channelId?: string | null }): Promise<number> {
    const now = Date.now();
    const schedules: number[] = [];
    const keyPrefix = `${this.env.bullmqConfig.namespace}:alerts:notify`;

    const globalPerSecond = this.env.alertingConfig.notifyGlobalPerSecond;
    if (globalPerSecond > 0) {
      schedules.push(await this.reserveScheduledAtMs(`${keyPrefix}:global`, now, globalPerSecond));
    }

    const perType =
      input.channelType === "email" ? this.env.alertingConfig.notifyEmailPerSecond : this.env.alertingConfig.notifyWebhookPerSecond;
    if (perType > 0) {
      schedules.push(await this.reserveScheduledAtMs(`${keyPrefix}:type:${input.channelType}`, now, perType));
    }

    if (input.channelId) {
      const perChannel = this.env.alertingConfig.notifyPerChannelPerSecond;
      if (perChannel > 0) {
        schedules.push(await this.reserveScheduledAtMs(`${keyPrefix}:channel:${input.channelId}`, now, perChannel));
      }
    }

    return Math.max(now, ...schedules);
  }

  private async reserveScheduledAtMs(key: string, nowMs: number, maxPerSecond: number): Promise<number> {
    if (!maxPerSecond || maxPerSecond <= 0) {
      return nowMs;
    }
    const intervalMs = Math.ceil(1000 / Math.max(1, maxPerSecond));
    const ttlMs = Math.max(this.env.alertingConfig.notifyLimiterTtlMs, intervalMs * 10);
    const delay = (await this.redis.eval(PACE_LUA_SCRIPT, LUA_KEYS, key, nowMs, intervalMs, ttlMs)) as number;
    const safeDelayMs = Number.isFinite(delay) ? Math.max(0, delay) : 0;
    return nowMs + safeDelayMs;
  }
}
