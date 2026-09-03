import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scanControllers } from "./scan-routes";

const API_ROOT = join(__dirname, "..");

// 契约保护网地基的行为测试：静态扫描器的输出形状与关键语义锚定。
// 这些断言保护 OpenAPI 快照与鉴权矩阵的共同输入——扫描器自身的回归
//（路由遗漏/权限归一化错误）会让两份契约基线悄悄失真。
describe("scanControllers", () => {
  const result = scanControllers({ apiRoot: API_ROOT });

  it("discovers the full controller surface without load errors", () => {
    expect(result.controllerCount).toBeGreaterThanOrEqual(70);
    expect(result.endpoints.length).toBeGreaterThanOrEqual(360);
    expect(result.errors).toEqual([]);
  });

  it("applies the /api global prefix and leaves admin/queues unprefixed", () => {
    expect(result.endpoints.some((e) => e.path === "/api/auth/login")).toBe(true);
    // Bull Board 挂载点不带 /api 前缀（main.ts:62-67 排除规则）。
    expect(result.endpoints.some((e) => e.path.startsWith("/api/admin/queues"))).toBe(false);
  });

  it("reads permission metadata with any/all modes", () => {
    const onboarding = result.endpoints.find(
      (e) => e.path === "/api/user-settings/ui/onboarding" && e.method === "PUT",
    );
    expect(onboarding?.auth.permissions).toEqual(["items.read"]);
    expect(onboarding?.auth.permissionsMode).toBe("any");
  });

  it("marks @Public endpoints as public (class or handler level)", () => {
    const liveness = result.endpoints.find(
      (e) => e.path === "/api/healthz/live" && e.method === "GET",
    );
    expect(liveness?.auth.isPublic).toBe(true);

    const internalKeys = result.endpoints.find(
      (e) => e.path === "/api/internal/litellm/openai-keys" && e.method === "GET",
    );
    // class 级 @Public + 内部 token guard。
    expect(internalKeys?.auth.isPublic).toBe(true);
    expect(internalKeys?.auth.guards).toContain("LitellmInternalTokenGuard");
  });

  it("fails closed: no endpoint lacks permission metadata after API-01 fix", () => {
    const dead = result.endpoints.filter(
      (e) =>
        !e.auth.isPublic &&
        !e.auth.allowAuthenticated &&
        e.auth.permissions.length === 0,
    );
    // API-01 修复后全库 0 个死路由；新增端点缺元数据会破坏此断言。
    expect(dead).toEqual([]);
  });

  it("detects the SEC-01 platform-admin gate on vector service mutation", () => {
    const put = result.endpoints.find(
      (e) =>
        e.path === "/api/system-settings/vector-service" &&
        e.method === "PUT",
    );
    const reset = result.endpoints.find(
      (e) =>
        e.path === "/api/system-settings/vector-service" &&
        e.method === "DELETE",
    );
    const get = result.endpoints.find(
      (e) =>
        e.path === "/api/system-settings/vector-service" &&
        e.method === "GET",
    );
    expect(put?.auth.platformAdminInHandler).toBe(true);
    expect(reset?.auth.platformAdminInHandler).toBe(true);
    // 读取端点不带平台校验（保持兼容）。
    expect(get?.auth.platformAdminInHandler).toBe(false);
  });

  it("extracts path params and route params", () => {
    const detail = result.endpoints.find(
      (e) => e.path === "/api/items/:id" && e.method === "GET",
    );
    expect(detail?.pathParams).toEqual(["id"]);
    expect(detail?.routeParams.some((p) => p.kind === "param" && p.name === "id")).toBe(true);
  });

  it("captures @Header response headers (cache-control semantics)", () => {
    const publicHome = result.endpoints.find(
      (e) => e.path === "/api/public-portal/home" && e.method === "GET",
    );
    expect(publicHome?.headers["Cache-Control"]).toMatch(/public/);
  });

  it("sorts output deterministically", () => {
    const paths = result.endpoints.map((e) => `${e.method} ${e.path}`);
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(paths).toEqual(sorted);
  });
});
