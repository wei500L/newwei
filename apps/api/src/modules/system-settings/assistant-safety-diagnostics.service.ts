import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import axios from "axios";

import { EnvService } from "../config/config.service";

import { AssistantSafetySettingsService } from "./assistant-safety-settings.service";
import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";
import { OpenAiKeysSettingsService } from "./openai-keys-settings.service";

const logger = createLogger({ name: "assistant-safety-diagnostics" });

export interface AssistantSafetyDiagnosticsResult {
  checkedAt: string;
  litellm: {
    apiBase: string;
    liveliness: { ok: boolean; status: number | null; error: string | null };
    models: { ok: boolean; status: number | null; count: number | null; error: string | null };
    guardrails: {
      ok: boolean;
      status: number | null;
      count: number | null;
      expected: string[];
      missing: string[];
      error: string | null;
    };
  };
  assistantSafety: Awaited<ReturnType<AssistantSafetySettingsService["getPublicSettings"]>>;
  openaiKeys: Awaited<ReturnType<OpenAiKeysSettingsService["getPublicSettings"]>>;
}

function normalizeLiteLlmBase(raw: string): string {
  let base = raw.trim();
  if (!base) {
    return base;
  }
  base = base.replace(/\/+$/, "");

  const lower = base.toLowerCase();
  const stripSuffixes = [
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/models",
    "/models",
    "/health/liveliness"
  ];
  const matchedSuffix = stripSuffixes.find((suffix) => lower.endsWith(suffix));
  if (matchedSuffix) {
    base = base.slice(0, -matchedSuffix.length).replace(/\/+$/, "");
  }
  if (base.toLowerCase().endsWith("/v1")) {
    base = base.slice(0, -"/v1".length).replace(/\/+$/, "");
  }
  return base;
}

function extractStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function extractConfiguredGuardrailNames(data: unknown): string[] {
  if (!data) {
    return [];
  }
  if (Array.isArray(data)) {
    return uniqueStrings(
      data.flatMap((entry) => {
        if (typeof entry === "string") {
          return [entry];
        }
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const name = record.guardrail_name ?? record.name ?? record.guardrailName;
          if (typeof name === "string") {
            return [name];
          }
        }
        return [];
      })
    );
  }
  if (typeof data !== "object") {
    return [];
  }

  const record = data as Record<string, unknown>;
  const list =
    (Array.isArray(record.guardrails) ? record.guardrails : null) ??
    (Array.isArray(record.data) ? record.data : null) ??
    (Array.isArray(record.items) ? record.items : null);
  if (!list) {
    return [];
  }

  return uniqueStrings(
    list.flatMap((entry) => {
      if (typeof entry === "string") {
        return [entry];
      }
      if (entry && typeof entry === "object") {
        const entryRecord = entry as Record<string, unknown>;
        const name = entryRecord.guardrail_name ?? entryRecord.name ?? entryRecord.guardrailName;
        if (typeof name === "string") {
          return [name];
        }
      }
      return [];
    })
  );
}

@Injectable()
export class AssistantSafetyDiagnosticsService {
  constructor(
    private readonly env: EnvService,
    private readonly llmGatewaySettings: LlmGatewaySettingsService,
    private readonly assistantSafety: AssistantSafetySettingsService,
    private readonly openaiKeys: OpenAiKeysSettingsService
  ) {}

  async run(): Promise<AssistantSafetyDiagnosticsResult> {
    const assistantSafety = await this.assistantSafety.getPublicSettings();
    const openaiKeys = await this.openaiKeys.getPublicSettings();

    const overrides = await this.llmGatewaySettings.getActiveConfig();
    const apiBaseRaw = overrides?.apiBase ?? this.env.liteLlmConfig.apiBase;
    const apiKey = overrides?.apiKey ?? this.env.liteLlmConfig.apiKey;
    const apiBase = normalizeLiteLlmBase(apiBaseRaw);

    const livelinessUrl = `${apiBase}/health/liveliness`;
    const modelsPrimaryUrl = `${apiBase}/v1/models`;
    const modelsFallbackUrl = `${apiBase}/models`;

    let livelinessStatus: number | null = null;
    let livelinessOk = false;
    let livelinessError: string | null = null;

    try {
      const resp = await axios.get(livelinessUrl, { timeout: 2_000, validateStatus: () => true });
      livelinessStatus = resp.status;
      livelinessOk = resp.status >= 200 && resp.status < 300;
    } catch (error) {
      livelinessError = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error }, "LiteLLM liveliness check failed");
    }

    let modelsStatus: number | null = null;
    let modelsOk = false;
    let modelsCount: number | null = null;
    let modelsError: string | null = null;

    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;

    async function fetchModels(url: string) {
      return axios.get(url, { timeout: 5_000, validateStatus: () => true, headers });
    }

    try {
      let resp = await fetchModels(modelsPrimaryUrl);
      if (resp.status === 404) {
        resp = await fetchModels(modelsFallbackUrl);
      }
      modelsStatus = resp.status;
      modelsOk = resp.status >= 200 && resp.status < 300;
      if (modelsOk && resp.data && typeof resp.data === "object") {
        const record = resp.data as { data?: unknown };
        if (Array.isArray(record.data)) {
          modelsCount = record.data.length;
        }
      }
    } catch (error) {
      modelsError = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error }, "LiteLLM models check failed");
    }

    const guardrailsPrimaryUrl = `${apiBase}/guardrails/list`;
    const guardrailsFallbackUrl = `${apiBase}/v1/guardrails/list`;
    let guardrailsStatus: number | null = null;
    let guardrailsOk = false;
    let guardrailsCount: number | null = null;
    let guardrailsError: string | null = null;
    let configuredGuardrails: string[] = [];

    async function fetchGuardrails(url: string) {
      return axios.get(url, { timeout: 5_000, validateStatus: () => true, headers });
    }

    try {
      let resp = await fetchGuardrails(guardrailsPrimaryUrl);
      if (resp.status === 404) {
        resp = await fetchGuardrails(guardrailsFallbackUrl);
      }
      guardrailsStatus = resp.status;
      guardrailsOk = resp.status >= 200 && resp.status < 300;
      if (guardrailsOk) {
        configuredGuardrails = extractConfiguredGuardrailNames(resp.data);
        guardrailsCount = configuredGuardrails.length;
      }
    } catch (error) {
      guardrailsError = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error }, "LiteLLM guardrails list check failed");
    }

    const expectedGuardrails = (() => {
      if (!assistantSafety.enabled) {
        return [];
      }
      const baseNames = extractStringArray(assistantSafety.guardrails);
      if (baseNames.length === 0) {
        return [];
      }
      const keyCount = Math.max(1, Math.floor(openaiKeys.keysCount ?? 0));
      if (keyCount <= 1) {
        return baseNames;
      }
      const expanded: string[] = [];
      for (const name of baseNames) {
        expanded.push(name);
        for (let index = 2; index <= keyCount; index += 1) {
          expanded.push(`${name}-${index}`);
        }
      }
      return expanded;
    })();

    const missingGuardrails = (() => {
      if (!guardrailsOk) {
        return expectedGuardrails;
      }
      if (expectedGuardrails.length === 0) {
        return [];
      }
      const configured = new Set(configuredGuardrails);
      return expectedGuardrails.filter((name) => !configured.has(name));
    })();

    return {
      checkedAt: new Date().toISOString(),
      litellm: {
        apiBase,
        liveliness: { ok: livelinessOk, status: livelinessStatus, error: livelinessError },
        models: { ok: modelsOk, status: modelsStatus, count: modelsCount, error: modelsError },
        guardrails: {
          ok: guardrailsOk,
          status: guardrailsStatus,
          count: guardrailsCount,
          expected: expectedGuardrails,
          missing: missingGuardrails,
          error: guardrailsError
        }
      },
      assistantSafety,
      openaiKeys
    };
  }
}
