import { describe, expect, it } from "vitest";

import {
  isPathActive,
  resolveActiveItemKey,
  type ActionRailRouteItem,
} from "../app/(app)/components/action-rail-routing";

const navItems: ActionRailRouteItem[] = [
  { key: "/today", path: "/today" },
  { key: "/admin", path: "/admin" },
  { key: "/admin/ops/crawl-tasks", path: "/admin/ops/crawl-tasks" },
];

describe("isPathActive", () => {
  it("matches exact route, nested route, and query route", () => {
    expect(isPathActive("/events", "/events")).toBe(true);
    expect(isPathActive("/events/123", "/events")).toBe(true);
    expect(isPathActive("/events?tab=brief", "/events")).toBe(true);
  });

  it("does not match by unsafe prefix", () => {
    expect(isPathActive("/events-archive", "/events")).toBe(false);
    expect(isPathActive(null, "/events")).toBe(false);
    expect(isPathActive("/events", undefined)).toBe(false);
  });
});

describe("resolveActiveItemKey", () => {
  it("prefers the longest matching path", () => {
    expect(resolveActiveItemKey("/admin/ops/crawl-tasks/42", navItems)).toBe("/admin/ops/crawl-tasks");
  });

  it("returns null when no item matches", () => {
    expect(resolveActiveItemKey("/search", navItems)).toBeNull();
  });
});
