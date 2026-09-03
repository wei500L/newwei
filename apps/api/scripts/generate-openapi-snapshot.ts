// OpenAPI 形契约快照生成（任务 C / 本轮收口：能力边界修正）。
//
// 本快照是「REST 路由/鉴权契约快照」（OpenAPI 3.0 形状），**不是完整的
// OpenAPI 契约**——info.completeness 如实登记能力边界：
//   - 覆盖：路由、方法、路径参数、鉴权语义（security + x-permissions 等
//     扩展）、响应头（@Header）、默认状态码语义（POST=201 其余=200 +
//     显式 @HttpCode 覆盖）；
//   - 不覆盖：请求体字段模型（DTO 只到 $ref 名称，无 components.schemas
//     定义——标记 x-unresolved-schema）、响应字段模型（标记
//     x-response-schema="unresolved"）、错误体字段模型（形状由契约清单
//     §5 文字锚定）、@All 多方法 handler（跳过并计数）。
//
// 从 tools/scan-routes 的静态扫描结果确定性生成（不启动 Nest 应用、
// 不连数据库）；paths 按 (path, method) 字典序，无时间戳/绝对路径。
// 快照写入 tests/contract/openapi.snapshot.json；CI 用 git diff --exit-code
// 检测漂移；有意变更时由远端再生成（contract-regen label）或运行
// `pnpm --filter @modular/api run contract:openapi:snapshot` 并提交。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scanControllers, type EndpointInfo } from "../tools/scan-routes";

const API_ROOT = join(__dirname, "..");
const SNAPSHOT_PATH = join(API_ROOT, "tests/contract/openapi.snapshot.json");

function openApiMethod(method: string): string | null {
  const lower = method.toLowerCase();
  if (["get", "post", "put", "delete", "patch", "options", "head"].includes(lower)) {
    return lower;
  }
  return null; // ALL（多方法）与 UNKNOWN 不进 OpenAPI path item，矩阵仍覆盖。
}

// Nest 默认状态码语义（express adapter）：POST → 201，其余 → 200；
// @Sse → 200；显式 @HttpCode 覆盖一切。远端差分已实测确认 vector 的
// POST 端点返回 201（run 33743840248）——此处与运行时语义对齐。
function successStatus(endpoint: EndpointInfo): number {
  if (endpoint.httpCode !== null) {
    return endpoint.httpCode;
  }
  if (endpoint.isSse) {
    return 200;
  }
  if (endpoint.method === "POST") {
    return 201;
  }
  return 200;
}

function securityFor(endpoint: EndpointInfo): { bearerAuth: string[] } | undefined {
  if (endpoint.auth.isPublic) {
    return undefined;
  }
  // 非公开端点在真实栈里一律先过 JwtAuthGuard（机器令牌同通道）。
  return { bearerAuth: [] };
}

function buildOperation(endpoint: EndpointInfo): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    tags: [endpoint.controller],
    operationId: `${endpoint.controller}_${endpoint.handler}`,
    "x-handler": `${endpoint.source}#${endpoint.handler}`,
  };
  if (Object.keys(endpoint.headers).length > 0) {
    operation["x-response-headers"] = endpoint.headers;
  }

  const security = securityFor(endpoint);
  if (security) {
    operation.security = [security];
  }
  if (endpoint.auth.isPublic) {
    operation["x-public"] = true;
  }
  if (endpoint.auth.allowAuthenticated) {
    operation["x-allow-authenticated"] = true;
  }
  if (endpoint.auth.permissions.length > 0) {
    operation["x-permissions"] = endpoint.auth.permissions;
    operation["x-permissions-mode"] = endpoint.auth.permissionsMode;
  }
  if (endpoint.auth.guards.length > 0) {
    operation["x-guards"] = endpoint.auth.guards;
  }
  if (endpoint.auth.platformAdminInHandler) {
    operation["x-platform-admin"] = "handler-check";
    operation["x-platform-admin-source"] = "handler-text-scan";
  }
  if (endpoint.isSse) {
    operation["x-sse"] = true;
  }
  if (endpoint.httpCode !== null) {
    operation["x-http-code-explicit"] = endpoint.httpCode;
  }

  const parameters: Record<string, unknown>[] = [];
  for (const name of endpoint.pathParams) {
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  for (const param of endpoint.routeParams) {
    if (param.kind === "param" && param.name) {
      parameters.push({
        name: param.name,
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    } else if (param.kind === "query") {
      parameters.push({
        name: param.name ?? "query",
        in: "query",
        required: false,
        schema: param.typeName
          ? {
              "$ref": `#/components/schemas/${param.typeName}`,
              "x-unresolved-schema": true,
            }
          : { type: "string" },
      });
    }
  }
  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  const bodyParam = endpoint.routeParams.find((p) => p.kind === "body");
  if (bodyParam) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          // DTO 只有类名——components.schemas 无对应定义（字段模型未提取），
          // x-unresolved-schema 如实标注，不虚构 schema。
          schema: bodyParam.typeName
            ? {
                "$ref": `#/components/schemas/${bodyParam.typeName}`,
                "x-unresolved-schema": true,
              }
            : { type: "object", "x-unresolved-schema": true },
        },
      },
    };
  }

  // 成功状态码按 Nest 默认语义 + @HttpCode；响应体字段模型未提取。
  const successCode = successStatus(endpoint);
  const responses: Record<string, unknown> = {
    [String(successCode)]: {
      description: "Success",
      "x-response-schema": "unresolved",
    },
  };
  if (!endpoint.auth.isPublic) {
    responses["401"] = {
      description: "Unauthorized (JWT missing/invalid)",
      "x-response-schema": "unresolved",
    };
    responses["403"] = {
      description: "Forbidden (fail-closed permission guard)",
      "x-response-schema": "unresolved",
    };
  }
  operation.responses = responses;

  return operation;
}

function main(): void {
  const scan = scanControllers({ apiRoot: API_ROOT });
  if (scan.errors.length > 0) {
    console.error("scan errors:", scan.errors);
    process.exit(1);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  let skippedAll = 0;
  for (const endpoint of scan.endpoints) {
    const method = openApiMethod(endpoint.method);
    if (!method) {
      skippedAll += 1;
      continue;
    }
    const pathItem = (paths[endpoint.path] ??= {});
    // 同一路径同方法多个 handler（重载/同形路由）——保留字典序首个并记录到
    // x-duplicate-handlers，避免静默吞掉路由冲突。
    if (pathItem[method]) {
      const existing = pathItem[method] as Record<string, unknown>;
      const dupes = existing["x-duplicate-handlers"] as string[] | undefined;
      existing["x-duplicate-handlers"] = [
        ...(dupes ?? [String(existing.operationId)]),
        `${endpoint.controller}_${endpoint.handler}`,
      ].sort();
      continue;
    }
    pathItem[method] = buildOperation(endpoint);
  }

  const document = {
    // 版本字段是 OpenAPI 规范必填；固定为 3.0.3（规范版本，非应用版本——
    // 应用版本会随每次发版变化，破坏确定性）。
    openapi: "3.0.3",
    info: {
      title: "REST route/auth contract snapshot (OpenAPI-shaped)",
      description:
        "Deterministic REST route/auth contract baseline generated from NestJS controller decorator metadata by apps/api/scripts/generate-openapi-snapshot.ts. This is NOT a full OpenAPI contract: see info.completeness for exact coverage. Response/error field models are not extracted; their shapes are anchored by docs/refactor/api-contract-inventory.md §5.",
      // 固定版本：快照漂移检查比对的是结构，不是应用版本号。
      version: "0.0.0-contract-snapshot",
      // 能力边界（诚实登记，勿夸大）：
      completeness: {
        routes: "complete — every scanned controller route is present",
        methods: "complete",
        pathParams: "complete",
        authMetadata:
          "complete — security + x-public/x-allow-authenticated/x-permissions/x-guards/x-platform-admin",
        statusCodes:
          "defaults extracted — POST=201 (Nest default, verified by remote diff), others=200, explicit @HttpCode overrides via x-http-code-explicit",
        responseSchemas: "unresolved — success response field models are NOT extracted",
        requestSchemas:
          "names-only — DTO $ref targets have no components.schemas definitions (marked x-unresolved-schema)",
        errorSchemas: "unresolved — error field models anchored textually in api-contract-inventory.md §5",
        allMethodHandlers: "skipped — multi-method @All handlers are not in path items (counted in x-scan-meta)",
      },
    },
    servers: [{ url: "/", description: "relative (deployment-agnostic)" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      // 有意不声明 schemas：DTO 字段模型未提取，声明空对象反而冒充完整性。
    },
    paths,
    "x-scan-meta": {
      controllerCount: scan.controllerCount,
      endpointCount: scan.endpoints.length,
      openApiPathCount: Object.keys(paths).length,
      skippedMultiMethodHandlers: skippedAll,
      globalPrefix: "api",
      excludedFromGlobalPrefix: "admin/queues*",
    },
  };

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(
    `openapi snapshot: ${scan.endpoints.length} endpoints → ${SNAPSHOT_PATH} (${Object.keys(paths).length} paths, ${skippedAll} non-OpenAPI-method handlers skipped)`,
  );
}

main();
