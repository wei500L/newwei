import { describe, expect, it } from "vitest";

import { BBOX_QUERY_MIN_ZOOM, buildWarMapQueryBbox } from "./query-viewport";

describe("buildWarMapQueryBbox（查询 bbox 门禁）", () => {
  it("低于 bbox 最小 zoom 时不发送 bbox", () => {
    expect(
      buildWarMapQueryBbox([-180, -85, 180, 85], BBOX_QUERY_MIN_ZOOM - 0.01),
    ).toBeUndefined();
    expect(buildWarMapQueryBbox([10, 20, 30, 40], 2)).toBeUndefined();
  });

  it("bbox 为空时不发送", () => {
    expect(buildWarMapQueryBbox(undefined, 8)).toBeUndefined();
  });

  it("达到阈值时 bbox 正确规范化（5 位小数）", () => {
    expect(buildWarMapQueryBbox([10.123456, 20.654321, 30.111111, 40.999999], 4)).toBe(
      "10.12346,20.65432,30.11111,41.00000",
    );
  });

  it("恰好达到阈值时（=2.8）发送 bbox", () => {
    expect(
      buildWarMapQueryBbox([1, 2, 3, 4], BBOX_QUERY_MIN_ZOOM),
    ).toBe("1.00000,2.00000,3.00000,4.00000");
  });

  it("负数经度跨度的 bbox 保持原始顺序（规范化不重排）", () => {
    expect(
      buildWarMapQueryBbox([-130.5, 20.1, -100.2, 45.7], 5),
    ).toBe("-130.50000,20.10000,-100.20000,45.70000");
  });
});
