import { describe, expect, it } from "vitest";

import {
  buildWarMapBaseRequestParams,
  buildWarMapEventsQueryKey,
  buildWarMapLayerRequestParams,
  buildWarMapLayersQueryKey,
  buildWarMapNewsMarkersQueryKey,
} from "./war-map-data";

const BASE_INPUT = {
  start: "2026-01-01T00:00:00.000Z",
  end: "2026-01-08T00:00:00.000Z",
};

describe("war map query keys", () => {
  it("events key 携带 dashboard/war-map/events 前缀与时间范围", () => {
    expect(buildWarMapEventsQueryKey(BASE_INPUT)).toEqual([
      "dashboard",
      "war-map",
      "events",
      "2026-01-01T00:00:00.000Z",
      "2026-01-08T00:00:00.000Z",
      null,
      null,
      null,
    ]);
  });

  it("bbox/zoom/translate 进入 key，未提供时以 null 占位保持结构稳定", () => {
    const withViewport = buildWarMapEventsQueryKey({
      ...BASE_INPUT,
      bbox: "1,2,3,4",
      zoom: 4.567,
      translateTarget: "zh-CN",
    });
    expect(withViewport).toEqual([
      "dashboard",
      "war-map",
      "events",
      "2026-01-01T00:00:00.000Z",
      "2026-01-08T00:00:00.000Z",
      "1,2,3,4",
      4.57,
      "zh-CN",
    ]);
  });

  it("zoom 以 2 位小数入 key（避免微小抖动产生新 key）", () => {
    expect(
      buildWarMapEventsQueryKey({ ...BASE_INPUT, zoom: 4.56123 }).[6],
    ).toBe(4.56);
  });

  it("news markers key 使用 news-markers 前缀", () => {
    expect(buildWarMapNewsMarkersQueryKey(BASE_INPUT)[2]).toBe("news-markers");
  });

  it("layers key 默认 flightMode=military / aisMode=military", () => {
    expect(buildWarMapLayersQueryKey(BASE_INPUT)).toEqual([
      "dashboard",
      "war-map",
      "layers",
      "2026-01-01T00:00:00.000Z",
      "2026-01-08T00:00:00.000Z",
      null,
      null,
      null,
      "military",
      "military",
    ]);
  });

  it("layers key 随 flightMode/aisMode 变化", () => {
    const key = buildWarMapLayersQueryKey({
      ...BASE_INPUT,
      flightMode: "all",
      aisMode: "density",
    });
    expect(key[8]).toBe("all");
    expect(key[9]).toBe("density");
  });

  it("相同输入产生相同 key（结构稳定）", () => {
    const a = buildWarMapLayersQueryKey({
      ...BASE_INPUT,
      bbox: "1,2,3,4",
      zoom: 5,
    });
    const b = buildWarMapLayersQueryKey({
      ...BASE_INPUT,
      bbox: "1,2,3,4",
      zoom: 5,
    });
    expect(a).toEqual(b);
  });
});

describe("war map request params", () => {
  it("基础参数只包含 start/end", () => {
    expect(buildWarMapBaseRequestParams(BASE_INPUT)).toEqual({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-08T00:00:00.000Z",
    });
  });

  it("可选参数按需加入：translate/bbox/zoom/cluster", () => {
    expect(
      buildWarMapBaseRequestParams({
        ...BASE_INPUT,
        translateTarget: "zh-CN",
        bbox: "1,2,3,4",
        zoom: 4.567,
        cluster: false,
      }),
    ).toEqual({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-08T00:00:00.000Z",
      translate: "zh-CN",
      bbox: "1,2,3,4",
      zoom: "4.57",
      cluster: "0",
    });
  });

  it("layer 请求参数包含 flightMode/aisMode", () => {
    expect(
      buildWarMapLayerRequestParams({
        ...BASE_INPUT,
        flightMode: "all",
        aisMode: "density",
      }),
    ).toEqual({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-08T00:00:00.000Z",
      flightMode: "all",
      aisMode: "density",
    });
  });
});
