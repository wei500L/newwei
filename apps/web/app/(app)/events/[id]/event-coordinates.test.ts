import { describe, expect, it } from "vitest";

import { resolveEventCoordinates } from "./event-coordinates";

describe("resolveEventCoordinates", () => {
  it("读取 metadata 平铺坐标", () => {
    expect(resolveEventCoordinates({ metadata: { lat: 35.5, lng: 105.2 } })).toEqual(
      { lat: 35.5, lon: 105.2 },
    );
  });

  it("读取 latitude / longitude", () => {
    expect(
      resolveEventCoordinates({ metadata: { latitude: -12.5, longitude: 130.1 } }),
    ).toEqual({ lat: -12.5, lon: 130.1 });
  });

  it("读取嵌套 geo / location 与 coordinates 数组", () => {
    expect(resolveEventCoordinates({ metadata: { geo: { lat: 1, lon: 2 } } })).toEqual(
      { lat: 1, lon: 2 },
    );
    expect(
      resolveEventCoordinates({ metadata: { coordinates: [130.5, -12.25] } }),
    ).toEqual({ lat: -12.25, lon: 130.5 });
  });

  it("顶层坐标优先", () => {
    expect(resolveEventCoordinates({ lat: 10, lng: 20 })).toEqual({
      lat: 10,
      lon: 20,
    });
  });

  it("缺失或非法坐标返回 null", () => {
    expect(resolveEventCoordinates(null)).toBeNull();
    expect(resolveEventCoordinates({})).toBeNull();
    expect(resolveEventCoordinates({ metadata: { lat: 91, lng: 20 } })).toBeNull();
    expect(resolveEventCoordinates({ metadata: { lat: "abc", lng: 20 } })).toBeNull();
  });
});
