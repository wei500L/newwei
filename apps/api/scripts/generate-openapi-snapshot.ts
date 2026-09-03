// OpenAPI 契约快照生成（任务 C / roadmap M2 余项 1）。
//
// 从 tools/scan-routes 的静态扫描结果生成确定性的 OpenAPI 3.0 JSON 基线：
//   - 不启动 Nest 应用、不连数据库（SwaggerModule.createDocument 需要完整
//     AppModule，PrismaService.onModuleInit 会 $connect——静态生成绕开它）。
//   - 确定性保证：paths/components 按字典序排序；不含时间戳、版本号、
//     绝对路径、随机 id。
//   - 覆盖面：路径、方法、路径参数、请求体（DTO 类型引用）、鉴权语义
//     （security: bearer / 空）、响应头（@Header 的 Cache-Control 等）、
//     x-permissions / x-platform-admin 扩展字段（鉴权语义进契约）。
//   - 快照写入 tests/contract/openapi.snapshot.json；CI 用
//     `git diff --exit-code` 检测漂移；有意变更时运行
//     `pnpm --filter @modular/api run contract:openapi:snapshot` 重新生成。
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

function securityFor(endpoint: EndpointInfo): { bearerAuth: string[] } | undefined {
  if (endpoint.auth.isPublic) {
    return undefined;
  }
  // 非公开端点在真实栈里一律先过 JwtAuthGuard（机器令牌同通道）。
  return { bearerAuth: [] };
}

function tagFor(endpoint: EndpointInfo): string {
  return endpoint.controller;
}

function buildOperation(endpoint: EndpointInfo): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    // tags 用 controller 类名（大多数 controller 已有 @ApiTags；两者语义一致，
    // 用类名保证确定性且零依赖装饰器文本解析）。
    tags: [tagFor(endpoint)],
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
  }
  if (endpoint.isSse) {
    operation["x-sse"] = true;
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
        schema: param.typeName ? { $ref: `#/components/schemas/${param.typeName}` } : { type: "string" },
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
          schema: bodyParam.typeName
            ? { $ref: `#/components/schemas/${bodyParam.typeName}` }
            : { type: "object" },
        },
      },
    };
  }

  // 契约快照关注路由形状而非具体响应 schema（多数 handler 未标
  // @ApiOkResponse）；状态码以 200 兜底，错误形状由契约清单 §5 锚定。
  operation.responses = {
    "200": { description: "Success" },
  };
  if (!endpoint.auth.isPublic) {
    operation.responses = {
      "200": { description: "Success" },
      "401": { description: "Unauthorized (JWT missing/invalid)" },
      "403": { description: "Forbidden (fail-closed permission guard)" },
    };
  }

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
      title: "Modular Monolith API (contract snapshot)",
      description:
        "Deterministic REST contract baseline generated from NestJS controller decorator metadata by apps/api/scripts/generate-openapi-snapshot.ts. Routes/methods/auth semantics are contractual; response schemas are anchored by docs/refactor/api-contract-inventory.md.",
      // 固定版本：快照漂移检查比对的是结构，不是应用版本号。
      version: "0.0.0-contract-snapshot",
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
