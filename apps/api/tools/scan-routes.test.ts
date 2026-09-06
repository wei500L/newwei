import {
  Body,
  Controller,
  createParamDecorator,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Permissions } from "../src/common/decorators/permissions.decorator";
import { Public } from "../src/common/decorators/public.decorator";

import { ROUTE_ARGS_METADATA, endpointsFromController } from "./scan-routes";

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

// CI-01 回归锚点：模拟 Nest createParamDecorator 的真实行为——用
// uid(21) 风格的随机十六进制串作 paramtype 键写入 ROUTE_ARGS_METADATA。
// 旧实现的 parseInt 会把 "3a…"（"4a…" / "5a…"）误读成 Body（Query /
// Param）——每次冷进程随机命中约 7% 的自定义参数，造成快照非确定性。
// 这个装饰器在模块加载时生成一个随机键（与真实 @CurrentUser 相同的
// 形状），断言它绝不产生 body/query/param。
const RandomUidParam = createParamDecorator((_data: unknown) => undefined);

@Controller("fixture-custom-param")
class CustomParamController {
  @Post("act")
  act(@RandomUidParam() user: unknown) {
    return { user };
  }
}

// 同名 handler：ParentController 的 getItem 带 @Param("id")，
// ChildController 的同签名方法没有参数装饰器。旧实现用 getMetadata（沿
// 原型链读）会把父类的参数继承给子类——伪造子类端点的参数。
@Controller("fixture-parent")
class ParentController {
  @Get("items/:id")
  getItem(@Param("id") id: string) {
    return { id };
  }
}

@Controller("fixture-child")
class ChildController extends ParentController {
  // 重写同名方法（无参数装饰器）——handler 元数据（method/path）来自
  // 父类，路由仍在；参数必须为空（own metadata 语义）。
  @Get("items/:id")
  getItem(id: string) {
    return { id };
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

  // ---- CI-01 回归：参数元数据非确定性 ----
  describe("CI-01 route parameter determinism", () => {
    it("ignores random-uid paramtype keys from custom param decorators (no phantom body/query/param)", () => {
      const endpoints = endpointsFromController(CustomParamController, {
        ...OPTIONS,
        name: "CustomParamController",
        basePath: "fixture-custom-param",
      });
      expect(endpoints).toHaveLength(1);
      const act = endpoints[0];
      expect(act?.handler).toBe("act");
      // 随机 uid 键（createParamDecorator 实际行为）绝不能被 parseInt
      // 误读成内置 paramtype——无论随机串以 3/4/5 开头还是其他字符。
      expect(act?.routeParams).toEqual([]);
      // 直接锚定元数据形状：键不是 "3:0" 这类纯数字形式。
      const keys = Object.keys(
        Reflect.getOwnMetadata(ROUTE_ARGS_METADATA, CustomParamController, "act") ?? {},
      );
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^[0-9a-f]{21}:\d+$/);
    });

    it("does not inherit parameter metadata from a base class handler of the same name (getOwnMetadata semantics)", () => {
      const childEndpoints = endpointsFromController(ChildController, {
        ...OPTIONS,
        name: "ChildController",
        basePath: "fixture-child",
      });
      const childGetItem = childEndpoints.find((e) => e.handler === "getItem");
      // 子类方法自身无参数装饰器 → own ROUTE_ARGS_METADATA 为空，
      // 父类 ParentController 上的同名参数不得穿透。
      expect(childGetItem?.routeParams).toEqual([]);
      // 基类自身的端点不受影响。
      const parentEndpoints = endpointsFromController(ParentController, {
        ...OPTIONS,
        name: "ParentController",
        basePath: "fixture-parent",
      });
      const parentGetItem = parentEndpoints.find((e) => e.handler === "getItem");
      expect(
        parentGetItem?.routeParams.some((p) => p.kind === "param" && p.name === "id"),
      ).toBe(true);
    });

    it("collects @Body/@Query/@Param with a total deterministic order (comparator returns 0 when equal)", () => {
      @Controller("fixture-mixed")
      class MixedController {
        @Post("mixed/:id")
        mixed(
          @Query("page") page: string,
          @Body() body: unknown,
          @Query("size") size: string,
          @Param("id") id: string,
        ) {
          return { page, body, size, id };
        }
      }
      // 同一控制器反复扫描输出必须逐次完全一致（严格全序：相等返回 0，
      // 不依赖 V8 sort 的稳定性兜底）。
      const runs = [0, 1, 2].map(() =>
        endpointsFromController(MixedController, {
          ...OPTIONS,
          name: "MixedController",
          basePath: "fixture-mixed",
        }).find((e) => e.handler === "mixed")?.routeParams,
      );
      const [first] = runs;
      expect(runs).toEqual([first, first, first]);
      // 顺序锚点：(kind, name) 字典序 → body 先于 param/query；
      // query 的 page 先于 size（同 kind 按 name）。
      expect(first?.map((p) => `${p.kind}:${p.name ?? ""}`)).toEqual([
        "body:",
        "param:id",
        "query:page",
        "query:size",
      ]);
    });

    it("simulates CI-01: a random-uid key that begins with '3' is not parsed as Body", () => {
      // 在真实控制器类上手工注入旧缺陷触发的键形状（"3a7f…:0"——
      // parseInt 前缀为 3 的 uid 键），断言修复后不产生 requestBody 数据。
      @Controller("fixture-poison")
      class PoisonedController {
        @Post("upgrade")
        upgrade() {
          return {};
        }
      }
      Reflect.defineMetadata(
        ROUTE_ARGS_METADATA,
        { "3a7f19c2d4e5b6f8a9c0d1e2:0": { index: 0, data: undefined } },
        PoisonedController,
        "upgrade",
      );
      const endpoints = endpointsFromController(PoisonedController, {
        ...OPTIONS,
        name: "PoisonedController",
        basePath: "fixture-poison",
      });
      expect(endpoints[0]?.routeParams).toEqual([]);
    });
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

    // 状态码语义：POST 默认 201（Nest @Post 默认，远端差分实测确认）；
    // 显式 @HttpCode 覆盖被提取（login 声明 200 → 响应键 200 + 标记）。
    const itemsCreate = snapshot.paths["/api/items"]?.post as
      | { responses?: Record<string, unknown> }
      | undefined;
    expect(itemsCreate?.responses).toHaveProperty("201");

    const login = snapshot.paths["/api/auth/login"]?.post as
      | { responses?: Record<string, unknown>; "x-http-code-explicit"?: number }
      | undefined;
    expect(login?.responses).toHaveProperty("200");
    expect(login?.["x-http-code-explicit"]).toBe(200);

    // GraphQL 端点（POST /graphql 在 api 之外挂载）不在 REST 快照 paths 里。
    expect(snapshot.paths["/graphql"]).toBeUndefined();
  });
});
