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
