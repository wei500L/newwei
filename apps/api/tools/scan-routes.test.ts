import { Controller, Get, Param, Put, Header } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Permissions } from "../src/common/decorators/permissions.decorator";
import { Public } from "../src/common/decorators/public.decorator";

import { endpointsFromController } from "./scan-routes";

// 测试策略：
//   1. 元数据语义（内联装饰器控制器 + endpointsFromController）——vitest
//      对本文件的 esbuild 转换带 tsconfigRaw 装饰器配置，装饰器元数据
//      完整保留，直接锚定扫描器的读取逻辑（path/method/public/
//      permissions/headers/pathParams/routeParams/fail-closed 暴露）。
//   2. 全量完整性（提交的契约基线 artifacts）——真实控制器全量加载在
//      CI 用独立步骤验证（tsx 运行生成器 + 与基线逐字节比对），这里
//      断言基线内容（controller/endpoint 数量、死路由为零、关键语义）。
//
// 为什么不全量扫描也在 vitest 内做：vitest 进程内 require TS 控制器源
// 经过的转换链路与 tsx 运行时不同，装饰器元数据丢失（实测 0 controller
// —— CI run 33743071867）。生成器脚本（tsx）与矩阵漂移检查（独立 CI
// 步骤）已覆盖真实加载路径。

@Controller("fixture")
class FixtureController {
  @Get("live")
  @Public()
  live() {
    return { ok: true };
  }

  @Get("items/:id")
  detail(@Param("id") id: string) {
    return { id };
  }

  @Put("settings")
  @Header("Cache-Control", "no-store")
  @Permissions("items.read")
  update() {
    return {};
  }

  // 无路由装饰器的方法：不进端点清单。
  helper() {
    return {};
  }
}

@Controller("fixture-missing")
class MissingMetaController {
  @Get("dead")
  dead() {
    return {};
  }
}

const OPTIONS = {
  name: "FixtureController",
  classPath: "/virtual/fixture.controller.ts",
  basePath: "fixture",
  apiRoot: "/virtual",
  globalPrefix: "api",
};

describe("endpointsFromController (decorator metadata semantics)", () => {
  const endpoints = endpointsFromController(FixtureController, OPTIONS);

  it("collects only route-decorated handlers", () => {
    expect(endpoints.map((e) => e.handler).sort()).toEqual([
      "detail",
      "live",
      "update",
    ]);
  });

  it("reads path, method, and applies the /api global prefix", () => {
    const live = endpoints.find((e) => e.handler === "live");
    expect(live?.method).toBe("GET");
    expect(live?.path).toBe("/api/fixture/live");

    const update = endpoints.find((e) => e.handler === "update");
    expect(update?.method).toBe("PUT");
    expect(update?.path).toBe("/api/fixture/settings");
  });

  it("marks @Public handlers as public", () => {
    const live = endpoints.find((e) => e.handler === "live");
    expect(live?.auth.isPublic).toBe(true);
    expect(live?.auth.allowAuthenticated).toBe(false);
  });

  it("reads @Permissions with any mode", () => {
    const update = endpoints.find((e) => e.handler === "update");
    expect(update?.auth.isPublic).toBe(false);
    expect(update?.auth.permissions).toEqual(["items.read"]);
    expect(update?.auth.permissionsMode).toBe("any");
  });

  it("reads @Header response headers", () => {
    const update = endpoints.find((e) => e.handler === "update");
    expect(update?.headers["Cache-Control"]).toBe("no-store");
  });

  it("extracts path params from the route and @Param metadata", () => {
    const detail = endpoints.find((e) => e.handler === "detail");
    expect(detail?.path).toBe("/api/fixture/items/:id");
    expect(detail?.pathParams).toEqual(["id"]);
    expect(
      detail?.routeParams.some((p) => p.kind === "param" && p.name === "id"),
    ).toBe(true);
  });

  it("exposes missing permission metadata verbatim (fail-closed input for the matrix generator)", () => {
    const dead = endpointsFromController(MissingMetaController, {
      ...OPTIONS,
      name: "MissingMetaController",
      basePath: "fixture-missing",
    });
    expect(dead).toHaveLength(1);
    expect(dead[0].auth.isPublic).toBe(false);
    expect(dead[0].auth.allowAuthenticated).toBe(false);
    expect(dead[0].auth.permissions).toEqual([]);
    // 该形状进入 generate-auth-matrix 后触发 fail-closed（exit 1）。
  });
});

// ---- 全量完整性：提交的契约基线（CI 独立步骤重新生成并逐字节比对）----
describe("contract baseline artifacts", () => {
  interface MatrixRowShape {
    method: string;
    route: string;
    anonymous: string;
    authenticatedWithoutPermission: string;
    authenticatedWithPermission: string;
    wrongOrg: string;
    permission: string[];
    ordinaryOrgAdmin: string;
    platformAdmin: string;
    platformOnly: boolean;
    platformCheckSource: string | null;
    runtimeVerificationRequired: string[];
    confidence: string;
    riskNotes: string;
  }

  function loadMatrix(): {
    totals: Record<string, number>;
    rows: MatrixRowShape[];
  } {
    return JSON.parse(
      readFileSync(join(process.cwd(), "tests/contract/auth-matrix.json"), "utf8"),
    );
  }

  it("auth-matrix baseline covers the full controller surface with no dead routes", () => {
    const matrix = loadMatrix();
    expect(matrix.totals.controllers).toBeGreaterThanOrEqual(70);
    expect(matrix.totals.endpoints).toBeGreaterThanOrEqual(360);
    expect(matrix.totals.public).toBeGreaterThanOrEqual(20);

    // API-01 修复后全库 0 死路由；矩阵生成时 fail-closed 的结果被提交。
    const dead = matrix.rows.filter(
      (r) =>
        r.anonymous === "denied" &&
        r.authenticatedWithoutPermission === "denied" &&
        r.authenticatedWithPermission === "denied" &&
        r.permission.length === 0,
    );
    expect(dead).toEqual([]);

    // 关键语义锚点：onboarding 的权限元数据（API-01）——无权限 JWT 必
    // denied，有权限 JWT allowed。
    const onboarding = matrix.rows.find(
      (r) => r.route === "/api/user-settings/ui/onboarding",
    );
    expect(onboarding?.permission).toEqual(["items.read"]);
    expect(onboarding?.authenticatedWithoutPermission).toBe("denied");
    expect(onboarding?.authenticatedWithPermission).toBe("allowed");
    expect(onboarding?.wrongOrg).toBe("runtime-required");
  });

  it("auth-matrix expresses the four-state semantics (SEC-01 row included)", () => {
    const matrix = loadMatrix();

    // SEC-01：vector 服务变更面——普通 org 管理员 denied（启发式）、
    // 平台管理员 allowed（启发式）、平台校验来源显式标注。
    const vectorPut = matrix.rows.find(
      (r) => r.route === "/api/system-settings/vector-service" && r.method === "PUT",
    );
    expect(vectorPut?.riskNotes).toContain("platform-admin");
    expect(vectorPut?.ordinaryOrgAdmin).toBe("denied");
    expect(vectorPut?.platformAdmin).toBe("allowed");
    expect(vectorPut?.platformCheckSource).toBe("handler-text-scan");
    expect(vectorPut?.confidence).toBe("static+heuristic");
    expect(vectorPut?.runtimeVerificationRequired ?? []).toContain("platform-admin-gate");

    // @Permissions 端点的无权限 JWT 必须 denied（不是笼统的 authenticated
    // allowed）——至少 300 个端点表达该区分。
    expect(matrix.totals.permissionGatedDenyWithoutPermission).toBeGreaterThanOrEqual(300);

    // 非 @Public 端点的 wrongOrg 一律 runtime-required（静态不编造）。
    const forgedWrongOrg = matrix.rows.filter(
      (r) => r.anonymous === "denied" && r.wrongOrg !== "runtime-required",
    );
    expect(forgedWrongOrg).toEqual([]);
  });

  it("openapi snapshot baseline covers 290+ paths deterministically", () => {
    const snapshot = JSON.parse(
      readFileSync(join(process.cwd(), "tests/contract/openapi.snapshot.json"), "utf8"),
    ) as {
      openapi: string;
      info: { title: string; completeness: Record<string, string> };
      paths: Record<string, Record<string, Record<string, unknown>>>;
      "x-scan-meta": { endpointCount: number; controllerCount: number };
    };
    expect(Object.keys(snapshot.paths).length).toBeGreaterThanOrEqual(290);
    expect(snapshot["x-scan-meta"].endpointCount).toBeGreaterThanOrEqual(360);
    expect(snapshot["x-scan-meta"].controllerCount).toBeGreaterThanOrEqual(70);
    // 确定性锚点：版本号固定（非应用版本——那会破坏确定性）。
    expect(snapshot.openapi).toBe("3.0.3");
    // 能力边界诚实登记：标题与 completeness 明示这是 route/auth 快照，
    // 不是完整 OpenAPI 契约。
    expect(snapshot.info.title).toContain("REST route/auth contract snapshot");
    expect(snapshot.info.completeness.responseSchemas).toContain("unresolved");
    expect(snapshot.info.completeness.requestSchemas).toContain("names-only");

    // 状态码语义：POST 端点默认 201（Nest @Post 默认，远端差分实测确认）。
    const login = snapshot.paths["/api/auth/login"]?.post as
      | { responses?: Record<string, unknown> }
      | undefined;
    expect(login?.responses).toHaveProperty("201");

    // GraphQL 端点（POST /graphql 在 api 之外挂载）不在 REST 快照 paths 里。
    expect(snapshot.paths["/graphql"]).toBeUndefined();
  });
});
