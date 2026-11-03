import { describe, expect, it } from "vitest";

import { formatTarget, type TargetRecord } from "./target-format";

function fieldKeys(record: TargetRecord): string[] {
  return formatTarget(record, { locale: "en-US" }).fields.map(
    (field) => field.labelKey,
  );
}

describe("formatTarget 专用格式化器", () => {
  it("航班：呼号、注册号、机型、高度、速度、航向、航线", () => {
    const view = formatTarget(
      {
        id: "abc123",
        layerId: "flights",
        layerName: "Live Flights",
        label: "UAL123",
        latitude: 37.6,
        longitude: -122.4,
        properties: {
          name: "UAL123",
          callsign: "UAL123",
          registration: "N12345",
          type: "B738",
          altitude: "35,000 ft",
          speed: "450 kt",
          heading: "270°",
          route: "SFO → JFK",
          operator: "United",
        },
      },
      { locale: "en-US" },
    );
    expect(view.title).toBe("UAL123");
    expect(view.kindKey).toBe("globe.target.kinds.flights");
    const keys = fieldKeys({
      id: "abc123",
      layerId: "flights",
      label: "UAL123",
      properties: {
        callsign: "UAL123",
        registration: "N12345",
        type: "B738",
        altitude: "35,000 ft",
        speed: "450 kt",
        heading: "270°",
        route: "SFO → JFK",
      },
    });
    expect(keys).toEqual([
      "globe.target.field.callsign",
      "globe.target.field.registration",
      "globe.target.field.aircraftType",
      "globe.target.field.altitude",
      "globe.target.field.speed",
      "globe.target.field.heading",
      "globe.target.field.route",
    ]);
    expect(view.position).toEqual({ lat: 37.6, lon: -122.4, altM: 10668 });
  });

  it("军机走同一套飞行器字段", () => {
    const view = formatTarget({
      id: "ae1234",
      layerId: "military",
      label: "RCH01",
      properties: { callsign: "RCH01", type: "C17", altitude: "20,000 ft" },
    });
    expect(view.kindKey).toBe("globe.target.kinds.military");
    expect(view.fields.map((field) => field.labelKey)).toContain(
      "globe.target.field.aircraftType",
    );
  });

  it("船舶：MMSI、船型、航速、航向、目的港", () => {
    const keys = fieldKeys({
      id: "ais-123",
      layerId: "ais-live-vessels",
      label: "EVER GIVEN",
      properties: {
        mmsi: "353136000",
        type: "Cargo",
        speedKt: 12.3,
        course: 275,
        destination: "ROTTERDAM",
      },
    });
    expect(keys).toEqual([
      "globe.target.field.mmsi",
      "globe.target.field.vesselType",
      "globe.target.field.speed",
      "globe.target.field.course",
      "globe.target.field.destination",
    ]);
  });

  it("卫星：NORAD、类别、轨道高度", () => {
    const view = formatTarget({
      id: "25544",
      layerId: "satellites",
      label: "ISS (ZARYA)",
      properties: {
        name: "ISS (ZARYA)",
        noradId: "25544",
        class: "Space station",
        altitude: "420 km",
      },
    });
    expect(view.title).toBe("ISS (ZARYA)");
    expect(view.fields.map((field) => field.labelKey)).toEqual([
      "globe.target.field.noradId",
      "globe.target.field.class",
      "globe.target.field.orbitAltitude",
    ]);
  });

  it("地震：震级、深度、地点、发生时间用 formatTimestamp", () => {
    const view = formatTarget(
      {
        id: "quake-1",
        layerId: "earthquakes",
        label: "M5.2",
        properties: {
          mag: 5.2,
          depth: 10,
          place: "10 km SW of Somewhere",
          time: Date.UTC(2026, 10, 2, 11, 5),
        },
      },
      { locale: "en-US" },
    );
    expect(view.subtitle).toBe("M5.2");
    expect(view.fields.map((field) => field.labelKey)).toEqual([
      "globe.target.field.magnitude",
      "globe.target.field.depth",
      "globe.target.field.place",
      "globe.target.field.time",
    ]);
    expect(view.fields[3]!.value).toMatch(/2026/);
  });

  it("山火：FRP、置信度、探测时间、卫星", () => {
    const keys = fieldKeys({
      id: "fire-1",
      layerId: "local-firms",
      label: "Fire · FRP 12.4 MW",
      properties: { frp: 12.4, confidence: "high", age: "5 min ago", sensor: "VIIRS" },
    });
    expect(keys).toEqual([
      "globe.target.field.frp",
      "globe.target.field.confidence",
      "globe.target.field.detectedAt",
      "globe.target.field.satellite",
    ]);
  });

  it("摄像头：名称、来源机构、最后一帧时间", () => {
    const view = formatTarget(
      {
        id: "cam-1",
        layerId: "cctv",
        label: "Harbor Cam",
        properties: {
          name: "Harbor Cam",
          agency: "Port Authority",
          lastFrameAt: Date.UTC(2026, 10, 2, 8, 30),
        },
      },
      { locale: "en-US" },
    );
    expect(view.title).toBe("Harbor Cam");
    expect(view.fields.map((field) => field.labelKey)).toEqual([
      "globe.target.field.cameraName",
      "globe.target.field.agency",
      "globe.target.field.lastFrame",
    ]);
  });
});

describe("通用格式化器", () => {
  it("只列原始类型、按 key 排序、排除特殊字段与对象/函数、最多 12 项", () => {
    const properties: Record<string, unknown> = {
      zeta: "last",
      alpha: 1,
      flag: true,
      entity: { nested: true },
      nested: { a: 1 },
      callback: () => undefined,
      _hidden: "secret",
      id: "should-be-excluded",
      layerId: "also-excluded",
    };
    // 超过 12 项，验证截断。
    for (let index = 0; index < 15; index += 1) {
      properties[`k${String(index).padStart(2, "0")}`] = index;
    }
    const view = formatTarget({
      id: "record-1",
      layerId: "some-layer",
      label: "Generic",
      properties,
    });
    expect(view.kindKey).toBe("globe.target.kinds.unknown");
    expect(view.title).toBe("Generic");
    const keys = view.fields.map((field) => field.labelKey);
    expect(keys).toHaveLength(12);
    expect(keys).not.toContain("entity");
    expect(keys).not.toContain("nested");
    expect(keys).not.toContain("callback");
    expect(keys).not.toContain("_hidden");
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("layerId");
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it("只在 metadata 自带 URL 时生成链接，不自己拼地址", () => {
    expect(
      formatTarget({ id: "x", layerId: "some", label: "X" }).links,
    ).toEqual([]);
    const linked = formatTarget({
      id: "x",
      layerId: "flights",
      label: "X",
      properties: { url: "https://example.com/aircraft/x" },
    });
    expect(linked.links).toEqual([
      { labelKey: "globe.target.links.external", href: "https://example.com/aircraft/x" },
    ]);
  });
});

describe("formatTarget 情报点（G6）", () => {
  it("地区：字段与 kindKey（地区/严重程度/新闻数/告警数/热度/时间/摘要）", () => {
    const view = formatTarget(
      {
        id: "newwei-events:evt:ua",
        layerId: "newwei-events",
        layerName: "地区态势",
        label: "Ukraine",
        latitude: 49,
        longitude: 32,
        properties: {
          name: "Ukraine",
          kind: "region",
          severity: "high",
          time: "2026-01-05T00:00:00.000Z",
          summary: "A summary",
          consoleUrl: "/search?q=Ukraine",
          newweiId: "ua",
          countryCode: "ua",
          newsCount: 12,
          alertCount: 4,
          score: 7.5,
        },
      },
      { locale: "zh-CN" },
    );
    expect(view.kindKey).toBe("globe.target.kinds.region");
    expect(view.title).toBe("Ukraine");
    expect(view.position).toEqual({ lat: 49, lon: 32 });
    const byKey = Object.fromEntries(
      view.fields.map((field) => [field.labelKey, field]),
    );
    expect(byKey["globe.target.field.region"]!.value).toBe("Ukraine");
    expect(byKey["globe.target.field.severity"]!.value).toBe("高");
    expect(byKey["globe.target.field.severity"]!.tagColor).toBe("error");
    expect(byKey["globe.target.field.newsCount"]!.value).toBe("12");
    expect(byKey["globe.target.field.alertCount"]!.value).toBe("4");
    expect(byKey["globe.target.field.score"]!.value).toBe("7.5");
    expect(byKey["globe.target.field.time"]!.value).toBeTruthy();
    expect(byKey["globe.target.field.summary"]!.value).toBe("A summary");
    expect(view.console).toEqual({
      labelKey: "globe.intel.openEvent",
      href: "/search?q=Ukraine",
    });
  });

  it("地区：consoleUrl 缺失时兜底为站内搜索，不再拼 /events/<id>", () => {
    const view = formatTarget(
      {
        id: "newwei-events:evt:ua",
        layerId: "newwei-events",
        properties: { name: "Ukraine", kind: "region", newweiId: "ua" },
      },
      { locale: "en-US" },
    );
    expect(view.console).toEqual({
      labelKey: "globe.intel.openEvent",
      href: "/search?q=Ukraine",
    });
  });

  it("地区：摘要为空时不显示摘要字段", () => {
    const view = formatTarget({
      id: "newwei-events:evt:ua",
      layerId: "newwei-events",
      properties: { name: "Ukraine", kind: "region" },
    });
    expect(
      view.fields.some((field) => field.labelKey === "globe.target.field.summary"),
    ).toBe(false);
  });

  it("新闻：主按钮「打开原文」为外部链接，medium 用 warning", () => {
    const view = formatTarget(
      {
        id: "newwei-news:news:news-9",
        layerId: "newwei-news",
        label: "Port reopens",
        latitude: 30,
        longitude: 32,
        properties: {
          name: "Port reopens",
          kind: "news",
          severity: "medium",
          time: "2026-02-01T00:00:00.000Z",
          summary: "Suez",
          location: "Suez",
          url: "https://example.com/port",
          newweiId: "news-9",
        },
      },
      { locale: "en-US" },
    );
    expect(view.kindKey).toBe("globe.target.kinds.news");
    const byKey = Object.fromEntries(
      view.fields.map((field) => [field.labelKey, field]),
    );
    expect(byKey["globe.target.field.type"]!.value).toBe("News");
    expect(byKey["globe.target.field.place"]!.value).toBe("Suez");
    expect(byKey["globe.target.field.severity"]!.tagColor).toBe("warning");
    expect(view.console).toEqual({
      labelKey: "globe.intel.openSource",
      href: "https://example.com/port",
      external: true,
    });
  });

  it("新闻：没有 url 时没有主按钮", () => {
    const view = formatTarget({
      id: "newwei-news:news:news-9",
      layerId: "newwei-news",
      properties: { name: "Port reopens", kind: "news", newweiId: "news-9" },
    });
    expect(view.console).toBeUndefined();
  });

  it("低严重度不加颜色", () => {
    const view = formatTarget({
      id: "newwei-events:evt:low",
      layerId: "newwei-events",
      properties: { name: "Low", kind: "region", severity: "low" },
    });
    const severity = view.fields.find(
      (field) => field.labelKey === "globe.target.field.severity",
    );
    expect(severity?.tagColor).toBeUndefined();
  });
});
