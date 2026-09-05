import { describe, expect, it } from "vitest";

import en from "@/lib/locales/en.json";
import zh from "@/lib/locales/zh.json";

describe("War Map legend i18n（FE-批4B：focusBadge 键锁定）", () => {
  it("focusBadge 在 en/zh 成对存在且为真实翻译（无硬编码 Focus）", () => {
    const enLegend = (
      en as {
        dashboard: {
          charts: { warMap: { legend: Record<string, string> } };
        };
      }
    ).dashboard.charts.warMap.legend;
    const zhLegend = (
      zh as {
        dashboard: {
          charts: { warMap: { legend: Record<string, string> } };
        };
      }
    ).dashboard.charts.warMap.legend;
    expect(enLegend.focusBadge).toBe("Focused");
    expect(zhLegend.focusBadge).toBe("已聚焦");
    // clearFocus 语义保持
    expect(enLegend.clearFocus).toBe("Clear focus");
    expect(zhLegend.clearFocus).toBe("清除聚焦");
  });
});
