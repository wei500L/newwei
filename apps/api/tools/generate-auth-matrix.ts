// 鉴权矩阵生成（任务 D / 本轮收口：四态语义修正）。
//
// 从 tools/scan-routes 的静态扫描结果生成全部 REST 端点的鉴权矩阵：
//   - tests/contract/auth-matrix.json —— 机器可读断言表（Go 迁移与
//     契约保护网的输入，见 go-migration-adr.md §6.2）。
//   - tests/contract/auth-matrix.md —— 人工审查表格（按 controller 分组）。
//
// 四态语义（ADR §6.2）：匿名 / 无权限 JWT / 有权限 JWT / 错 org——
// 其中「错 org」依赖运行时 membership 重推导，静态不可证明，一律标注
// runtime-required，不编造 allowed/denied。
//
// fail-closed：任何非公开端点缺权限元数据 → 脚本 exit 1（与运行时
// PermissionsGuard 的 PERMISSION_METADATA_MISSING 语义一致）。
//
// 置信度（confidence）：
//   - static          —— 结论完全来自装饰器元数据（与运行时 Guard 语义
//                         一一对应，可作为强契约）；
//   - static+heuristic —— 行内含 handler 源码文本扫描的启发式结论
//                         （platformCheckSource=handler-text-scan），它
//                         提示运行时行为但不是静态保障——运行时强制力
//                         依赖 handler 内的 assertPlatformAdmin 调用真实
//                         存在且可达，需运行时测试锚定（见
//                         vector-service-settings.controller.test.ts）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scanControllers, type EndpointInfo } from "../tools/scan-routes";

const API_ROOT = join(__dirname, "..");
const MATRIX_JSON_PATH = join(API_ROOT, "tests/contract/auth-matrix.json");
const MATRIX_MD_PATH = join(API_ROOT, "tests/contract/auth-matrix.md");

type Access = "allowed" | "denied";
type AccessOrNA = Access | "n/a";
type AccessOrRuntime = Access | "runtime-required" | "n/a";

interface MatrixRow {
  method: string;
  route: string;
  controller: string;
  handler: string;
  /** 匿名（无凭证）——@Public 静态可判定。 */
  anonymous: Access;
  /** 已登录但无对应业务权限——@Permissions 端点必 denied（Guard 语义）。 */
  authenticatedWithoutPermission: AccessOrNA;
  /** 已登录且持有 @Permissions 声明的全部/任一权限——静态可判定。 */
  authenticatedWithPermission: AccessOrNA;
  /** 错 org 的已登录用户——依赖运行时 membership 重推导，静态一律 runtime-required。 */
  wrongOrg: AccessOrRuntime;
  permission: string[];
  permissionMode: "any" | "all" | null;
  /** 普通 org 管理员（有 settings.manage 等组织权限、无平台角色）。 */
  ordinaryOrgAdmin: AccessOrRuntime;
  /** 平台管理员（globalRoleAssignment.platform_admin）。 */
  platformAdmin: AccessOrRuntime;
  /** handler 体内存在平台管理员校验（启发式，见 platformCheckSource）。 */
  platformOnly: boolean;
  platformCheckSource: "handler-text-scan" | null;
  /** 该行需要运行时验证的方面（不编造静态结论）。 */
  runtimeVerificationRequired: string[];
  confidence: "static" | "static+heuristic";
  source: string;
  riskNotes: string;
}

// 四态推导。静态结论只来自装饰器元数据；handler 源码文本扫描的结论
// 单独标注（confidence=static+heuristic）。
function buildRow(endpoint: EndpointInfo): MatrixRow {
  const { auth } = endpoint;
  const isPublic = auth.isPublic;
  const isAllowAuthenticated = auth.allowAuthenticated;
  const hasPermissions = auth.permissions.length > 0;
  const handlerPlatformCheck = auth.platformAdminInHandler;

  const anonymous: Access = isPublic ? "allowed" : "denied";

  // 无权限 JWT / 有权限 JWT（Guard 语义的静态镜像）。
  let authenticatedWithoutPermission: AccessOrNA;
  let authenticatedWithPermission: AccessOrNA;
  if (isPublic) {
    authenticatedWithoutPermission = "n/a";
    authenticatedWithPermission = "n/a";
  } else if (isAllowAuthenticated) {
    authenticatedWithoutPermission = "allowed";
    authenticatedWithPermission = "n/a";
  } else if (hasPermissions) {
    authenticatedWithoutPermission = "denied";
    authenticatedWithPermission = "allowed";
  } else {
    // fail-closed：无元数据 → 403 PERMISSION_METADATA_MISSING。
    authenticatedWithoutPermission = "denied";
    authenticatedWithPermission = "denied";
  }

  // 错 org：membership 重推导是运行时行为——静态不判定，诚实标注。
  const wrongOrg: AccessOrRuntime = isPublic ? "n/a" : "runtime-required";

  // 两个管理员画像。带 handler 平台校验的端点（SEC-01 模式）：
  //   普通 org 管理员 → denied、平台管理员 → allowed——这是启发式结论
  //   （运行时强制力来自 handler 内 assertPlatformAdmin）。
  // 其余端点的管理员访问取决于 DB 中的角色→权限数据 → runtime-required。
  let ordinaryOrgAdmin: AccessOrRuntime;
  let platformAdmin: AccessOrRuntime;
  if (isPublic) {
    ordinaryOrgAdmin = "allowed";
    platformAdmin = "allowed";
  } else if (handlerPlatformCheck) {
    ordinaryOrgAdmin = "denied";
    platformAdmin = "allowed";
  } else if (isAllowAuthenticated) {
    ordinaryOrgAdmin = "allowed";
    platformAdmin = "allowed";
  } else {
    ordinaryOrgAdmin = "runtime-required";
    platformAdmin = "runtime-required";
  }

  const runtimeVerificationRequired: string[] = [];
  if (!isPublic) {
    runtimeVerificationRequired.push("wrong-org-membership");
  }
  if (handlerPlatformCheck) {
    runtimeVerificationRequired.push("platform-admin-gate");
  }
  if (auth.guards.length > 0 && isPublic) {
    runtimeVerificationRequired.push("internal-token-guard");
  }

  const riskNotes: string[] = [];
  if (!isPublic && !isAllowAuthenticated && !hasPermissions) {
    riskNotes.push("NO_PERMISSION_METADATA (fail-closed 403 in runtime)");
  }
  if (auth.guards.length > 0) {
    riskNotes.push(`guards: ${auth.guards.join(",")}`);
  }
  if (handlerPlatformCheck) {
    riskNotes.push("platform-admin check in handler body (heuristic)");
  }
  if (isPublic && auth.guards.length > 0) {
    riskNotes.push("public route with token guard (internal endpoint)");
  }

  return {
    method: endpoint.method,
    route: endpoint.path,
    controller: endpoint.controller,
    handler: endpoint.handler,
    anonymous,
    authenticatedWithoutPermission,
    authenticatedWithPermission,
    wrongOrg,
    permission: auth.permissions,
    permissionMode: auth.permissionsMode,
    ordinaryOrgAdmin,
    platformAdmin,
    platformOnly: handlerPlatformCheck,
    platformCheckSource: handlerPlatformCheck ? "handler-text-scan" : null,
    runtimeVerificationRequired,
    confidence: handlerPlatformCheck ? "static+heuristic" : "static",
    source: endpoint.source,
    riskNotes: riskNotes.join("; "),
  };
}

function main(): void {
  const scan = scanControllers({ apiRoot: API_ROOT });
  if (scan.errors.length > 0) {
    console.error("scan errors:", scan.errors);
    process.exit(1);
  }

  const rows = scan.endpoints.map(buildRow);

  // fail-closed 校验：存在缺元数据的端点 → 生成失败（快照不许带死路由）。
  const missing = rows.filter(
    (row) =>
      row.anonymous === "denied" &&
      row.authenticatedWithoutPermission === "denied" &&
      row.authenticatedWithPermission === "denied" &&
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
    generatedBy: "apps/api/tools/generate-auth-matrix.ts (static decorator metadata scan)",
    semantics: {
      anonymous: "decorator-decidable (@Public)",
      authenticatedWithoutPermission:
        "decorator-decidable (PermissionsGuard: @Permissions denies without permission; @AllowAuthenticated allows)",
      authenticatedWithPermission: "decorator-decidable (PermissionsGuard passes when permission held)",
      wrongOrg:
        "runtime-required — org context is re-derived from DB membership per request; static scan cannot prove it",
      ordinaryOrgAdmin:
        "handler-platform-check endpoints: denied (heuristic); otherwise runtime-required (role→permission data lives in DB)",
      platformAdmin:
        "handler-platform-check endpoints: allowed (heuristic); otherwise runtime-required",
      platformCheckSource:
        "handler-text-scan — regex over handler source; runtime enforcement depends on the real assertPlatformAdmin call (anchored by controller unit tests)",
    },
    failClosedRule:
      "any non-public endpoint without @Permissions/@AllowAuthenticated fails generation (mirrors runtime PermissionsGuard)",
    totals: {
      controllers: scan.controllerCount,
      endpoints: rows.length,
      public: rows.filter((r) => r.anonymous === "allowed").length,
      allowAuthenticated: rows.filter(
        (r) => r.authenticatedWithoutPermission === "allowed" && r.anonymous === "denied",
      ).length,
      permissionGated: rows.filter((r) => r.permission.length > 0).length,
      permissionGatedDenyWithoutPermission: rows.filter(
        (r) => r.authenticatedWithoutPermission === "denied" && r.permission.length > 0,
      ).length,
      platformAdminInHandler: rows.filter((r) => r.platformOnly).length,
      internalTokenGuarded: rows.filter((r) => r.riskNotes.includes("guards:")).length,
      wrongOrgRuntimeRequired: rows.filter((r) => r.wrongOrg === "runtime-required").length,
      heuristicRows: rows.filter((r) => r.confidence === "static+heuristic").length,
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
    "**四态语义**（ADR §6.2）：anonymous / auth-no-permission / auth-with-permission 为装饰器可判定；",
    "**wrongOrg 一律 runtime-required**（org 上下文由每请求 DB membership 重推导，静态不编造结论）。",
    "**handler 平台校验是启发式**（platformCheckSource=handler-text-scan）：提示运行时行为，",
    "不是静态保障——运行时强制力由 handler 内 assertPlatformAdmin 提供并以控制器单测锚定。",
    "",
    `总计：${scan.controllerCount} controller / ${rows.length} endpoint · 公开 ${json.totals.public} · 仅认证 ${json.totals.allowAuthenticated} · 权限门控 ${json.totals.permissionGated}（无权限必 403：${json.totals.permissionGatedDenyWithoutPermission}）· handler 平台校验（启发式）${json.totals.platformAdminInHandler} · wrongOrg 需运行时验证 ${json.totals.wrongOrgRuntimeRequired}`,
    "",
    "| Method | Route | Handler | Anon | No-perm JWT | With-perm JWT | Wrong-org | Permission | Platform-only | OrgAdmin | PlatformAdmin | CheckSrc | Runtime-needed | Conf | Notes |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const controller of controllers) {
    for (const row of byController.get(controller) ?? []) {
      md.push(
        `| ${row.method} | \`${row.route}\` | ${row.handler} | ${row.anonymous} | ${
          row.authenticatedWithoutPermission
        } | ${row.authenticatedWithPermission} | ${row.wrongOrg} | ${
          row.permission.length > 0
            ? `${row.permission.join(",")}${row.permissionMode === "all" ? " (ALL)" : ""}`
            : "—"
        } | ${row.platformOnly ? "yes" : "—"} | ${row.ordinaryOrgAdmin} | ${row.platformAdmin} | ${
          row.platformCheckSource ?? "—"
        } | ${row.runtimeVerificationRequired.join(",") || "—"} | ${row.confidence} | ${row.riskNotes || "—"} |`,
      );
    }
  }
  md.push("");
  md.push("<!-- source anchor: every row carries source in the JSON artifact -->");
  md.push("");

  writeFileSync(MATRIX_MD_PATH, md.join("\n"), "utf8");

  console.log(
    `auth-matrix: ${rows.length} endpoints (${json.totals.public} public, ${json.totals.platformAdminInHandler} platform-admin-in-handler[heuristic], ${json.totals.wrongOrgRuntimeRequired} wrongOrg=runtime-required) → ${MATRIX_JSON_PATH}`,
  );
}

main();
