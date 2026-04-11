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
export type LiteLlmManagedRuntimeKeyState =
  | "missing"
  | "available"
  | "unreadable";

export interface LiteLlmProxyGovernanceTrafficBindings {
  completion: boolean;
  embedding: boolean;
  rerank: boolean;
}

export interface LiteLlmProxyGovernanceEndpointCheck {
  ok: boolean;
  status?: number;
  message?: string;
}

export interface LiteLlmProxyGovernanceHealthResult {
  apiBase: string;
  checkedAt: string;
  liveliness: LiteLlmProxyGovernanceEndpointCheck;
  readiness: LiteLlmProxyGovernanceEndpointCheck;
}

export interface LiteLlmProxyGovernancePreflightCheck {
  key:
    | "admin_key"
    | "target_profile"
    | "runtime_traffic"
    | "proxy_health"
    | "managed_runtime_key";
  ok: boolean;
  required: boolean;
  message: string;
}

export interface LiteLlmProxyGovernancePreflightPublic {
  targetProfileId: string | null;
  targetProfileName: string | null;
  apiBase: string | null;
  adminKeyConfigured: boolean;
  managedRuntimeKeyState: LiteLlmManagedRuntimeKeyState;
  trafficBindings: LiteLlmProxyGovernanceTrafficBindings;
  health: LiteLlmProxyGovernanceHealthResult | null;
  checks: LiteLlmProxyGovernancePreflightCheck[];
  canEnable: boolean;
  blockingIssues: string[];
  warnings: string[];
}

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
  managedRuntimeKeyState: LiteLlmManagedRuntimeKeyState;
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
  managedRuntimeKeyState: LiteLlmManagedRuntimeKeyState;
  managedRuntimeKeyAlias: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

interface ResolvedLiteLlmProxyGovernanceSecret {
  value?: string;
  state: LiteLlmManagedRuntimeKeyState;
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
    });
  }

  async getEnablePreflight(input?: {
    targetProfileId?: string | null;
  }): Promise<LiteLlmProxyGovernancePreflightPublic> {
    const stored = await this.loadStoredSettings();
    const resolved = this.resolveEffectiveConfig(stored);
    const targetProfileId =
      input?.targetProfileId !== undefined
        ? this.normalizeOptionalString(input.targetProfileId) ?? null
        : resolved.targetProfileId;
    const targetProfile = await this.resolveTargetProfile(targetProfileId);
    const bindings = await this.gatewaySettings.getRuntimeBindingSnapshot();
    const trafficBindings: LiteLlmProxyGovernanceTrafficBindings = {
      completion:
        Boolean(targetProfile) &&
        bindings.completionProfileId === targetProfile?.id,
      embedding:
        Boolean(targetProfile) &&
        bindings.embeddingProfileId === targetProfile?.id,
      rerank:
        Boolean(targetProfile) && bindings.rerankProfileId === targetProfile?.id,
    };
    const health = targetProfile
      ? await this.checkTargetProfileHealth(targetProfile)
      : null;
    const hasTrafficBindings =
      trafficBindings.completion ||
      trafficBindings.embedding ||
      trafficBindings.rerank;
    const healthOk =
      Boolean(health?.liveliness.ok) && Boolean(health?.readiness.ok);
    const checks: LiteLlmProxyGovernancePreflightCheck[] = [
      {
        key: "admin_key",
        ok: this.hasAdminKey(),
        required: true,
        message: this.hasAdminKey()
          ? "LiteLLM admin key is configured."
          : "Configure LITELLM_MASTER_KEY before enabling governance.",
      },
      {
        key: "target_profile",
        ok: Boolean(targetProfile),
        required: true,
        message: targetProfile
          ? `Target profile ${targetProfile.name} is enabled.`
          : "Select an enabled LiteLLM target profile before enabling governance.",
      },
      {
        key: "runtime_traffic",
        ok: hasTrafficBindings,
        required: true,
        message: hasTrafficBindings
          ? `Runtime traffic currently uses the target profile for ${this.describeTrafficBindings(
              trafficBindings,
            )}.`
          : "Completion, embedding, and rerank are not currently bound to the selected target profile.",
      },
      {
        key: "proxy_health",
        ok: healthOk,
        required: true,
        message: health
          ? healthOk
            ? "LiteLLM liveliness and readiness checks are healthy."
            : "LiteLLM liveliness/readiness checks are failing for the selected target profile."
          : "LiteLLM health checks have not been run for the selected target profile.",
      },
      {
        key: "managed_runtime_key",
        ok: resolved.managedRuntimeKeyState !== "unreadable",
        required: false,
        message:
          resolved.managedRuntimeKeyState === "available"
            ? "Stored managed runtime key is readable."
            : resolved.managedRuntimeKeyState === "missing"
              ? "Managed runtime key will be created when governance is enabled."
              : "Stored managed runtime key is unreadable. Runtime governance will fail closed until secret decryption is fixed.",
      },
    ];
    const blockingIssues = checks
      .filter((check) => check.required && !check.ok)
      .map((check) => check.message);
    const warnings = checks
      .filter((check) => !check.required && !check.ok)
      .map((check) => check.message);

    return {
      targetProfileId: targetProfile?.id ?? targetProfileId,
      targetProfileName: targetProfile?.name ?? null,
      apiBase: targetProfile?.apiBase ?? null,
      adminKeyConfigured: this.hasAdminKey(),
      managedRuntimeKeyState: resolved.managedRuntimeKeyState,
      trafficBindings,
      health,
      checks,
      canEnable: blockingIssues.length === 0,
      blockingIssues,
      warnings,
    };
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
    let managedResourcesToDisable: ResolvedLiteLlmProxyGovernanceSettings | null =
      null;

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
      await this.assertEnablePreflight(next.targetProfileId);
      const targetProfile = await this.requireTargetProfile(next.targetProfileId);
      const shouldDisablePreviousManagedResources =
        await this.isSwitchingManagedProxyInstance(
          current,
          targetProfile.apiBase,
        );
      const synced = await this.syncEnabledSettings(next, targetProfile.apiBase);
      next.managedTeamId = synced.managedTeamId;
      next.managedRuntimeKey = synced.managedRuntimeKey;
      next.managedRuntimeKeyState = "available";
      next.managedRuntimeKeyAlias = synced.managedRuntimeKeyAlias;
      next.lastSyncedAt = new Date().toISOString();
      next.lastSyncError = null;
      if (shouldDisablePreviousManagedResources) {
        managedResourcesToDisable = current;
      }
    } else {
      action = "litellm_proxy_governance_disable";
      next.managedTeamId = null;
      next.managedRuntimeKey = undefined;
      next.managedRuntimeKeyState = "missing";
      next.managedRuntimeKeyAlias = null;
      next.lastSyncedAt = current.lastSyncedAt;
      next.lastSyncError = null;
      managedResourcesToDisable = current;
    }

    await this.persistSettingsAndInvalidateCache(actorId, next);
    if (managedResourcesToDisable) {
      await this.disableManagedResourcesBestEffort(managedResourcesToDisable);
    }
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
    return this.toPublicSettings("db", next, {
    });
  }

  async resetToDefaults(
    orgId: string,
    actorId: string,
  ): Promise<LiteLlmProxyGovernanceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const current = this.resolveEffectiveConfig(stored);

    await this.deleteStoredSettingsAndInvalidateCache();
    await this.disableManagedResourcesBestEffort(current);

    await this.writeAuditLog(orgId, actorId, "litellm_proxy_governance_reset", {
      ok: true,
      apiBase: await this.resolveGovernedApiBase(current),
      targetProfileId: current.targetProfileId,
    });
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
    const previousRuntimeKey =
      oldKey && oldKey !== generated.key ? oldKey : null;

    const next: ResolvedLiteLlmProxyGovernanceSettings = {
      ...current,
      managedRuntimeKey: generated.key,
      managedRuntimeKeyState: "available",
      managedRuntimeKeyAlias: generated.keyAlias,
      lastSyncedAt: new Date().toISOString(),
      lastSyncError: null,
    };

    await this.persistSettingsAndInvalidateCache(actorId, next);
    if (previousRuntimeKey) {
      await this.blockRuntimeKeyBestEffort(adminClient, previousRuntimeKey);
    }
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
    return this.toPublicSettings("db", next, {
    });
  }

  async getManagedRuntimeApiKeyForProfile(
    profileId: string,
    apiBase: string,
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
    if (!this.matchesGovernedProfile(profileId, apiBase, targetProfile)) {
      return null;
    }
    if (resolved.managedRuntimeKeyState === "unreadable") {
      throw new ServiceUnavailableException(
        "LiteLLM governance is enabled but the managed runtime key is unreadable",
      );
    }
    if (!resolved.managedRuntimeKey) {
      throw new ServiceUnavailableException(
        "LiteLLM governance is enabled but the managed runtime key is missing",
      );
    }
    return resolved.managedRuntimeKey;
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
    authMode: "profile_key" | "managed_runtime_key" = "profile_key",
  ): Promise<string | undefined> {
    if (authMode === "profile_key") {
      return this.normalizeSecret(fallbackApiKey);
    }
    if (!profileId) {
      throw new BadRequestException(
        "Managed runtime key tests require a saved LiteLLM gateway profile",
      );
    }

    const managedRuntimeKey = await this.getManagedRuntimeApiKeyForProfile(
      profileId,
      apiBase,
    );
    if (!managedRuntimeKey) {
      throw new BadRequestException(
        "Selected profile is not the active LiteLLM governance target",
      );
    }
    return managedRuntimeKey;
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
    const managedRuntimeKey = this.resolveSecret(stored?.managedRuntimeKey);
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
      managedRuntimeKey: managedRuntimeKey.value,
      managedRuntimeKeyState: managedRuntimeKey.state,
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
          throw this.toSyncError(
            error,
            "Failed to update LiteLLM managed runtime key",
          );
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

  private async persistSettingsAndInvalidateCache(
    actorId: string,
    settings: ResolvedLiteLlmProxyGovernanceSettings,
  ): Promise<void> {
    await this.persistSettings(actorId, settings);
    await this.invalidateCache();
  }

  private async deleteStoredSettingsAndInvalidateCache(): Promise<void> {
    await this.prisma.systemSetting.deleteMany({
      where: { key: SETTINGS_KEY },
    });
    await this.invalidateCache();
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

  private resolveSecret(raw: unknown): ResolvedLiteLlmProxyGovernanceSecret {
    if (!raw) {
      return { state: "missing" };
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      return trimmed
        ? { value: trimmed, state: "available" }
        : { state: "missing" };
    }
    if (isEncryptedStringValueV1(raw)) {
      const key = resolveSettingsKey(this.env);
      if (!key) {
        this.logger.warn(
          "Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for LiteLLM proxy governance secret",
        );
        return { state: "unreadable" };
      }
      try {
        const decrypted = decryptStringValueV1(raw, key);
        const trimmed = decrypted.trim();
        return trimmed
          ? { value: trimmed, state: "available" }
          : { state: "missing" };
      } catch (error) {
        this.logger.warn(
          { err: error },
          "Failed to decrypt LiteLLM proxy governance secret",
        );
        return { state: "unreadable" };
      }
    }
    return { state: "missing" };
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

  private async assertEnablePreflight(
    targetProfileId: string | null,
  ): Promise<void> {
    const preflight = await this.getEnablePreflight({ targetProfileId });
    if (preflight.canEnable) {
      return;
    }
    throw new BadRequestException(preflight.blockingIssues.join(" "));
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

  private async checkTargetProfileHealth(
    targetProfile: LlmGatewayProfileSummary,
  ): Promise<LiteLlmProxyGovernanceHealthResult> {
    const baseUrl = normalizeOpenAiApiBase(targetProfile.apiBase);
    if (!baseUrl) {
      return {
        apiBase: targetProfile.apiBase,
        checkedAt: new Date().toISOString(),
        liveliness: {
          ok: false,
          message: "Target profile apiBase is not a valid OpenAI-compatible base URL.",
        },
        readiness: {
          ok: false,
          message: "Target profile apiBase is not a valid OpenAI-compatible base URL.",
        },
      };
    }
    const apiKey = await this.resolveTestingApiKey(
      baseUrl,
      undefined,
      targetProfile.id,
      "profile_key",
    );
    const client = axios.create({
      baseURL: baseUrl,
      timeout: 10_000,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    const [liveliness, readiness] = await Promise.all([
      this.checkProxyEndpoint(client, "/health/liveliness"),
      this.checkProxyEndpoint(client, "/health/readiness"),
    ]);
    return {
      apiBase: baseUrl,
      checkedAt: new Date().toISOString(),
      liveliness,
      readiness,
    };
  }

  private async checkProxyEndpoint(
    client: ReturnType<typeof axios.create>,
    path: string,
  ): Promise<LiteLlmProxyGovernanceEndpointCheck> {
    try {
      const response = await client.get(path, { timeout: 10_000 });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
      };
    } catch (error) {
      if (error instanceof AxiosError) {
        const detail =
          typeof error.response?.data === "string"
            ? error.response.data
            : typeof (error.response?.data as { detail?: unknown })?.detail ===
                "string"
              ? ((error.response?.data as { detail?: string }).detail ?? "")
              : error.message;
        return {
          ok: false,
          ...(typeof error.response?.status === "number"
            ? { status: error.response.status }
            : {}),
          message: detail.trim() || "Proxy health check failed",
        };
      }
      return {
        ok: false,
        message:
          error instanceof Error ? error.message : "Proxy health check failed",
      };
    }
  }

  private describeTrafficBindings(
    bindings: LiteLlmProxyGovernanceTrafficBindings,
  ): string {
    const labels = [
      bindings.completion ? "completion" : null,
      bindings.embedding ? "embedding" : null,
      bindings.rerank ? "rerank" : null,
    ].filter((value): value is string => value !== null);
    return labels.join(", ");
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
      profileId === targetProfile.id && normalizedCandidate === normalizedTarget
    );
  }

  private async isSwitchingManagedProxyInstance(
    current: ResolvedLiteLlmProxyGovernanceSettings,
    nextApiBase: string,
  ): Promise<boolean> {
    if (!current.enabled) {
      return false;
    }

    const currentApiBase = await this.resolveGovernedApiBase(current);
    const normalizedCurrent = currentApiBase
      ? normalizeOpenAiApiBase(currentApiBase)
      : "";
    const normalizedNext = normalizeOpenAiApiBase(nextApiBase);
    if (!normalizedCurrent || !normalizedNext) {
      return false;
    }
    return normalizedCurrent !== normalizedNext;
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
      hasManagedRuntimeKey: resolved.managedRuntimeKeyState !== "missing",
      managedRuntimeKeyState: resolved.managedRuntimeKeyState,
      managedTeamId: resolved.managedTeamId,
      managedRuntimeKeyAlias: resolved.managedRuntimeKeyAlias,
      lastSyncedAt: resolved.lastSyncedAt,
      lastSyncError:
        resolved.enabled && resolved.targetProfileId && !targetProfile
          ? "Managed governance target profile is missing or disabled"
          : resolved.managedRuntimeKeyState === "unreadable"
            ? "Managed runtime key is unreadable because secret decryption failed"
          : resolved.lastSyncError,
    };
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
