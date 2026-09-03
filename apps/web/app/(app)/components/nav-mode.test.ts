import { describe, expect, it } from "vitest";

import {
  DESKTOP_RAIL_MIN_WIDTH,
  estimateRailContentHeight,
  resolveNavMode,
} from "./nav-mode";

describe("estimateRailContentHeight（五组化度量）", () => {
  it("空组列表只剩面板内边距与视觉缓冲", () => {
    expect(estimateRailContentHeight({ groupItemCounts: [], hasTitledAdminGroup: false })).toBe(40);
  });

  it("单组高度 = 面板内边距 + 项列表 + 缓冲", () => {
    // 32 面板 + (5*44 + 4*6 = 244) + 8 缓冲
    expect(
      estimateRailContentHeight({ groupItemCounts: [5], hasTitledAdminGroup: false }),
    ).toBe(284);
  });

  it("多组之间累加分隔线，管理组额外累加标题块", () => {
    // 五组全量（今日 5 / 态势 7 / 研究 3 / 工作台 3 / 管理 2）
    const full = estimateRailContentHeight({
      groupItemCounts: [5, 7, 3, 3, 2],
      hasTitledAdminGroup: true,
    });
    // 32 + 244 + 17 + (7*44+6*6=344) + 17 + (3*44+2*6=144) + 17 + (3*44+2*6=144)
    // + 13(管理上边界) + 32(标题块) + (2*44+6=94) + 8
    expect(full).toBe(32 + 244 + 17 + 344 + 17 + 144 + 17 + 144 + 13 + 32 + 94 + 8);

    // 无管理组标题时（无权限）不再计管理组标题块
    const withoutAdmin = estimateRailContentHeight({
      groupItemCounts: [5, 6, 3, 3],
      hasTitledAdminGroup: false,
    });
    expect(withoutAdmin).toBe(32 + 244 + 17 + (6 * 44 + 5 * 6) + 17 + 144 + 17 + 144 + 8);
  });

  it("忽略负数与分数项数", () => {
    expect(
      estimateRailContentHeight({ groupItemCounts: [-1, 1.7], hasTitledAdminGroup: false }),
    ).toBe(
      estimateRailContentHeight({ groupItemCounts: [0, 1], hasTitledAdminGroup: false }),
    );
  });
});

describe("resolveNavMode（rail / rail-scroll / drawer 三态）", () => {
  it("窄于桌面阈值（900px）一律 drawer", () => {
    expect(
      resolveNavMode({
        viewportWidth: DESKTOP_RAIL_MIN_WIDTH - 1,
        availableRailHeight: 2000,
        railContentHeight: 100,
      }),
    ).toBe("drawer");
  });

  it("高度充足时 rail，不足且能容 0.78 以上时 rail-scroll", () => {
    expect(
      resolveNavMode({
        viewportWidth: DESKTOP_RAIL_MIN_WIDTH,
        availableRailHeight: 1200,
        railContentHeight: 1104,
      }),
    ).toBe("rail");

    expect(
      resolveNavMode({
        viewportWidth: DESKTOP_RAIL_MIN_WIDTH,
        availableRailHeight: 900,
        railContentHeight: 1104,
      }),
    ).toBe("rail-scroll");

    expect(
      resolveNavMode({
        viewportWidth: DESKTOP_RAIL_MIN_WIDTH,
        availableRailHeight: 700,
        railContentHeight: 1104,
      }),
    ).toBe("drawer");
  });

  it("度量未知（0）时保守取 rail，交由测量回路收敛", () => {
    expect(
      resolveNavMode({
        viewportWidth: DESKTOP_RAIL_MIN_WIDTH,
        availableRailHeight: 0,
        railContentHeight: 0,
      }),
    ).toBe("rail");
  });
});
