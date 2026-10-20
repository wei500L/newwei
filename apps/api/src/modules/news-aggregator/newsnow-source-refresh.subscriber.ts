import { createLogger } from '@modular/utils';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../cache/cache.tokens';
import { EnvService } from '../config/config.service';

import { NewsnowActiveSourceRegistryService } from './newsnow-active-source-registry.service';
import { NewsnowRealtimeDispatcher } from './newsnow-realtime.dispatcher';

/**
 * Source-refresh relay consumed from the Go fetch unit.
 *
 * Go publishes one `newsnow:source-refresh:v1` message after a refresh that
 * added items. The message carries no orgId: target organizations come from the
 * authenticated sockets registered in this process. Delivery then reuses the
 * existing dispatcher → gateway → `newsnow:update` path, so WebSocket auth,
 * room isolation and event fields stay untouched.
 */
const SOURCE_REFRESH_CHANNEL = 'newsnow:source-refresh:v1';
const FANOUT_KEY_PREFIX = 'newsnow:source-refresh:fanout';
const FANOUT_TTL_SECONDS = 60;
const MAX_TOP_TITLES = 3;

interface SourceRefreshMessage {
  version: 1;
  refreshId: string;
  sourceId: string;
  newItemsCount: number;
  topTitles: string[];
  updatedTime: string;
  intervalMs: number;
}

@Injectable()
export class NewsnowSourceRefreshSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger({ name: 'newsnow-source-refresh-subscriber' });
  private subscriber?: Redis;

  constructor(
    private readonly env: EnvService,
    private readonly activeSources: NewsnowActiveSourceRegistryService,
    private readonly dispatcher: NewsnowRealtimeDispatcher,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    if (this.env.newsnowSourcesMode !== 'go') {
      return;
    }

    // A dedicated connection is required: a subscribed ioredis client cannot
    // issue the fanout SET NX command. The shared client stays untouched.
    const subscriber = this.redis.duplicate();
    subscriber.on('message', (channel, payload) => {
      if (channel === SOURCE_REFRESH_CHANNEL) {
        void this.handleMessage(payload);
      }
    });
    subscriber.on('error', (error) => {
      this.logger.error({ error }, 'NewsNow source refresh subscriber error');
    });

    try {
      await subscriber.subscribe(SOURCE_REFRESH_CHANNEL);
    } catch (error) {
      try {
        await subscriber.quit();
      } catch {
        // best-effort cleanup before failing startup
      }
      // Do not silently claim the seam is ready: without a subscription the
      // Go fetch path cannot deliver new-item notifications.
      throw new Error(
        `NewsNow source refresh subscription failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.subscriber = subscriber;
    this.logger.info(
      { channel: SOURCE_REFRESH_CHANNEL, adapter: this.env.webSocketRedisAdapter.enabled },
      'NewsNow source refresh relay subscribed',
    );
  }

  async onModuleDestroy() {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (!subscriber) {
      return;
    }
    try {
      await subscriber.unsubscribe(SOURCE_REFRESH_CHANNEL);
    } catch {
      // best-effort
    }
    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  }

  private async handleMessage(raw: string) {
    const message = this.parseMessage(raw);
    if (!message) {
      return;
    }

    const orgIds = this.activeSources.getOrgIdsForSource(message.sourceId);
    if (orgIds.length === 0) {
      return;
    }

    const adapterEnabled = this.env.webSocketRedisAdapter.enabled;
    for (const orgId of orgIds) {
      if (adapterEnabled) {
        // With the Socket.IO Redis adapter every instance receives the relay
        // message. The NX marker elects exactly one instance per
        // (refresh, organization); that instance's emit is fanned out to all
        // instances by the adapter.
        const key = `${FANOUT_KEY_PREFIX}:${message.refreshId}:${orgId}`;
        let acquired: string | null = null;
        try {
          acquired = await this.redis.set(key, '1', 'EX', FANOUT_TTL_SECONDS, 'NX');
        } catch (error) {
          this.logger.warn({ key, error }, 'NewsNow source refresh fanout claim failed');
          continue;
        }
        if (acquired !== 'OK') {
          continue;
        }
      }

      try {
        await this.dispatcher.publish({
          orgId,
          sourceId: message.sourceId,
          newItemsCount: message.newItemsCount,
          topTitles: message.topTitles,
          updatedTime: message.updatedTime,
          intervalMs: Math.max(1_000, message.intervalMs),
        });
      } catch (error) {
        this.logger.error(
          { orgId, sourceId: message.sourceId, error },
          'NewsNow source refresh dispatch failed',
        );
      }
    }
  }

  private parseMessage(raw: string): SourceRefreshMessage | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.warn({ error }, 'Ignoring malformed NewsNow source refresh payload');
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.logger.warn('Ignoring non-object NewsNow source refresh payload');
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) {
      this.logger.warn(
        { version: record.version },
        'Ignoring unsupported NewsNow source refresh version',
      );
      return null;
    }
    if (typeof record.refreshId !== 'string' || record.refreshId.trim().length === 0) {
      return null;
    }
    if (typeof record.sourceId !== 'string' || record.sourceId.trim().length === 0) {
      return null;
    }
    if (
      typeof record.newItemsCount !== 'number' ||
      !Number.isFinite(record.newItemsCount) ||
      record.newItemsCount <= 0
    ) {
      return null;
    }
    if (typeof record.updatedTime !== 'string' || record.updatedTime.trim().length === 0) {
      return null;
    }
    if (typeof record.intervalMs !== 'number' || !Number.isFinite(record.intervalMs)) {
      return null;
    }
    if (!Array.isArray(record.topTitles)) {
      return null;
    }
    const topTitles = record.topTitles
      .filter((value): value is string => typeof value === 'string')
      .slice(0, MAX_TOP_TITLES);

    return {
      version: 1,
      refreshId: record.refreshId,
      sourceId: record.sourceId,
      newItemsCount: record.newItemsCount,
      topTitles,
      updatedTime: record.updatedTime,
      intervalMs: record.intervalMs,
    };
  }
}
