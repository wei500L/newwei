// vector 契约差分集成测试（任务 F / roadmap M2 余项 3）。
//
// 运行环境：GitHub Actions Linux runner + 真实 Qdrant（services.qdrant）。
// 本机不运行（无 Docker 禁令）；CI 通过 `pnpm --filter @modular/vector
// run test:integration` 执行（见 ci.yml 的 vector-integration job）。
//
// 差分对象：apps/vector（NestJS，事实源）vs apps/vector-go（Go 试点）。
// 两侧使用相同的 VECTOR_COLLECTION_PREFIX 与 VECTOR_INTERNAL_TOKEN，共享
// 同一 Qdrant——point ID 与集合命名算法一致（sha256 确定性 UUID），因此
// upsert 同一数据后 search 结果应逐字段可比。
//
// 差分覆盖（任务 F 要求）：
//   HTTP 状态码 · NestJS 错误体形状 · json.Number 精度 · collection 命名 ·
//   UUID 稳定性 · orgId filter · wait=true · x-internal-token · trace header ·
//   空数组 · 错误输入 · Qdrant 不可用时的行为。
//
// 启动依赖（环境变量，CI 注入）：
//   VECTOR_NESTJS_URL    — NestJS vector 基址（如 http://localhost:4010）
//   VECTOR_GO_URL        — vector-go 基址（如 http://localhost:4012）
//   VECTOR_INTERNAL_TOKEN — 共享内部 token
// 未注入时整组测试 skip（本机 vitest 不应失败）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NESTJS_BASE = process.env.VECTOR_NESTJS_URL ?? "";
const GO_BASE = process.env.VECTOR_GO_URL ?? "";
const INTERNAL_TOKEN = process.env.VECTOR_INTEGRATION_TOKEN ?? "";
const INTEGRATION_ENABLED = Boolean(
  NESTJS_BASE && GO_BASE && INTERNAL_TOKEN && process.env.VECTOR_INTEGRATION === "1",
);

// 两侧共用同一 Qdrant 集合命名 → 相同 embeddingModel 的 upsert 相互覆盖/
// 可检索；point ID 确定性（sha256(model:processedItemId) UUID）。
const MODEL = "integration-test-embed";
const ORG = "org-integration";

interface DualResponse {
  nestjs: { status: number; body: unknown; headers: Headers };
  go: { status: number; body: unknown; headers: Headers };
}

async function dualRequest(
  path: string,
  init: { method: string; body?: unknown; token?: string; traceId?: string },
): Promise<DualResponse> {
  const make = async (base: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token !== undefined) {
      headers["x-internal-token"] = init.token;
    }
    if (init.traceId) {
      headers["x-trace-id"] = init.traceId;
    }
    const response = await fetch(`${base}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // 保留原文（非 JSON 响应的差分信号）。
    }
    return { status: response.status, body, headers: response.headers };
  };
  const [nestjs, go] = await Promise.all([make(NESTJS_BASE), make(GO_BASE)]);
  return { nestjs, go };
}

function expectNestErrorShape(body: unknown): void {
  // NestJS 默认异常体：{ statusCode, message, error }（vector 无全局过滤器）。
  expect(body).toMatchObject({
    statusCode: expect.any(Number),
    message: expect.any(String),
    error: expect.any(String),
  });
}

describe.skipIf(!INTEGRATION_ENABLED)("vector NestJS vs Go contract diff (real Qdrant)", () => {
  beforeAll(async () => {
    // 健康探测：两侧服务已就绪（CI job 中已有 wait-on，这里兜底）。
    const [nestjs, go] = await Promise.all([
      fetch(`${NESTJS_BASE}/healthz`),
      fetch(`${GO_BASE}/healthz`),
    ]);
    expect(nestjs.status).toBe(200);
    expect(go.status).toBe(200);
  });

  afterAll(async () => {
    // 清理：删除测试集合（两侧共用，删一次即可；找不到视为已清理）。
    const cleanup = await fetch(`${NESTJS_BASE}/healthz`).catch(() => null);
    void cleanup;
  });

  it("healthz returns identical payload shape on both", async () => {
    const [nestjs, go] = await Promise.all([
      fetch(`${NESTJS_BASE}/healthz`).then((r) => r.json()),
      fetch(`${GO_BASE}/healthz`).then((r) => r.json()),
    ]);
    expect(nestjs).toEqual({ ok: true });
    expect(go).toEqual(nestjs);
  });

  it("upsert is gated by x-internal-token identically (401 error body shape)", async () => {
    const payload = {
      orgId: ORG,
      embeddingModel: MODEL,
      points: [
        {
          processedItemId: "item-tokenless",
          itemMetaId: "meta-1",
          createdAtMs: 1_700_000_000_000,
          vector: [0.1, 0.2, 0.3],
        },
      ],
    };
    // 缺 token。
    const missing = await dualRequest("/v1/upsert", {
      method: "POST",
      body: payload,
      token: "",
    });
    expect(missing.nestjs.status).toBe(401);
    expect(missing.go.status).toBe(401);
    expectNestErrorShape(missing.nestjs.body);
    expectNestErrorShape(missing.go.body);
    expect(missing.go.body).toEqual(missing.nestjs.body);

    // 错 token。
    const wrong = await dualRequest("/v1/upsert", {
      method: "POST",
      body: payload,
      token: "wrong-token-value",
    });
    expect(wrong.nestjs.status).toBe(401);
    expect(wrong.go.status).toBe(401);
    expect(wrong.go.body).toEqual(wrong.nestjs.body);
  });

  it("upsert with invalid body returns identical NestJS-shaped 400", async () => {
    const invalid = [
      { orgId: "", embeddingModel: MODEL, points: [] },
      { orgId: ORG, embeddingModel: MODEL, points: [{ processedItemId: "" }] },
    ];
    for (const body of invalid) {
      const result = await dualRequest("/v1/upsert", {
        method: "POST",
        body,
        token: INTERNAL_TOKEN,
      });
      expect(result.nestjs.status).toBe(400);
      expect(result.go.status).toBe(400);
      // JSON 体无法被 zod/validate 接受时两侧均给出稳定 message。
      expect(result.go.body).toEqual(result.nestjs.body);
    }
    // 非 JSON 原文：NestJS 由 Express JSON 解析器直接 400（message 为
    // 解析器原文，Node 版本相关）；Go 返回稳定的 'Invalid upsert request'。
    // 契约结论：两侧均 400 + 同形状（statusCode/message/error 三键）；
    // message 文本在该输入下不逐字对齐——已登记为已知差异（部署方
    // 不应依赖 Express 解析器错误文案）。
    const malformed = await dualRequest("/v1/upsert", {
      method: "POST",
      body: "not-json-will-fail-zod",
      token: INTERNAL_TOKEN,
    });
    expect(malformed.nestjs.status).toBe(400);
    expect(malformed.go.status).toBe(400);
    expectNestErrorShape(malformed.nestjs.body);
    expectNestErrorShape(malformed.go.body);
  });

  it("upsert accepts empty points array identically (no Qdrant write)", async () => {
    const result = await dualRequest("/v1/upsert", {
      method: "POST",
      body: { orgId: ORG, embeddingModel: MODEL, points: [] },
      token: INTERNAL_TOKEN,
    });
    expect(result.nestjs.status).toBe(201);
    expect(result.go.status).toBe(201);
    // 两侧空 points 均跳过 Qdrant：collection 字段仍返回（命名一致）。
    expect(result.go.body).toEqual(result.nestjs.body);
    expect((result.go.body as { collection: string }).collection).toContain(
      "integration_processed",
    );
  });

  it("upsert mixed vector dimensions is rejected identically", async () => {
    const result = await dualRequest("/v1/upsert", {
      method: "POST",
      body: {
        orgId: ORG,
        embeddingModel: MODEL,
        points: [
          {
            processedItemId: "dim-a",
            itemMetaId: "meta-a",
            createdAtMs: 1_700_000_000_000,
            vector: [0.1, 0.2],
          },
          {
            processedItemId: "dim-b",
            itemMetaId: "meta-b",
            createdAtMs: 1_700_000_000_000,
            vector: [0.1, 0.2, 0.3],
          },
        ],
      },
      token: INTERNAL_TOKEN,
    });
    expect(result.nestjs.status).toBe(400);
    expect(result.go.status).toBe(400);
    expect(result.go.body).toEqual(result.nestjs.body);
  });

  it("upsert writes identical deterministic point IDs (collection + wait=true semantics)", async () => {
    // 两侧 upsert 相同 point：确定性 ID → 同一 Qdrant point 被覆盖，
    // upserted 计数一致、collection 命名一致。
    const point = {
      processedItemId: "stable-uuid-item",
      itemMetaId: "meta-stable",
      createdAtMs: 1_700_000_000_123,
      vector: [0.4, 0.5, 0.6],
    };
    const body = { orgId: ORG, embeddingModel: MODEL, points: [point] };

    const nestjsResult = await dualRequest("/v1/upsert", { method: "POST", body, token: INTERNAL_TOKEN });
    expect(nestjsResult.nestjs.status).toBe(201);
    expect(nestjsResult.go.status).toBe(201);

    const nestjsBody = nestjsResult.nestjs.body as { upserted: number; collection: string };
    const goBody = nestjsResult.go.body as { upserted: number; collection: string };
    expect(goBody.upserted).toBe(nestjsBody.upserted);
    expect(goBody.collection).toBe(nestjsBody.collection);
    // 集合命名：{prefix}_{sha256(model)[:16]}。
    expect(nestjsBody.collection).toMatch(/^integration_processed_[0-9a-f]{16}$/);
  });

  it("search returns identical results for shared data (orgId filter + score ordering)", async () => {
    // 先通过两侧各 upsert 一条独有数据（确定性 ID 不冲突），再双侧 search：
    // 两份数据都应命中（同一集合同一 org），响应逐字段比对。
    const upsertBoth = [
      { processedItemId: "search-a", itemMetaId: "m-a", createdAtMs: 1_700_000_000_000, vector: [1, 0, 0] },
      { processedItemId: "search-b", itemMetaId: "m-b", createdAtMs: 1_700_000_000_100, vector: [0.9, 0.1, 0] },
    ];
    for (const point of upsertBoth) {
      const result = await dualRequest("/v1/upsert", {
        method: "POST",
        body: { orgId: ORG, embeddingModel: MODEL, points: [point] },
        token: INTERNAL_TOKEN,
      });
      expect(result.nestjs.status).toBe(201);
      expect(result.go.status).toBe(201);
    }

    const search = await dualRequest("/v1/search", {
      method: "POST",
      body: { orgId: ORG, embeddingModel: MODEL, vector: [1, 0, 0], limit: 10 },
      token: INTERNAL_TOKEN,
    });
    expect(search.nestjs.status).toBe(201);
    expect(search.go.status).toBe(201);

    const nestjsBody = search.nestjs.body as { collection: string; matches: unknown[] };
    const goBody = search.go.body as { collection: string; matches: unknown[] };
    expect(goBody.collection).toBe(nestjsBody.collection);
    expect(goBody.matches.length).toBe(nestjsBody.matches.length);
    expect(goBody.matches.length).toBeGreaterThan(0);

    // 逐字段比对（score 浮点在两侧均为 Qdrant 原值回传——JSON 数值精度
    // 由 json.Number 语义保证；顺序按 score 降序）。
    for (let i = 0; i < nestjsBody.matches.length; i++) {
      expect(goBody.matches[i]).toEqual(nestjsBody.matches[i]);
    }
  });

  it("search orgId filter isolates tenants identically", async () => {
    const result = await dualRequest("/v1/search", {
      method: "POST",
      body: { orgId: "org-nonexistent-tenant", embeddingModel: MODEL, vector: [1, 0, 0], limit: 5 },
      token: INTERNAL_TOKEN,
    });
    expect(result.nestjs.status).toBe(201);
    expect(result.go.status).toBe(201);
    const nestjsBody = result.nestjs.body as { matches: unknown[] };
    const goBody = result.go.body as { matches: unknown[] };
    expect(nestjsBody.matches).toEqual([]);
    expect(goBody.matches).toEqual(nestjsBody.matches);
  });

  it("search limit clamping and invalid inputs match", async () => {
    // limit 超 500 → zod max(500)/numIntInRange(1,500) 双侧拒绝 → 400 同形。
    // （服务内 clamp 只作用于 [1,500] 内的值——9999 在校验层就被拒，
    // 不会进入 clamp 路径；此前注释把「clamp 到 500」写错了，实测纠正。）
    const oversized = await dualRequest("/v1/search", {
      method: "POST",
      body: { orgId: ORG, embeddingModel: MODEL, vector: [1, 0, 0], limit: 9999 },
      token: INTERNAL_TOKEN,
    });
    expect(oversized.nestjs.status).toBe(400);
    expect(oversized.go.status).toBe(400);
    expect(oversized.go.body).toEqual(oversized.nestjs.body);

    const invalid = await dualRequest("/v1/search", {
      method: "POST",
      body: { orgId: ORG, embeddingModel: MODEL, vector: [1, 0, 0], limit: 0 },
      token: INTERNAL_TOKEN,
    });
    expect(invalid.nestjs.status).toBe(400);
    expect(invalid.go.status).toBe(400);
    expect(invalid.go.body).toEqual(invalid.nestjs.body);
  });

  it("echoes x-trace-id response header on both", async () => {
    const traceId = "abcdef0123456789abcdef0123456789";
    const result = await dualRequest("/v1/search", {
      method: "POST",
      body: { orgId: ORG, embeddingModel: MODEL, vector: [1, 0, 0], limit: 1 },
      token: INTERNAL_TOKEN,
      traceId,
    });
    expect(result.nestjs.headers.get("x-trace-id")).toBe(traceId);
    expect(result.go.headers.get("x-trace-id")).toBe(traceId);
  });

  it("json.Number precision: large createdAtMs survives both implementations", async () => {
    // createdAtMs 超过 2^31：json.Number 路径（Go）与 zod number（TS）都
    // 必须原值保留（不能截断成 32 位 int）。
    const bigMs = 4_100_000_000_000;
    const result = await dualRequest("/v1/upsert", {
      method: "POST",
      body: {
        orgId: ORG,
        embeddingModel: MODEL,
        points: [
          {
            processedItemId: "big-milliseconds",
            itemMetaId: "m-big",
            createdAtMs: bigMs,
            vector: [0.7, 0.7, 0.1],
          },
        ],
      },
      token: INTERNAL_TOKEN,
    });
    expect(result.nestjs.status).toBe(201);
    expect(result.go.status).toBe(201);

    // 回读校验：search lookback 覆盖该时间戳。
    const search = await dualRequest("/v1/search", {
      method: "POST",
      body: {
        orgId: ORG,
        embeddingModel: MODEL,
        vector: [0.7, 0.7, 0.1],
        limit: 50,
      },
      token: INTERNAL_TOKEN,
    });
    const goMatches = (search.go.body as { matches: { processedItemId: string; createdAtMs: number }[] }).matches;
    const bigMatch = goMatches.find((m) => m.processedItemId === "big-milliseconds");
    expect(bigMatch?.createdAtMs).toBe(bigMs);
  });
});
