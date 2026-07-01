import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

const readJson = (relativePath: string) =>
  JSON.parse(read(relativePath)) as Record<string, unknown>;

const collectLeafPaths = (
  value: Record<string, unknown> | unknown,
  prefix = "",
): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) =>
      collectLeafPaths(child, prefix ? `${prefix}.${key}` : key),
    )
    .sort();
};

describe("llm gateway governance admin UI wiring", () => {
  it("supports binding completion, embedding, and rerank traffic from the governance dialog", () => {
    const source = read("components/settings/llm-gateway-settings-panel.tsx");

    expect(source).toContain(
      "proxyGovernance.preflight.actions.bindCompletion",
    );
    expect(source).toContain("proxyGovernance.preflight.actions.bindEmbedding");
    expect(source).toContain("proxyGovernance.preflight.actions.bindRerank");
    expect(source).toContain(
      "void handleActivate(selectedGovernanceProfile.id);",
    );
    expect(source).toMatch(
      /void handleActivateEmbedding\(\s*selectedGovernanceProfile\.id,?\s*\);/,
    );
    expect(source).toContain(
      "void handleActivateRerank(selectedGovernanceProfile.id);",
    );
    expect(source).toContain(
      '"system-settings/llm-gateways/proxy-governance/preflight"',
    );
  });

  it("avoids reloading observed usage for the same governed profile and surfaces governance-vs-direct observations", () => {
    const source = read("components/settings/llm-gateway-settings-panel.tsx");

    expect(source).toContain("governanceUsageProfileId");
    expect(source).toContain("if (profileId === governanceUsageProfileId) {");
    expect(source).toContain("normalizeObservedUsageSummary");
    expect(source).toContain("leadingError");
    expect(source).toContain("governanceBreakdown");
    expect(source).toContain("managed_runtime_key");
    expect(source).toContain("requests in the last 24h");
  });

  it("ships matching governance locale branches for english and chinese", () => {
    const en = readJson("lib/locales/en.json") as {
      settings: { llmGateway: { proxyGovernance: Record<string, unknown> } };
    };
    const zh = readJson("lib/locales/zh.json") as {
      settings: { llmGateway: { proxyGovernance: Record<string, unknown> } };
    };

    const enGovernance = en.settings.llmGateway.proxyGovernance;
    const zhGovernance = zh.settings.llmGateway.proxyGovernance;

    expect(collectLeafPaths(zhGovernance)).toEqual(
      collectLeafPaths(enGovernance),
    );

    expect(zhGovernance).toMatchObject({
      bindings: {
        completion: "对话",
        embedding: "嵌入",
        rerank: "重排",
      },
      preflight: {
        apiBase: "代理 API 地址：{{value}}",
        liveliness: "存活检查：{{value}}",
        readiness: "就绪检查：{{value}}",
      },
      observed: {
        dayRemaining: "24h 剩余额度：{{value}}",
        monthRemaining: "30d 剩余额度：{{value}}",
        cards: {
          profileKeyRequests: "Profile-Key 直连请求",
        },
      },
    });
  });
});
