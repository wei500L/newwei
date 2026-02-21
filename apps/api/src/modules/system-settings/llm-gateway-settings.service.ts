import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService, type LiteLlmEnvConfig } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "../storage/storage-settings.crypto";

import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type LlmGatewayEmbeddingMode = "follow_completion" | "use_default";
export type LlmGatewayRerankMode = "follow_completion" | "use_default";
export type LlmGatewayResponseFormatMode =
  | "json_schema"
  | "json_object"
  | "none";
export type LlmGatewayApiSurface = "chat_completions" | "responses";

export interface LlmGatewayCompatibilityOptions {
  sendMetadata: boolean;
  responseFormatMode: LlmGatewayResponseFormatMode;
  apiSurface: LlmGatewayApiSurface;
}

export type LlmGatewayResolvedConfig = LiteLlmEnvConfig &
  LlmGatewayCompatibilityOptions & {
    apiKey?: string;
    assistantModel?: string;
  };

export type LlmGatewayProfilePublic = Omit<LiteLlmEnvConfig, "apiKey"> &
  LlmGatewayCompatibilityOptions & {
    id: string;
    name: string;
    assistantModel?: string;
    enabled: boolean;
    hasApiKey: boolean;
    createdAt: string;
    updatedAt: string;
  };

export interface LlmGatewaySettingsPublic {
  activeId: string | null;
  embeddingActiveId: string | null;
  embeddingMode: LlmGatewayEmbeddingMode;
  rerankActiveId: string | null;
  rerankMode: LlmGatewayRerankMode;
  profiles: LlmGatewayProfilePublic[];
}

export type LlmGatewayProfileInput =
  Partial<Omit<LiteLlmEnvConfig, "apiKey" | "embeddingModel" | "rerankModel">> &
    Partial<LlmGatewayCompatibilityOptions> & {
      name?: string;
      enabled?: boolean;
      apiKey?: string | null;
      embeddingModel?: string | null;
      rerankModel?: string | null;
      assistantModel?: string | null;
    };

interface StoredProfile
  extends Omit<LiteLlmEnvConfig, "apiKey">,
    LlmGatewayCompatibilityOptions {
  id: string;
  name: string;
  apiKey?: unknown;
  assistantModel?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StoredSettings {
  activeId: string | null;
  embeddingActiveId: string | null;
  embeddingMode: LlmGatewayEmbeddingMode;
  rerankActiveId: string | null;
  rerankMode: LlmGatewayRerankMode;
  profiles: StoredProfile[];
}

const SETTINGS_KEY = "llm_gateway_profiles";
const SETTINGS_DESCRIPTION =
  "OpenAI-compatible LLM gateway profiles (apiBase/apiKey/model overrides).";
const CACHE_KEY = "llm_gateway:profiles";
const CACHE_TTL_SECONDS = 60;

const DEFAULT_SEND_METADATA = true;
const DEFAULT_RESPONSE_FORMAT_MODE: LlmGatewayResponseFormatMode = "json_schema";
const DEFAULT_API_SURFACE: LlmGatewayApiSurface = "chat_completions";

@Injectable()
export class LlmGatewaySettingsService {
  private readonly logger = createLogger({ name: "llm-gateway-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService
  ) {}

  async list(): Promise<LlmGatewaySettingsPublic> {
    const settings = await this.loadSettings();
    return {
      activeId: settings.activeId,
      embeddingActiveId: settings.embeddingActiveId,
      embeddingMode: settings.embeddingMode,
      rerankActiveId: settings.rerankActiveId,
      rerankMode: settings.rerankMode,
      profiles: settings.profiles.map((profile) => this.toPublicProfile(profile))
    };
  }

  async createProfile(
    orgId: string,
    actorId: string,
    input: LlmGatewayProfileInput
  ): Promise<LlmGatewayProfilePublic> {
    const settings = await this.loadSettings();
    const fallback = this.env.liteLlmConfig;
    const now = new Date().toISOString();
    const profile = await this.buildProfileFromInput(
      {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now
      },
      fallback,
      input
    );

    settings.profiles.push(profile);
    if (!settings.activeId) {
      settings.activeId = profile.id;
    }

    await this.saveSettings(orgId, actorId, settings, "llm_gateway_create", {
      id: profile.id,
      name: profile.name,
      apiBase: profile.apiBase,
      model: profile.model,
      assistantModel: profile.assistantModel,
      rerankModel: profile.rerankModel,
      rerankFallbackModels: profile.rerankFallbackModels,
      enabled: profile.enabled,
      hasApiKey: this.hasApiKey(profile),
      sendMetadata: profile.sendMetadata,
      responseFormatMode: profile.responseFormatMode,
      apiSurface: profile.apiSurface
    });

    return this.toPublicProfile(profile);
  }

  async updateProfile(
    orgId: string,
    actorId: string,
    id: string,
    input: LlmGatewayProfileInput
  ): Promise<LlmGatewayProfilePublic> {
    const settings = await this.loadSettings();
    const index = settings.profiles.findIndex((profile) => profile.id === id);
    if (index === -1) {
      throw new NotFoundException("LLM gateway profile not found");
    }
    const existing = settings.profiles[index];
    if (!existing) {
      throw new NotFoundException("LLM gateway profile not found");
    }
    const updated = await this.buildProfileFromInput(
      { ...existing, id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() },
      existing,
      input
    );
    settings.profiles[index] = updated;
    if (settings.activeId === id && !updated.enabled) {
      settings.activeId = null;
    }
    if (settings.embeddingActiveId === id && (!updated.enabled || !updated.embeddingModel)) {
      settings.embeddingActiveId = null;
    }
    if (settings.rerankActiveId === id && (!updated.enabled || !updated.rerankModel)) {
      settings.rerankActiveId = null;
    }

    await this.saveSettings(orgId, actorId, settings, "llm_gateway_update", {
      id,
      name: updated.name,
      apiBase: updated.apiBase,
      model: updated.model,
      assistantModel: updated.assistantModel,
      rerankModel: updated.rerankModel,
      rerankFallbackModels: updated.rerankFallbackModels,
      enabled: updated.enabled,
      hasApiKey: this.hasApiKey(updated),
      sendMetadata: updated.sendMetadata,
      responseFormatMode: updated.responseFormatMode,
      apiSurface: updated.apiSurface
    });

    return this.toPublicProfile(updated);
  }

  async deleteProfile(orgId: string, actorId: string, id: string) {
    const settings = await this.loadSettings();
    const nextProfiles = settings.profiles.filter((profile) => profile.id !== id);
    if (nextProfiles.length === settings.profiles.length) {
      throw new NotFoundException("LLM gateway profile not found");
    }
    settings.profiles = nextProfiles;
    if (settings.activeId === id) {
      settings.activeId = null;
    }
    if (settings.embeddingActiveId === id) {
      settings.embeddingActiveId = null;
    }
    if (settings.rerankActiveId === id) {
      settings.rerankActiveId = null;
    }

    await this.saveSettings(orgId, actorId, settings, "llm_gateway_delete", { id });
  }

  async setActiveProfile(
    orgId: string,
    actorId: string,
    activeId: string | null
  ): Promise<LlmGatewaySettingsPublic> {
    const settings = await this.loadSettings();
    if (activeId) {
      const found = settings.profiles.find((profile) => profile.id === activeId);
      if (!found) {
        throw new NotFoundException("LLM gateway profile not found");
      }
      if (!found.enabled) {
        throw new BadRequestException("Cannot activate a disabled LLM gateway profile");
      }
    }
    settings.activeId = activeId;

    await this.saveSettings(orgId, actorId, settings, "llm_gateway_activate", {
      activeId
    });

    return this.list();
  }

  async setEmbeddingActiveProfile(
    orgId: string,
    actorId: string,
    activeId: string | null,
    mode?: LlmGatewayEmbeddingMode
  ): Promise<LlmGatewaySettingsPublic> {
    const settings = await this.loadSettings();
    if (activeId) {
      const found = settings.profiles.find((profile) => profile.id === activeId);
      if (!found) {
        throw new NotFoundException("LLM gateway profile not found");
      }
      if (!found.enabled) {
        throw new BadRequestException("Cannot activate a disabled LLM gateway profile");
      }
      if (!found.embeddingModel) {
        throw new BadRequestException("Embeddings gateway profile must configure embeddingModel");
      }
    }
    settings.embeddingActiveId = activeId;
    if (!activeId) {
      settings.embeddingMode = mode ?? "follow_completion";
    }

    await this.saveSettings(orgId, actorId, settings, "llm_gateway_embedding_activate", {
      embeddingActiveId: activeId
    });

    return this.list();
  }

  async setRerankActiveProfile(
    orgId: string,
    actorId: string,
    activeId: string | null,
    mode?: LlmGatewayRerankMode
  ): Promise<LlmGatewaySettingsPublic> {
    const settings = await this.loadSettings();
    if (activeId) {
      const found = settings.profiles.find((profile) => profile.id === activeId);
      if (!found) {
        throw new NotFoundException("LLM gateway profile not found");
      }
      if (!found.enabled) {
        throw new BadRequestException("Cannot activate a disabled LLM gateway profile");
      }
      if (!found.rerankModel) {
        throw new BadRequestException("Rerank gateway profile must configure rerankModel");
      }
    }
    settings.rerankActiveId = activeId;
    if (!activeId) {
      settings.rerankMode = mode ?? "follow_completion";
    }

    await this.saveSettings(orgId, actorId, settings, "llm_gateway_rerank_activate", {
      rerankActiveId: activeId
    });

    return this.list();
  }

  async getActiveConfig(): Promise<LlmGatewayResolvedConfig | null> {
    const settings = await this.loadSettings();
    const activeProfile = settings.activeId
      ? settings.profiles.find((candidate) => candidate.id === settings.activeId) ?? null
      : null;
    const profile =
      activeProfile && activeProfile.enabled
        ? activeProfile
        : this.resolveDefaultProfile(settings, "completion");
    if (!profile) {
      return null;
    }

    return this.toResolvedConfig(profile);
  }

  async getActiveEmbeddingConfig(): Promise<LlmGatewayResolvedConfig | null> {
    const settings = await this.loadSettings();
    const resolvedId =
      settings.embeddingActiveId ??
      (settings.embeddingMode === "use_default" ? null : settings.activeId);
    const explicitProfile = resolvedId
      ? settings.profiles.find((candidate) => candidate.id === resolvedId) ?? null
      : null;
    if (explicitProfile && explicitProfile.enabled && explicitProfile.embeddingModel) {
      return this.toResolvedConfig(explicitProfile);
    }
    const fallbackProfile =
      settings.embeddingMode === "use_default" || !resolvedId
        ? this.resolveDefaultProfile(settings, "embedding")
        : null;
    if (!fallbackProfile) {
      return null;
    }
    return this.toResolvedConfig(fallbackProfile);
  }

  async getActiveRerankConfig(): Promise<LlmGatewayResolvedConfig | null> {
    const settings = await this.loadSettings();
    const resolvedId =
      settings.rerankActiveId ??
      (settings.rerankMode === "use_default" ? null : settings.activeId);
    const explicitProfile = resolvedId
      ? settings.profiles.find((candidate) => candidate.id === resolvedId) ?? null
      : null;
    if (explicitProfile && explicitProfile.enabled && explicitProfile.rerankModel) {
      return this.toResolvedConfig(explicitProfile);
    }
    const fallbackProfile =
      settings.rerankMode === "use_default" || !resolvedId
        ? this.resolveDefaultProfile(settings, "rerank")
        : null;
    if (!fallbackProfile) {
      return null;
    }
    return this.toResolvedConfig(fallbackProfile);
  }

  async getProfileConfig(id: string): Promise<LlmGatewayResolvedConfig | null> {
    const settings = await this.loadSettings();
    const profile = settings.profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      return null;
    }

    return this.toResolvedConfig(profile);
  }

  private toResolvedConfig(profile: StoredProfile): LlmGatewayResolvedConfig {
    const apiKey = this.resolveApiKey(profile.apiKey);
    return {
      model: profile.model,
      embeddingModel: profile.embeddingModel,
      rerankModel: profile.rerankModel,
      ...(profile.assistantModel ? { assistantModel: profile.assistantModel } : {}),
      apiBase: profile.apiBase,
      apiKey,
      timeoutMs: profile.timeoutMs,
      temperature: profile.temperature,
      topP: profile.topP,
      maxOutputTokens: profile.maxOutputTokens,
      maxRetries: profile.maxRetries,
      fallbackModels: profile.fallbackModels,
      rerankFallbackModels: profile.rerankFallbackModels,
      requestsPerMinute: profile.requestsPerMinute,
      sendMetadata: profile.sendMetadata,
      responseFormatMode: profile.responseFormatMode,
      apiSurface: profile.apiSurface
    };
  }

  private resolveDefaultProfile(
    settings: StoredSettings,
    kind: "completion" | "embedding" | "rerank"
  ): StoredProfile | null {
    for (const profile of settings.profiles) {
      if (!profile.enabled) {
        continue;
      }
      if (kind === "completion") {
        return profile;
      }
      if (kind === "embedding" && profile.embeddingModel) {
        return profile;
      }
      if (kind === "rerank" && profile.rerankModel) {
        return profile;
      }
    }
    return null;
  }

  private async loadSettings(): Promise<StoredSettings> {
    let cached: StoredSettings | null = null;
    try {
      cached = await this.cache.get<StoredSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to read LLM gateway settings from cache; falling back to database"
      );
    }

    if (cached) {
      return this.normalizeSettings(cached);
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY }
    });
    const raw = (record?.value as unknown) ?? {};
    const normalized = this.normalizeSettings(raw);
    try {
      await this.cache.set(CACHE_KEY, normalized, CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write LLM gateway settings cache");
    }
    return normalized;
  }

  private async saveSettings(
    orgId: string,
    actorId: string,
    settings: StoredSettings,
    action: string,
    auditMetadata: Prisma.InputJsonObject
  ) {
    const settingsValue = this.toPrismaJson(settings);
    const auditValue = this.toPrismaJson(auditMetadata);

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: settingsValue,
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false
      },
      create: {
        key: SETTINGS_KEY,
        value: settingsValue,
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action,
          metadata: auditValue
        }
      },
      { orgId, actorId, resource: "system_settings", action }
    );

    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate LLM gateway settings cache");
    }
  }

  private normalizeSettings(raw: unknown): StoredSettings {
    const record = raw as Partial<StoredSettings> | null;
    const activeIdRaw = this.normalizeString(record?.activeId) ?? null;
    const embeddingActiveIdRaw =
      this.normalizeString((record as unknown as { embeddingActiveId?: unknown })?.embeddingActiveId) ?? null;
    const rerankActiveIdRaw =
      this.normalizeString((record as unknown as { rerankActiveId?: unknown })?.rerankActiveId) ?? null;
    const embeddingModeRaw = this.normalizeString((record as { embeddingMode?: unknown } | null)?.embeddingMode);
    const rerankModeRaw = this.normalizeString((record as { rerankMode?: unknown } | null)?.rerankMode);
    const embeddingMode: LlmGatewayEmbeddingMode =
      embeddingModeRaw === "use_default" ? "use_default" : "follow_completion";
    const rerankMode: LlmGatewayRerankMode =
      rerankModeRaw === "use_default" ? "use_default" : "follow_completion";
    const profiles = Array.isArray(record?.profiles) ? record?.profiles : [];

    const normalizedProfiles = profiles
      .map((entry) => this.normalizeProfile(entry))
      .filter((entry): entry is StoredProfile => entry !== null);

    const activeProfile = activeIdRaw
      ? normalizedProfiles.find((profile) => profile.id === activeIdRaw)
      : null;
    const activeId = activeProfile && activeProfile.enabled ? activeProfile.id : null;

    const embeddingProfile = embeddingActiveIdRaw
      ? normalizedProfiles.find((profile) => profile.id === embeddingActiveIdRaw)
      : null;
    const embeddingActiveId =
      embeddingProfile && embeddingProfile.enabled && embeddingProfile.embeddingModel
        ? embeddingProfile.id
        : null;
    const rerankProfile = rerankActiveIdRaw
      ? normalizedProfiles.find((profile) => profile.id === rerankActiveIdRaw)
      : null;
    const rerankActiveId =
      rerankProfile && rerankProfile.enabled && rerankProfile.rerankModel
        ? rerankProfile.id
        : null;

    return {
      activeId,
      embeddingActiveId,
      embeddingMode,
      rerankActiveId,
      rerankMode,
      profiles: normalizedProfiles
    };
  }

  private normalizeProfile(raw: unknown): StoredProfile | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const record = raw as Partial<StoredProfile>;
    const fallback = this.env.liteLlmConfig;

    const id = this.normalizeString(record.id);
    if (!id) {
      return null;
    }

    const name = this.normalizeString(record.name) ?? id;
    const apiBase = this.normalizeString(record.apiBase) ?? fallback.apiBase;
    const model = this.normalizeString(record.model);
    if (!model) {
      return null;
    }

    return {
      id,
      name,
      apiBase,
      apiKey: record.apiKey,
      model,
      embeddingModel: this.normalizeOptionalString(record.embeddingModel),
      rerankModel: this.normalizeOptionalString(record.rerankModel),
      rerankFallbackModels: this.normalizeStringList(record.rerankFallbackModels, []),
      assistantModel: this.normalizeOptionalString(record.assistantModel),
      timeoutMs: this.asPositiveInt(record.timeoutMs, fallback.timeoutMs),
      temperature: this.clampNumber(record.temperature, fallback.temperature, 0, 2),
      topP: this.clampNumber(record.topP, fallback.topP, 0, 1),
      maxOutputTokens: this.asPositiveInt(record.maxOutputTokens, fallback.maxOutputTokens),
      maxRetries: this.asPositiveInt(record.maxRetries, fallback.maxRetries),
      fallbackModels: this.normalizeStringList(record.fallbackModels, []),
      requestsPerMinute: this.asPositiveInt(record.requestsPerMinute, fallback.requestsPerMinute),
      sendMetadata: this.normalizeBoolean(record.sendMetadata, DEFAULT_SEND_METADATA),
      responseFormatMode: this.normalizeResponseFormatMode(
        record.responseFormatMode,
        DEFAULT_RESPONSE_FORMAT_MODE
      ),
      apiSurface: this.normalizeApiSurface(record.apiSurface, DEFAULT_API_SURFACE),
      enabled: record.enabled ?? true,
      createdAt: this.normalizeString(record.createdAt) ?? new Date().toISOString(),
      updatedAt: this.normalizeString(record.updatedAt) ?? new Date().toISOString()
    };
  }

  private async buildProfileFromInput(
    base: Pick<StoredProfile, "id" | "createdAt" | "updatedAt"> &
      Partial<StoredProfile>,
    fallback: LiteLlmEnvConfig | StoredProfile,
    input: LlmGatewayProfileInput
  ): Promise<StoredProfile> {
    const name = this.normalizeString(input.name) ?? base.name ?? (fallback as StoredProfile).name;
    if (!name) {
      throw new BadRequestException("name is required");
    }

    const apiBase = this.normalizeString(input.apiBase) ?? base.apiBase ?? fallback.apiBase;
    const model = this.normalizeString(input.model) ?? base.model;
    if (!apiBase || !model) {
      throw new BadRequestException("apiBase and model are required");
    }

    const nextApiKey = await this.normalizeApiKeyInput(input.apiKey, base.apiKey);

    return {
      id: base.id,
      name,
      apiBase,
      apiKey: nextApiKey,
      model,
      embeddingModel:
        input.embeddingModel !== undefined
          ? this.normalizeOptionalString(input.embeddingModel)
          : base.embeddingModel,
      rerankModel:
        input.rerankModel !== undefined
          ? this.normalizeOptionalString(input.rerankModel)
          : base.rerankModel,
      rerankFallbackModels:
        input.rerankFallbackModels !== undefined
          ? this.normalizeStringList(input.rerankFallbackModels, base.rerankFallbackModels ?? [])
          : base.rerankFallbackModels ?? [],
      assistantModel:
        input.assistantModel !== undefined
          ? this.normalizeOptionalString(input.assistantModel)
          : base.assistantModel ?? (fallback as Partial<StoredProfile>).assistantModel,
      timeoutMs:
        input.timeoutMs !== undefined
          ? this.asPositiveInt(input.timeoutMs, fallback.timeoutMs)
          : base.timeoutMs ?? fallback.timeoutMs,
      temperature:
        input.temperature !== undefined
          ? this.clampNumber(input.temperature, fallback.temperature, 0, 2)
          : base.temperature ?? fallback.temperature,
      topP:
        input.topP !== undefined
          ? this.clampNumber(input.topP, fallback.topP, 0, 1)
          : base.topP ?? fallback.topP,
      maxOutputTokens:
        input.maxOutputTokens !== undefined
          ? this.asPositiveInt(input.maxOutputTokens, fallback.maxOutputTokens)
          : base.maxOutputTokens ?? fallback.maxOutputTokens,
      maxRetries:
        input.maxRetries !== undefined
          ? this.asPositiveInt(input.maxRetries, fallback.maxRetries)
          : base.maxRetries ?? fallback.maxRetries,
      fallbackModels:
        input.fallbackModels !== undefined
          ? this.normalizeStringList(input.fallbackModels, base.fallbackModels ?? [])
          : base.fallbackModels ?? [],
      requestsPerMinute:
        input.requestsPerMinute !== undefined
          ? this.asPositiveInt(input.requestsPerMinute, fallback.requestsPerMinute)
          : base.requestsPerMinute ?? fallback.requestsPerMinute,
      sendMetadata:
        input.sendMetadata !== undefined
          ? input.sendMetadata
          : base.sendMetadata ??
            this.normalizeBoolean(
              (fallback as Partial<StoredProfile>).sendMetadata,
              DEFAULT_SEND_METADATA
            ),
      responseFormatMode:
        input.responseFormatMode !== undefined
          ? this.normalizeResponseFormatMode(
              input.responseFormatMode,
              DEFAULT_RESPONSE_FORMAT_MODE
            )
          : base.responseFormatMode ??
            this.normalizeResponseFormatMode(
              (fallback as Partial<StoredProfile>).responseFormatMode,
              DEFAULT_RESPONSE_FORMAT_MODE
            ),
      apiSurface:
        input.apiSurface !== undefined
          ? this.normalizeApiSurface(input.apiSurface, DEFAULT_API_SURFACE)
          : base.apiSurface ??
            this.normalizeApiSurface(
              (fallback as Partial<StoredProfile>).apiSurface,
              DEFAULT_API_SURFACE
            ),
      enabled: input.enabled ?? base.enabled ?? true,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  private async normalizeApiKeyInput(next: string | null | undefined, existing: unknown) {
    if (next === undefined) {
      return existing;
    }

    const normalized = typeof next === "string" ? this.stripBearerPrefix(next) : "";
    if (!normalized) {
      return null;
    }

    return this.securitySettings.encodeSecretForStorage(normalized);
  }

  private resolveApiKey(raw: unknown): string | undefined {
    if (!raw) {
      return undefined;
    }
    if (typeof raw === "string") {
      const trimmed = this.stripBearerPrefix(raw);
      return trimmed ? trimmed : undefined;
    }
    if (isEncryptedStringValueV1(raw)) {
      const key = resolveSettingsKey(this.env);
      if (!key) {
        this.logger.warn("Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for LLM gateway key");
        return undefined;
      }
      try {
        const decrypted = decryptStringValueV1(raw, key);
        const trimmed = this.stripBearerPrefix(decrypted);
        return trimmed ? trimmed : undefined;
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to decrypt LLM gateway key");
        return undefined;
      }
    }
    return undefined;
  }

  private hasApiKey(profile: StoredProfile) {
    return Boolean(this.resolveApiKey(profile.apiKey));
  }

  private toPublicProfile(profile: StoredProfile): LlmGatewayProfilePublic {
    return {
      id: profile.id,
      name: profile.name,
      model: profile.model,
      embeddingModel: profile.embeddingModel,
      rerankModel: profile.rerankModel,
      ...(profile.assistantModel ? { assistantModel: profile.assistantModel } : {}),
      apiBase: profile.apiBase,
      timeoutMs: profile.timeoutMs,
      temperature: profile.temperature,
      topP: profile.topP,
      maxOutputTokens: profile.maxOutputTokens,
      maxRetries: profile.maxRetries,
      fallbackModels: profile.fallbackModels,
      rerankFallbackModels: profile.rerankFallbackModels,
      requestsPerMinute: profile.requestsPerMinute,
      sendMetadata: profile.sendMetadata,
      responseFormatMode: profile.responseFormatMode,
      apiSurface: profile.apiSurface,
      enabled: profile.enabled,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      hasApiKey: this.hasApiKey(profile)
    };
  }

  private normalizeApiSurface(
    value: unknown,
    fallback: LlmGatewayApiSurface
  ): LlmGatewayApiSurface {
    if (value === "chat_completions" || value === "responses") {
      return value;
    }
    return fallback;
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (value === null) {
      return undefined;
    }
    return this.normalizeString(value);
  }

  private normalizeBoolean(value: unknown, fallback: boolean) {
    if (typeof value === "boolean") {
      return value;
    }
    return fallback;
  }

  private normalizeResponseFormatMode(
    value: unknown,
    fallback: LlmGatewayResponseFormatMode
  ): LlmGatewayResponseFormatMode {
    if (value === "none" || value === "json_object" || value === "json_schema") {
      return value;
    }
    return fallback;
  }

  private asPositiveInt(value: unknown, fallback: number) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }

  private clampNumber(value: unknown, fallback: number, min: number, max: number) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  private normalizeStringList(value: unknown, fallback: string[]) {
    if (!Array.isArray(value)) {
      return fallback;
    }
    const trimmed = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return Array.from(new Set(trimmed));
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private stripBearerPrefix(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    if (/^bearer$/i.test(trimmed)) {
      return "";
    }
    return trimmed.replace(/^bearer\s+/i, "").trim();
  }
}
