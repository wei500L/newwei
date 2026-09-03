// 鉴权矩阵生成（任务 D / roadmap M2 余项 2）。
//
// 从 tools/scan-routes 的静态扫描结果生成全部 REST 端点的鉴权矩阵：
//   - tests/contract/auth-matrix.json —— 机器可读断言表（Go 迁移与
//     契约保护网的输入，见 go-migration-adr.md §6.2）。
//   - tests/contract/auth-matrix.md —— 人工审查表格（按 controller 分组）。
//
// fail-closed：任何非公开端点缺权限元数据 → 脚本 exit 1（与运行时
// PermissionsGuard 的 PERMISSION_METADATA_MISSING 语义一致）。
// 平台/普通双权限端点显式标注（platformAdminInHandler）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scanControllers, type EndpointInfo } from "../tools/scan-routes";

const API_ROOT = join(__dirname, "..");
const MATRIX_JSON_PATH = join(API_ROOT, "tests/contract/auth-matrix.json");
const MATRIX_MD_PATH = join(API_ROOT, "tests/contract/auth-matrix.md");

interface MatrixRow {
  method: string;
  route: string;
  controller: string;
  handler: string;
  anonymous: "allowed" | "denied";
  authenticated: "allowed" | "denied";
  permission: string[];
  permissionMode: "any" | "all" | null;
  platformOnly: boolean;
  orgContext: "user" | "none" | "handler";
  source: string;
  riskNotes: string;
}

// 四态断言（go-migration-adr §6.2）：匿名 / 无权限 JWT / 有权限 JWT / 错 org。
// org 错配的判定依赖运行时 membership 重推导，静态矩阵记 orgContext 来源。
function classifyAnonymous(endpoint: EndpointInfo): "allowed" | "denied" {
  return endpoint.auth.isPublic ? "allowed" : "denied";
}

function classifyAuthenticated(endpoint: EndpointInfo): "allowed" | "denied" {
  // @Public 不看 JWT；@AllowAuthenticated 只看 JWT；@Permissions 需要权限集。
  if (endpoint.auth.isPublic) {
    return "allowed";
  }
  if (endpoint.auth.allowAuthenticated) {
    return "allowed";
  }
  return endpoint.auth.permissions.length > 0 ? "allowed" : "denied";
}

function orgContextFor(endpoint: EndpointInfo): "user" | "none" | "handler" {
  if (endpoint.auth.isPublic) {
    return "none";
  }
  if (endpoint.auth.allowAuthenticated) {
    return "handler";
  }
  return "user";
}

function riskNotesFor(endpoint: EndpointInfo): string {
  const notes: string[] = [];
  if (!endpoint.auth.isPublic && !endpoint.auth.allowAuthenticated && endpoint.auth.permissions.length === 0) {
    notes.push("NO_PERMISSION_METADATA (fail-closed 403 in runtime)");
  }
  if (endpoint.auth.guards.length > 0) {
    notes.push(`guards: ${endpoint.auth.guards.join(",")}`);
  }
  if (endpoint.auth.platformAdminInHandler) {
    notes.push("platform-admin check in handler body (heuristic)");
  }
  if (endpoint.auth.isPublic && endpoint.auth.guards.length > 0) {
    notes.push("public route with token guard (internal endpoint)");
  }
  return notes.join("; ");
}

function main(): void {
  const scan = scanControllers({ apiRoot: API_ROOT });
  if (scan.errors.length > 0) {
    console.error("scan errors:", scan.errors);
    process.exit(1);
  }

  const rows: MatrixRow[] = scan.endpoints.map((endpoint) => ({
    method: endpoint.method,
    route: endpoint.path,
    controller: endpoint.controller,
    handler: endpoint.handler,
    anonymous: classifyAnonymous(endpoint),
    authenticated: classifyAuthenticated(endpoint),
    permission: endpoint.auth.permissions,
    permissionMode: endpoint.auth.permissionsMode,
    platformOnly: endpoint.auth.platformAdminInHandler,
    orgContext: orgContextFor(endpoint),
    source: endpoint.source,
    riskNotes: riskNotesFor(endpoint),
  }));

  // fail-closed 校验：存在缺元数据的端点 → 生成失败（快照不许带死路由）。
  const missing = rows.filter(
    (row) =>
      row.anonymous === "denied" &&
      row.authenticated === "denied" &&
      row.permission.length === 0,
  );
  if (missing.length > 0) {
    console.error(
      `auth-matrix: ${missing.length} endpoints have no permission metadata (fail-closed):`,
    );
    for (const row of missing) {
      console.error(`  ${row.method} ${row.route} (${row.source}#${row.handler})`);
    }
    process.exit(1);
  }

  const json = {
    // 矩阵的生成语义与 scan-routes 保持一致；行按 (route, method) 排序。
    generatedBy: "apps/api/tools/generate-auth-matrix.ts (static decorator metadata scan)",
    failClosedRule:
      "any non-public endpoint without @Permissions/@AllowAuthenticated fails generation (mirrors runtime PermissionsGuard)",
    totals: {
      controllers: scan.controllerCount,
      endpoints: rows.length,
      public: rows.filter((r) => r.anonymous === "allowed").length,
      allowAuthenticated: rows.filter((r) => r.orgContext === "handler").length,
      permissionGated: rows.filter((r) => r.permission.length > 0).length,
      platformAdminInHandler: rows.filter((r) => r.platformOnly).length,
      internalTokenGuarded: rows.filter((r) => r.riskNotes.includes("guards:")).length,
    },
    rows,
  };

  mkdirSync(dirname(MATRIX_JSON_PATH), { recursive: true });
  writeFileSync(MATRIX_JSON_PATH, `${JSON.stringify(json, null, 2)}\n`, "utf8");

  // Markdown 表格按 controller 分组，便于人工审查。
  const byController = new Map<string, MatrixRow[]>();
  for (const row of rows) {
    const list = byController.get(row.controller) ?? [];
    list.push(row);
    byController.set(row.controller, list);
  }
  const controllers = [...byController.keys()].sort();

  const md: string[] = [
    "# 鉴权矩阵（Auth Matrix · 自动生成）",
    "",
    "> 由 `apps/api/tools/generate-auth-matrix.ts` 从控制器装饰器元数据静态生成，",
    "> 勿手改——重新生成：`pnpm --filter @modular/api run contract:auth-matrix:generate`。",
    "> 生成时 fail-closed：任何非公开端点缺权限元数据都会失败（与运行时 PermissionsGuard 一致）。",
    "",
    `总计：${scan.controllerCount} controller / ${rows.length} endpoint · 公开 ${json.totals.public} · 仅认证 ${json.totals.allowAuthenticated} · 权限门控 ${json.totals.permissionGated} · handler 内平台校验 ${json.totals.platformAdminInHandler}`,
    "",
    "| Method | Route | Handler | Anonymous | Authenticated | Permission | Platform-only | Org ctx | Risk/Notes |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const controller of controllers) {
    for (const row of byController.get(controller) ?? []) {
      md.push(
        `| ${row.method} | \`${row.route}\` | ${row.handler} | ${row.anonymous} | ${row.authenticated} | ${
          row.permission.length > 0
            ? `${row.permission.join(",")}${row.permissionMode === "all" ? " (ALL)" : ""}`
            : "—"
        } | ${row.platformOnly ? "yes" : "—"} | ${row.orgContext} | ${row.riskNotes || "—"} |`,
      );
    }
  }
  md.push("");
  md.push("<!-- source anchor: every row carries source in the JSON artifact -->");
  md.push("");

  writeFileSync(MATRIX_MD_PATH, md.join("\n"), "utf8");

  console.log(
    `auth-matrix: ${rows.length} endpoints (${json.totals.public} public, ${json.totals.platformAdminInHandler} platform-admin-in-handler) → ${MATRIX_JSON_PATH}`,
  );
}

main();
