import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { writeAuditLogBestEffort } from '../audit/audit-log.writer';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../config/prisma.service';

export interface ArchivePreparationSettings {
  jobBatchSize: number;
  embeddingBatchSize: number;
  embeddingMaxConcurrency: number;
  rerankMaxConcurrency: number;
}

export interface ArchivePreparationSettingsPublic
  extends ArchivePreparationSettings {
  source: 'default' | 'db';
}

interface StoredArchivePreparationSettings {
  jobBatchSize?: unknown;
  embeddingBatchSize?: unknown;
  embeddingMaxConcurrency?: unknown;
  rerankMaxConcurrency?: unknown;
}

const SETTINGS_KEY = 'archive_preparation_settings';
const SETTINGS_DESCRIPTION =
  'Archive background preparation settings (batch sizes and embedding/rerank concurrency).';
const CACHE_KEY = 'archive_preparation:settings';
const CACHE_TTL_SECONDS = 30;
const DEFAULT_SETTINGS: ArchivePreparationSettings = {
  jobBatchSize: 20,
  embeddingBatchSize: 20,
  embeddingMaxConcurrency: 1,
  rerankMaxConcurrency: 1,
};

@Injectable()
export class ArchivePreparationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getPublicSettings(): Promise<ArchivePreparationSettingsPublic> {
    const record = await this.loadStoredSettings();
    const settings = this.normalize(record ?? {});
    return {
      source: record ? 'db' : 'default',
      ...settings,
    };
  }

  async getEffectiveSettings(): Promise<ArchivePreparationSettings> {
    const record = await this.loadStoredSettings();
    return this.normalize(record ?? {});
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: ArchivePreparationSettings,
  ): Promise<ArchivePreparationSettingsPublic> {
    const settings = this.normalize(input);
    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: toPrismaJsonValue(settings),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
      create: {
        key: SETTINGS_KEY,
        value: toPrismaJsonValue(settings),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: 'system_settings',
          action: 'archive_preparation_update',
          metadata: toPrismaJsonValue(settings),
        },
      },
      {
        orgId,
        actorId,
        resource: 'system_settings',
        action: 'archive_preparation_update',
      },
    );

    await this.cache.del(CACHE_KEY);
    return this.getPublicSettings();
  }

  async resetToDefaults(
    orgId: string,
    actorId: string,
  ): Promise<ArchivePreparationSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: 'system_settings',
          action: 'archive_preparation_reset',
          metadata: toPrismaJsonValue({ ok: true } satisfies Prisma.InputJsonObject),
        },
      },
      {
        orgId,
        actorId,
        resource: 'system_settings',
        action: 'archive_preparation_reset',
      },
    );

    await this.cache.del(CACHE_KEY);
    return this.getPublicSettings();
  }

  private async loadStoredSettings(): Promise<StoredArchivePreparationSettings | null> {
    return this.cache.wrap<StoredArchivePreparationSettings | null>(
      CACHE_KEY,
      CACHE_TTL_SECONDS,
      async () => {
        const record = await this.prisma.systemSetting.findUnique({
          where: { key: SETTINGS_KEY },
          select: { value: true },
        });
        return (record?.value as StoredArchivePreparationSettings | null) ?? null;
      },
    );
  }

  private normalize(
    raw: StoredArchivePreparationSettings | ArchivePreparationSettings,
  ): ArchivePreparationSettings {
    return {
      jobBatchSize: this.clampInt(raw.jobBatchSize, 1, 100, DEFAULT_SETTINGS.jobBatchSize),
      embeddingBatchSize: this.clampInt(
        raw.embeddingBatchSize,
        1,
        100,
        DEFAULT_SETTINGS.embeddingBatchSize,
      ),
      embeddingMaxConcurrency: this.clampInt(
        raw.embeddingMaxConcurrency,
        1,
        8,
        DEFAULT_SETTINGS.embeddingMaxConcurrency,
      ),
      rerankMaxConcurrency: this.clampInt(
        raw.rerankMaxConcurrency,
        1,
        8,
        DEFAULT_SETTINGS.rerankMaxConcurrency,
      ),
    };
  }

  private clampInt(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(parsed)));
  }
}
