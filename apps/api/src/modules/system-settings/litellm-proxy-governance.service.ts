import { createLogger } from "@modular/utils";
import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  forwardRef,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import axios, { AxiosError } from "axios";
import { randomUUID } from "node:crypto";

import { normalizeOpenAiApiBase } from "../../common/llm-openai-compat";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey,
} from "../storage/storage-settings.crypto";

import {
  LlmGatewaySettingsService,
  type LlmGatewayProfileSummary,
} from "./llm-gateway-settings.service";
import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type LiteLlmProxyGovernanceSettingsSource = "default" | "db";

export interface LiteLlmProxyGovernanceSettingsPublic {
  source: LiteLlmProxyGovernanceSettingsSource;
  enabled: boolean;
  apiBase: string | null;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxParallelRequests: number;
  targetProfileId: string | null;
  targetProfileName: string | null;
  targetProfileEnabled: boolean;
  adminKeyConfigured: boolean;
  hasManagedRuntimeKey: boolean;
  managedTeamId: string | null;
  managedRuntimeKeyAlias: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

interface StoredLiteLlmProxyGovernanceSettings {
  enabled?: unknown;
  dailyBudgetUsd?: unknown;
  monthlyBudgetUsd?: unknown;
  maxParallelRequests?: unknown;
  targetProfileId?: unknown;
  managedTeamId?: unknown;
  managedRuntimeKey?: unknown;
  managedRuntimeKeyAlias?: unknown;
  lastSyncedAt?: unknown;
  lastSyncError?: unknown;
}

interface CachedLiteLlmProxyGovernanceSettings {
  exists: boolean;
  value?: StoredLiteLlmProxyGovernanceSettings;
}

interface ResolvedLiteLlmProxyGovernanceSettings {
  enabled: boolean;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxParallelRequests: number;
  targetProfileId: string | null;
  managedTeamId: string | null;
  managedRuntimeKey?: string;
  managedRuntimeKeyAlias: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

interface LiteLlmTeamResponse {
  team_id?: string;
}

interface LiteLlmGenerateKeyResponse {
  key?: string;
  key_alias?: string | null;
}

const SETTINGS_KEY = "litellm_proxy_governance";
const SETTINGS_DESCRIPTION =
  "LiteLLM proxy governance configuration (managed runtime key + team budgets).";
const CACHE_KEY = "litellm_proxy_governance:settings";
const CACHE_TTL_SECONDS = 30;
const DEFAULT_DAILY_BUDGET_USD = 25;
const DEFAULT_MONTHLY_BUDGET_USD = 500;
const DEFAULT_MAX_PARALLEL_REQUESTS = 16;

@Injectable()
export class LiteLlmProxyGovernanceService {
  private readonly logger = createLogger({
    name: "litellm-proxy-governance",
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService,
    @Inject(forwardRef(() => LlmGatewaySettingsService))
    private readonly gatewaySettings: LlmGatewaySettingsService,
  ) {}

  async getPublicSettings(): Promise<LiteLlmProxyGovernanceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const resolved = this.resolveEffectiveConfig(stored);
    const targetProfile = await this.resolveTargetProfile(resolved.targetProfileId);
    return this.toPublicSettings(stored ? "db" : "default", resolved, {
      targetProfile,
      hasManagedRuntimeKey: this.hasStoredManagedRuntimeKey(
        stored?.managedRuntimeKey,
      ),
    });
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      enabled?: boolean;
      dailyBudgetUsd?: number;
      monthlyBudgetUsd?: number;
      maxParallelRequests?: number;
      targetProfileId?: string | null;
    },
  ): Promise<LiteLlmProxyGovernanceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const current = this.resolveEffectiveConfig(stored);

    const next: ResolvedLiteLlmProxyGovernanceSettings = {
      ...current,
      enabled: this.asBoolean(input.enabled, current.enabled),
      dailyBudgetUsd: this.asBudget(
        input.dailyBudgetUsd,
        current.dailyBudgetUsd,
      ),
      monthlyBudgetUsd: this.asBudget(
        input.monthlyBudgetUsd,
        current.monthlyBudgetUsd,
      ),
      maxParallelRequests: this.asParallelRequests(
        input.maxParallelRequests,
        current.maxParallelRequests,
      ),
      targetProfileId:
        input.targetProfileId !== undefined
          ? this.normalizeOptionalString(input.targetProfileId) ?? null
          : current.targetProfileId,
    };

    let action = "litellm_proxy_governance_update";
    if (next.enabled) {
      const targetProfile = await this.requireTargetProfile(next.targetProfileId);
      const synced = await this.syncEnabledSettings(next, targetProfile.apiBase);
      next.managedTeamId = synced.managedTeamId;
      next.managedRuntimeKey = synced.managedRuntimeKey;
      next.managedRuntimeKeyAlias = synced.managedRuntimeKeyAlias;
      next.lastSyncedAt = new Date().toISOString();
      next.lastSyncError = null;
    } else {
      action = "litellm_proxy_governance_disable";
      await this.disableManagedResourcesBestEffort(current);
      next.managedTeamId = null;
      next.managedRuntimeKey = undefined;
      next.managedRuntimeKeyAlias = null;
      next.lastSyncedAt = current.lastSyncedAt;
      next.lastSyncError = null;
    }

    await this.persistSettings(actorId, next);
    await this.writeAuditLog(orgId, actorId, action, {
      enabled: next.enabled,
      apiBase: await this.resolveGovernedApiBase(next),
      dailyBudgetUsd: next.dailyBudgetUsd,
      monthlyBudgetUsd: next.monthlyBudgetUsd,
      maxParallelRequests: next.maxParallelRequests,
      targetProfileId: next.targetProfileId,
      hasManagedRuntimeKey: Boolean(next.managedRuntimeKey),
      managedTeamId: next.managedTeamId,
      managedRuntimeKeyAlias: next.managedRuntimeKeyAlias,
    });

    await this.invalidateCache();
    return this.toPublicSettings("db", next, {
      hasManagedRuntimeKey: Boolean(next.managedRuntimeKey),
    });
  }

  async resetToDefaults(
    orgId: string,
    actorId: string,
  ): Promise<LiteLlmProxyGovernanceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const current = this.resolveEffectiveConfig(stored);
    await this.disableManagedResourcesBestEffort(current);

    await this.prisma.systemSetting.deleteMany({
      where: { key: SETTINGS_KEY },
    });

    await this.writeAuditLog(orgId, actorId, "litellm_proxy_governance_reset", {
      ok: true,
      apiBase: await this.resolveGovernedApiBase(current),
      targetProfileId: current.targetProfileId,
    });

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async rotateManagedRuntimeKey(
    orgId: string,
    actorId: string,
  ): Promise<LiteLlmProxyGovernanceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const current = this.resolveEffectiveConfig(stored);
    if (!current.enabled) {
      throw new BadRequestException(
        "LiteLLM proxy governance must be enabled before rotating runtime key",
      );
    }
    if (!current.managedTeamId) {
      throw new BadRequestException("Managed LiteLLM team is not configured");
    }

    const targetProfile = await this.requireTargetProfile(current.targetProfileId);
    const adminClient = this.getAdminClient(targetProfile.apiBase);
    const oldKey = current.managedRuntimeKey;
    const nextAlias = this.buildRuntimeKeyAlias();
    const generated = await this.generateRuntimeKey(adminClient, {
      teamId: current.managedTeamId,
      keyAlias: nextAlias,
      dailyBudgetUsd: current.dailyBudgetUsd,
      maxParallelRequests: current.maxParallelRequests,
    });

    if (oldKey && oldKey !== generated.key) {
      await this.blockRuntimeKeyBestEffort(adminClient, oldKey);
    }

    const next: ResolvedLiteLlmProxyGovernanceSettings = {
      ...current,
      managedRuntimeKey: generated.key,
      managedRuntimeKeyAlias: generated.keyAlias,
      lastSyncedAt: new Date().toISOString(),
      lastSyncError: null,
    };

    await this.persistSettings(actorId, next);
    await this.writeAuditLog(
      orgId,
      actorId,
      "litellm_proxy_governance_rotate_key",
      {
        apiBase: await this.resolveGovernedApiBase(next),
        targetProfileId: next.targetProfileId,
        managedTeamId: next.managedTeamId,
        managedRuntimeKeyAlias: next.managedRuntimeKeyAlias,
      },
    );

    await this.invalidateCache();
    return this.toPublicSettings("db", next, {
      hasManagedRuntimeKey: Boolean(next.managedRuntimeKey),
    });
  }

  async getManagedRuntimeApiKeyForProfile(
    profileId: string,
    apiBase: string,
  ): Promise<string | null> {
    if (!(await this.isGovernedProfile(profileId, apiBase))) {
      return null;
    }
    const stored = await this.loadStoredSettings();
    if (!this.asBoolean(stored?.enabled, false)) {
      return null;
    }
    const directSecret = this.resolveSecret(stored?.managedRuntimeKey);
    if (directSecret) {
      return directSecret;
    }
    const resolved = this.resolveEffectiveConfig(stored);
    return resolved.managedRuntimeKey ?? null;
  }

  async getGovernedApiBaseForProfile(
    profileId: string,
    fallbackApiBase: string,
  ): Promise<string | null> {
    const stored = await this.loadStoredSettings();
    const resolved = this.resolveEffectiveConfig(stored);
    if (!resolved.enabled) {
      return null;
    }
    const targetProfile = await this.resolveTargetProfile(resolved.targetProfileId);
    if (!targetProfile) {
      return null;
    }
    if (!this.matchesGovernedProfile(profileId, fallbackApiBase, targetProfile)) {
      return null;
    }
    return targetProfile.apiBase;
  }

  async resolveTestingApiKey(
    apiBase: string,
    fallbackApiKey?: string,
    profileId?: string,
  ): Promise<string | undefined> {
    if (
      this.hasAdminKey() &&
      profileId &&
      (await this.isGovernedProfile(profileId, apiBase))
    ) {
      return this.normalizeSecret(this.env.liteLlmMasterKey);
    }
    return this.normalizeSecret(fallbackApiKey);
  }

  async assertProfileUpdateAllowed(
    profileId: string,
    next: {
      currentApiBase: string;
      nextApiBase: string;
      nextEnabled: boolean;
    },
  ): Promise<void> {
    const stored = await this.loadStoredSettings();
    const resolved = this.resolveEffectiveConfig(stored);
    if (!resolved.enabled || resolved.targetProfileId !== profileId) {
      return;
    }

    if (!next.nextEnabled) {
      throw new BadRequestException(
        "Disable LiteLLM managed governance or choose a different target profile before disabling this gateway profile",
      );
    }

    const currentApiBase = normalizeOpenAiApiBase(next.currentApiBase);
    const nextApiBase = normalizeOpenAiApiBase(next.nextApiBase);
    if (
      currentApiBase &&
      nextApiBase &&
      currentApiBase !== nextApiBase
    ) {
      throw new BadRequestException(
        "Disable LiteLLM managed governance or choose a different target profile before changing this gateway profile apiBase",
      );
    }
  }

  async assertProfileDeletionAllowed(profileId: string): Promise<void> {
    const stored = await this.loadStoredSettings();
    const resolved = this.resolveEffectiveConfig(stored);
    if (!resolved.enabled || resolved.targetProfileId !== profileId) {
      return;
    }

    throw new BadRequestException(
      "Disable LiteLLM managed governance or choose a different target profile before deleting this gateway profile",
    );
  }

  private async loadStoredSettings(): Promise<StoredLiteLlmProxyGovernanceSettings | null> {
    let cached: CachedLiteLlmProxyGovernanceSettings | null = null;
    try {
      cached = await this.cache.get<CachedLiteLlmProxyGovernanceSettings>(
        CACHE_KEY,
      );
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to read LiteLLM proxy governance settings cache",
      );
    }

    if (cached) {
      return cached.exists ? (cached.value ?? null) : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
    });
    const raw = record?.value as unknown;
    const settings =
      raw && typeof raw === "object"
        ? (raw as StoredLiteLlmProxyGovernanceSettings)
        : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        {
          exists: Boolean(record),
          value: settings ?? undefined,
        } satisfies CachedLiteLlmProxyGovernanceSettings,
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to write LiteLLM proxy governance settings cache",
      );
    }

    return settings;
  }

  private resolveEffectiveConfig(
    stored: StoredLiteLlmProxyGovernanceSettings | null,
  ): ResolvedLiteLlmProxyGovernanceSettings {
    return {
      enabled: this.asBoolean(stored?.enabled, false),
      dailyBudgetUsd: this.asBudget(
        stored?.dailyBudgetUsd,
        DEFAULT_DAILY_BUDGET_USD,
      ),
      monthlyBudgetUsd: this.asBudget(
        stored?.monthlyBudgetUsd,
        DEFAULT_MONTHLY_BUDGET_USD,
      ),
      maxParallelRequests: this.asParallelRequests(
        stored?.maxParallelRequests,
        DEFAULT_MAX_PARALLEL_REQUESTS,
      ),
      targetProfileId:
        this.normalizeOptionalString(stored?.targetProfileId) ?? null,
      managedTeamId: this.normalizeOptionalString(stored?.managedTeamId) ?? null,
      managedRuntimeKey: this.resolveSecret(stored?.managedRuntimeKey),
      managedRuntimeKeyAlias:
        this.normalizeOptionalString(stored?.managedRuntimeKeyAlias) ?? null,
      lastSyncedAt: this.normalizeIsoString(stored?.lastSyncedAt),
      lastSyncError: this.normalizeOptionalString(stored?.lastSyncError) ?? null,
    };
  }

  private async syncEnabledSettings(
    settings: ResolvedLiteLlmProxyGovernanceSettings,
    apiBase: string,
  ): Promise<{
    managedTeamId: string;
    managedRuntimeKey: string;
    managedRuntimeKeyAlias: string;
  }> {
    const adminClient = this.getAdminClient(apiBase);
    const teamId =
      settings.managedTeamId ?? `modular-runtime-${randomUUID().slice(0, 8)}`;
    const keyAlias =
      settings.managedRuntimeKeyAlias ?? this.buildRuntimeKeyAlias();
    await this.upsertTeam(adminClient, {
      teamId,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
    });

    if (settings.managedRuntimeKey) {
      try {
        await this.updateRuntimeKey(adminClient, {
          key: settings.managedRuntimeKey,
          keyAlias,
          teamId,
          dailyBudgetUsd: settings.dailyBudgetUsd,
          maxParallelRequests: settings.maxParallelRequests,
          blocked: false,
        });
        return {
          managedTeamId: teamId,
          managedRuntimeKey: settings.managedRuntimeKey,
          managedRuntimeKeyAlias: keyAlias,
        };
      } catch (error) {
        if (!this.shouldRecreateManagedKey(error)) {
          throw error;
        }
      }
    }

    const generated = await this.generateRuntimeKey(adminClient, {
      teamId,
      keyAlias,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      maxParallelRequests: settings.maxParallelRequests,
    });
    return {
      managedTeamId: teamId,
      managedRuntimeKey: generated.key,
      managedRuntimeKeyAlias: generated.keyAlias,
    };
  }

  private async persistSettings(
    actorId: string,
    settings: ResolvedLiteLlmProxyGovernanceSettings,
  ): Promise<void> {
    const managedRuntimeKeyRaw = settings.managedRuntimeKey
      ? await this.securitySettings.encodeSecretForStorage(
          settings.managedRuntimeKey,
        )
      : null;
    const nextStored: StoredLiteLlmProxyGovernanceSettings = {
      enabled: settings.enabled,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
      maxParallelRequests: settings.maxParallelRequests,
      targetProfileId: settings.targetProfileId,
      managedTeamId: settings.managedTeamId,
      managedRuntimeKey: managedRuntimeKeyRaw,
      managedRuntimeKeyAlias: settings.managedRuntimeKeyAlias,
      lastSyncedAt: settings.lastSyncedAt,
      lastSyncError: settings.lastSyncError,
    };

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: this.toPrismaJson(nextStored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
      create: {
        key: SETTINGS_KEY,
        value: this.toPrismaJson(nextStored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
    });
  }

  private async writeAuditLog(
    orgId: string,
    actorId: string,
    action: string,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action,
          metadata: this.toPrismaJson(metadata),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action,
      },
    );
  }

  private getAdminClient(apiBase: string) {
    const masterKey = this.normalizeSecret(this.env.liteLlmMasterKey);
    if (!masterKey) {
      throw new ServiceUnavailableException(
        "LITELLM_MASTER_KEY is required for LiteLLM proxy governance",
      );
    }

    return axios.create({
      baseURL: apiBase,
      timeout: 60_000,
      headers: {
        Authorization: `Bearer ${masterKey}`,
        "Content-Type": "application/json",
      },
    });
  }

  private async upsertTeam(
    client: ReturnType<typeof axios.create>,
    params: { teamId: string; monthlyBudgetUsd: number },
  ): Promise<void> {
    const payload = {
      team_id: params.teamId,
      team_alias: "Modular Runtime Governance",
      max_budget: params.monthlyBudgetUsd,
      budget_duration: "30d",
      blocked: false,
      metadata: {
        managed_by: "modular",
        scope: "runtime_governance",
      },
    };

    try {
      await client.post("/team/update", payload);
    } catch (error) {
      if (this.shouldCreateManagedResource(error)) {
        await client.post<LiteLlmTeamResponse>("/team/new", payload);
        return;
      }
      throw this.toSyncError(error, "Failed to update LiteLLM managed team");
    }
  }

  private async updateRuntimeKey(
    client: ReturnType<typeof axios.create>,
    params: {
      key: string;
      keyAlias: string;
      teamId: string;
      dailyBudgetUsd: number;
      maxParallelRequests: number;
      blocked: boolean;
    },
  ): Promise<void> {
    try {
      await client.post("/key/update", {
        key: params.key,
        key_alias: params.keyAlias,
        team_id: params.teamId,
        max_budget: params.dailyBudgetUsd,
        budget_duration: "1d",
        max_parallel_requests: params.maxParallelRequests,
        blocked: params.blocked,
        metadata: {
          managed_by: "modular",
          scope: "runtime_governance",
        },
      });
    } catch (error) {
      throw this.toSyncError(error, "Failed to update LiteLLM managed runtime key");
    }
  }

  private async generateRuntimeKey(
    client: ReturnType<typeof axios.create>,
    params: {
      teamId: string;
      keyAlias: string;
      dailyBudgetUsd: number;
      maxParallelRequests: number;
    },
  ): Promise<{ key: string; keyAlias: string }> {
    try {
      const response = await client.post<LiteLlmGenerateKeyResponse>(
        "/key/generate",
        {
          key_alias: params.keyAlias,
          team_id: params.teamId,
          max_budget: params.dailyBudgetUsd,
          budget_duration: "1d",
          max_parallel_requests: params.maxParallelRequests,
          metadata: {
            managed_by: "modular",
            scope: "runtime_governance",
          },
        },
      );

      const key = this.normalizeSecret(response.data?.key);
      if (!key) {
        throw new ServiceUnavailableException(
          "LiteLLM did not return a managed runtime key",
        );
      }
      return {
        key,
        keyAlias:
          this.normalizeOptionalString(response.data?.key_alias) ??
          params.keyAlias,
      };
    } catch (error) {
      throw this.toSyncError(error, "Failed to generate LiteLLM managed runtime key");
    }
  }

  private async disableManagedResourcesBestEffort(
    settings: ResolvedLiteLlmProxyGovernanceSettings,
  ): Promise<void> {
    if (!settings.managedTeamId && !settings.managedRuntimeKey) {
      return;
    }
    if (!this.hasAdminKey()) {
      return;
    }

    const apiBase = await this.resolveGovernedApiBase(settings);
    if (!apiBase) {
      return;
    }

    const client = this.getAdminClient(apiBase);
    if (settings.managedRuntimeKey) {
      await this.blockRuntimeKeyBestEffort(client, settings.managedRuntimeKey);
    }
    if (settings.managedTeamId) {
      await this.blockTeamBestEffort(client, settings.managedTeamId);
    }
  }

  private async blockRuntimeKeyBestEffort(
    client: ReturnType<typeof axios.create>,
    key: string,
  ): Promise<void> {
    try {
      await client.post("/key/update", {
        key,
        blocked: true,
        max_budget: 0,
        budget_duration: "1d",
      });
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to block LiteLLM managed runtime key during disable flow",
      );
    }
  }

  private async blockTeamBestEffort(
    client: ReturnType<typeof axios.create>,
    teamId: string,
  ): Promise<void> {
    try {
      await client.post("/team/update", {
        team_id: teamId,
        blocked: true,
        max_budget: 0,
        budget_duration: "30d",
      });
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to block LiteLLM managed team during disable flow",
      );
    }
  }

  private toSyncError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof AxiosError) {
      const detail =
        typeof error.response?.data === "string"
          ? error.response.data
          : typeof (error.response?.data as { detail?: unknown })?.detail ===
              "string"
            ? ((error.response?.data as { detail?: string }).detail ?? "")
            : typeof (error.response?.data as { message?: unknown })?.message ===
                  "string"
              ? ((error.response?.data as { message?: string }).message ?? "")
              : error.message;
      const message = detail?.trim() || fallbackMessage;
      if (typeof error.response?.status === "number") {
        return new ServiceUnavailableException(
          `${fallbackMessage}: HTTP ${error.response.status} ${message}`,
        );
      }
      return new ServiceUnavailableException(`${fallbackMessage}: ${message}`);
    }
    if (error instanceof Error) {
      return error;
    }
    return new ServiceUnavailableException(fallbackMessage);
  }

  private hasAdminKey(): boolean {
    return Boolean(this.normalizeSecret(this.env.liteLlmMasterKey));
  }

  private shouldCreateManagedResource(error: unknown): boolean {
    if (!(error instanceof AxiosError)) {
      return false;
    }
    if (error.response?.status === 404) {
      return true;
    }
    const detail = JSON.stringify(error.response?.data ?? {});
    return error.response?.status === 400 && /not\s+found/i.test(detail);
  }

  private shouldRecreateManagedKey(error: unknown): boolean {
    if (!(error instanceof AxiosError)) {
      return false;
    }
    if (error.response?.status === 404) {
      return true;
    }
    const detail = JSON.stringify(error.response?.data ?? {});
    return /not\s+found|invalid key/i.test(detail);
  }

  private buildRuntimeKeyAlias(): string {
    return `modular-runtime-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)}`;
  }

  private resolveSecret(raw: unknown): string | undefined {
    if (!raw) {
      return undefined;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      return trimmed ? trimmed : undefined;
    }
    if (isEncryptedStringValueV1(raw)) {
      const key = resolveSettingsKey(this.env);
      if (!key) {
        this.logger.warn(
          "Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for LiteLLM proxy governance secret",
        );
        return undefined;
      }
      try {
        const decrypted = decryptStringValueV1(raw, key);
        const trimmed = decrypted.trim();
        return trimmed ? trimmed : undefined;
      } catch (error) {
        this.logger.warn(
          { err: error },
          "Failed to decrypt LiteLLM proxy governance secret",
        );
      }
    }
    return undefined;
  }

  private normalizeSecret(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.replace(/^bearer\s+/i, "").trim() || undefined;
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private async requireTargetProfile(
    targetProfileId: string | null,
  ): Promise<LlmGatewayProfileSummary> {
    const targetProfile = await this.resolveTargetProfile(targetProfileId);
    if (!targetProfile) {
      throw new BadRequestException(
        "Select an enabled LiteLLM gateway profile before enabling managed governance",
      );
    }
    return targetProfile;
  }

  private async resolveTargetProfile(
    targetProfileId: string | null,
  ): Promise<LlmGatewayProfileSummary | null> {
    if (!targetProfileId) {
      return null;
    }
    const profile = await this.gatewaySettings.getProfileSummary(targetProfileId);
    if (!profile || !profile.enabled) {
      return null;
    }
    return profile;
  }

  private async resolveGovernedApiBase(
    settings: ResolvedLiteLlmProxyGovernanceSettings,
  ): Promise<string | null> {
    const targetProfile = await this.resolveTargetProfile(settings.targetProfileId);
    return targetProfile?.apiBase ?? null;
  }

  private matchesGovernedProfile(
    profileId: string,
    apiBase: string,
    targetProfile: LlmGatewayProfileSummary,
  ): boolean {
    const normalizedCandidate = normalizeOpenAiApiBase(apiBase);
    const normalizedTarget = normalizeOpenAiApiBase(targetProfile.apiBase);
    if (!normalizedCandidate || !normalizedTarget) {
      return false;
    }
    return (
      profileId === targetProfile.id || normalizedCandidate === normalizedTarget
    );
  }

  private async isGovernedProfile(
    profileId: string,
    apiBase: string,
  ): Promise<boolean> {
    const stored = await this.loadStoredSettings();
    const resolved = this.resolveEffectiveConfig(stored);
    if (!resolved.enabled) {
      return false;
    }
    const targetProfile = await this.resolveTargetProfile(resolved.targetProfileId);
    if (!targetProfile) {
      return false;
    }
    return this.matchesGovernedProfile(profileId, apiBase, targetProfile);
  }

  private async toPublicSettings(
    source: LiteLlmProxyGovernanceSettingsSource,
    resolved: ResolvedLiteLlmProxyGovernanceSettings,
    options?: {
      hasManagedRuntimeKey?: boolean;
      targetProfile?: LlmGatewayProfileSummary | null;
    },
  ): Promise<LiteLlmProxyGovernanceSettingsPublic> {
    const targetProfile =
      options?.targetProfile ??
      (await this.resolveTargetProfile(resolved.targetProfileId));
    return {
      source,
      enabled: resolved.enabled,
      apiBase: targetProfile?.apiBase ?? null,
      dailyBudgetUsd: resolved.dailyBudgetUsd,
      monthlyBudgetUsd: resolved.monthlyBudgetUsd,
      maxParallelRequests: resolved.maxParallelRequests,
      targetProfileId: resolved.targetProfileId,
      targetProfileName: targetProfile?.name ?? null,
      targetProfileEnabled: targetProfile?.enabled ?? false,
      adminKeyConfigured: this.hasAdminKey(),
      hasManagedRuntimeKey:
        options?.hasManagedRuntimeKey ?? Boolean(resolved.managedRuntimeKey),
      managedTeamId: resolved.managedTeamId,
      managedRuntimeKeyAlias: resolved.managedRuntimeKeyAlias,
      lastSyncedAt: resolved.lastSyncedAt,
      lastSyncError:
        resolved.enabled && resolved.targetProfileId && !targetProfile
          ? "Managed governance target profile is missing or disabled"
          : resolved.lastSyncError,
    };
  }

  private hasStoredManagedRuntimeKey(value: unknown): boolean {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return isEncryptedStringValueV1(value);
  }

  private normalizeIsoString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  }

  private asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private asBudget(value: unknown, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(0, Math.min(1_000_000, Number(parsed.toFixed(4))));
  }

  private asParallelRequests(value: unknown, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(1, Math.min(1_024, Math.trunc(parsed)));
  }

  private async invalidateCache(): Promise<void> {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to invalidate LiteLLM proxy governance settings cache",
      );
    }
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
