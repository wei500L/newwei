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
  it("auth-matrix baseline covers the full controller surface with no dead routes", () => {
    const matrix = JSON.parse(
      readFileSync(join(process.cwd(), "tests/contract/auth-matrix.json"), "utf8"),
    ) as {
      totals: { controllers: number; endpoints: number; public: number };
      rows: { route: string; anonymous: string; permission: string[] }[];
    };
    expect(matrix.totals.controllers).toBeGreaterThanOrEqual(70);
    expect(matrix.totals.endpoints).toBeGreaterThanOrEqual(360);
    expect(matrix.totals.public).toBeGreaterThanOrEqual(20);

    // API-01 修复后全库 0 死路由；矩阵生成时 fail-closed 的结果被提交。
    // （permission 为空但 authenticated=allowed 的行是 @AllowAuthenticated
    // 端点——仅 JWT 无权限要求，不是死路由。）
    const dead = matrix.rows.filter(
      (r) => r.anonymous === "denied" && r.authenticated === "denied" && r.permission.length === 0,
    );
    expect(dead).toEqual([]);

    // 关键语义锚点：onboarding 的权限元数据（API-01）。
    const onboarding = matrix.rows.find(
      (r) => r.route === "/api/user-settings/ui/onboarding",
    );
    expect(onboarding?.permission).toEqual(["items.read"]);

    // SEC-01：vector 服务变更面标注平台管理员。
    const vectorPut = matrix.rows.find(
      (r) =>
        r.route === "/api/system-settings/vector-service" &&
        r.method === "PUT",
    );
    expect(vectorPut?.riskNotes).toContain("platform-admin");
  });

  it("openapi snapshot baseline covers 290+ paths deterministically", () => {
    const snapshot = JSON.parse(
      readFileSync(join(process.cwd(), "tests/contract/openapi.snapshot.json"), "utf8"),
    ) as {
      openapi: string;
      paths: Record<string, unknown>;
      "x-scan-meta": { endpointCount: number; controllerCount: number };
    };
    expect(Object.keys(snapshot.paths).length).toBeGreaterThanOrEqual(290);
    expect(snapshot["x-scan-meta"].endpointCount).toBeGreaterThanOrEqual(360);
    expect(snapshot["x-scan-meta"].controllerCount).toBeGreaterThanOrEqual(70);
    // 确定性锚点：版本号固定（非应用版本——那会破坏确定性）。
    expect(snapshot.openapi).toBe("3.0.3");
  });
});
