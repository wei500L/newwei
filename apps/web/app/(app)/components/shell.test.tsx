import { describe, expect, it } from "vitest";

import { resolveShellTickerStyle } from "./shell";
import { isFullWidthViewport } from "./top-nav-density";

describe("Shell 顶部占位的跑马灯高度策略", () => {
  it("显示（full 宽屏档）：不覆盖变量，回落 :root 的 2rem", () => {
    expect(resolveShellTickerStyle(true)).toEqual({});
  });

  it("隐藏（compact/minimal）：--ticker-height 压为 0，不留 32px 空白", () => {
    expect(resolveShellTickerStyle(false)).toEqual({
      "--ticker-height": "0px",
    });
  });

  it("占位策略与 TopNav 的跑马灯显示条件同源（isFullWidthViewport）", () => {
    // TopNav 渲染 TickerTape 用 isFullWidthViewport，Shell 收敛占位也用它：
    // 两侧输入一致时，策略输出必然成对出现（显示+2rem / 隐藏+0px）。
    expect(resolveShellTickerStyle(isFullWidthViewport(1920))).toEqual({});
    expect(resolveShellTickerStyle(isFullWidthViewport(1400))).toEqual({
      "--ticker-height": "0px",
    });
    expect(resolveShellTickerStyle(isFullWidthViewport(375))).toEqual({
      "--ticker-height": "0px",
    });
  });
});
