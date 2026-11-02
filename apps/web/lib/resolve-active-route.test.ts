import { describe, expect, it } from "vitest";

import { resolveActiveRouteKey } from "@/lib/resolve-active-route";

const dashboardKeys = [
  "/dashboard",
  "/dashboard/key-monitor",
  "/dashboard/military-alert",
];

const financeKeys = ["/finance", "/finance/macro", "/finance/livelihood"];

describe("resolveActiveRouteKey", () => {
  it("精确命中父路由", () => {
    expect(resolveActiveRouteKey("/dashboard", dashboardKeys)).toBe("/dashboard");
  });

  it("精确命中子路由", () => {
    expect(resolveActiveRouteKey("/dashboard/key-monitor", dashboardKeys)).toBe(
      "/dashboard/key-monitor",
    );
  });

  it("子路由的更深路径取最长前缀", () => {
    expect(
      resolveActiveRouteKey("/dashboard/key-monitor/sub", dashboardKeys),
    ).toBe("/dashboard/key-monitor");
  });

  it("finance 精确命中子路由", () => {
    expect(resolveActiveRouteKey("/finance/macro", financeKeys)).toBe(
      "/finance/macro",
    );
  });

  it("pathname 为空回退第一项", () => {
    expect(resolveActiveRouteKey(null, dashboardKeys)).toBe(dashboardKeys[0]);
  });

  it("无匹配回退第一项", () => {
    expect(resolveActiveRouteKey("/other", dashboardKeys)).toBe(dashboardKeys[0]);
  });
});
