import { describe, expect, it } from "vitest";

import {
  isValidUrlDateRange,
  parseUrlDateParam,
  parseUrlIntChoice,
  parseUrlPositiveInt,
  parseUrlStringEnum,
  parseUrlStringSet,
  serializeUrlPositiveInt,
  serializeUrlStringSet,
  serializeUrlValue,
} from "@/lib/url-state-codec";

describe("parseUrlStringEnum", () => {
  const allowed = ["low", "medium", "high"];

  it("合法值原样返回", () => {
    expect(parseUrlStringEnum("high", allowed, "low")).toBe("high");
  });

  it("null / 空串 / 纯空白回退默认值", () => {
    expect(parseUrlStringEnum(null, allowed, "low")).toBe("low");
    expect(parseUrlStringEnum("", allowed, "low")).toBe("low");
    expect(parseUrlStringEnum("   ", allowed, "low")).toBe("low");
  });

  it("未知值回退默认值", () => {
    expect(parseUrlStringEnum("critical", allowed, "low")).toBe("low");
  });
});

describe("parseUrlStringSet", () => {
  const allowed = ["a", "b", "c"];

  it("过滤未知值、去重并确定性排序", () => {
    expect(
      parseUrlStringSet(["c", "unknown", "a", "c", "b", "a"], allowed),
    ).toEqual(["a", "b", "c"]);
  });

  it("空输入返回空数组", () => {
    expect(parseUrlStringSet(null, allowed)).toEqual([]);
    expect(parseUrlStringSet([], allowed)).toEqual([]);
  });

  it("全部非法时返回空数组", () => {
    expect(parseUrlStringSet(["x", "y"], allowed)).toEqual([]);
  });
});

describe("parseUrlPositiveInt", () => {
  it("合法正整数解析", () => {
    expect(parseUrlPositiveInt("3", 1)).toBe(3);
    expect(parseUrlPositiveInt("100", 30)).toBe(100);
  });

  it("page < 1、非数字、小数、空串回退默认值", () => {
    expect(parseUrlPositiveInt("0", 1)).toBe(1);
    expect(parseUrlPositiveInt("-2", 1)).toBe(1);
    expect(parseUrlPositiveInt("abc", 30)).toBe(30);
    expect(parseUrlPositiveInt("1.5", 30)).toBe(30);
    expect(parseUrlPositiveInt("", 30)).toBe(30);
    expect(parseUrlPositiveInt(null, 30)).toBe(30);
  });
});

describe("parseUrlIntChoice", () => {
  const allowed = [20, 30, 50, 100];

  it("选项内返回原值，选项外回退默认值", () => {
    expect(parseUrlIntChoice("50", allowed, 30)).toBe(50);
    expect(parseUrlIntChoice("40", allowed, 30)).toBe(30);
    expect(parseUrlIntChoice("15", allowed, 30)).toBe(30);
    expect(parseUrlIntChoice("abc", allowed, 30)).toBe(30);
  });
});

describe("parseUrlDateParam", () => {
  it("合法 YYYY-MM-DD 返回原值", () => {
    expect(parseUrlDateParam("2026-06-15")).toBe("2026-06-15");
  });

  it("拒绝格式错误", () => {
    expect(parseUrlDateParam("2026/06/15")).toBeNull();
    expect(parseUrlDateParam("20260615")).toBeNull();
    expect(parseUrlDateParam("2026-6-15")).toBeNull();
    expect(parseUrlDateParam("")).toBeNull();
    expect(parseUrlDateParam(null)).toBeNull();
  });

  it("拒绝日历非法日期（静默进位防护）", () => {
    expect(parseUrlDateParam("2026-02-31")).toBeNull();
    expect(parseUrlDateParam("2026-13-01")).toBeNull();
  });

  it("接受闰日", () => {
    expect(parseUrlDateParam("2024-02-29")).toBe("2024-02-29");
    expect(parseUrlDateParam("2026-02-29")).toBeNull();
  });
});

describe("isValidUrlDateRange", () => {
  it("两端合法且 from <= to", () => {
    expect(isValidUrlDateRange("2026-06-01", "2026-06-30")).toBe(true);
    expect(isValidUrlDateRange("2026-06-15", "2026-06-15")).toBe(true);
  });

  it("反向或缺失无效", () => {
    expect(isValidUrlDateRange("2026-06-30", "2026-06-01")).toBe(false);
    expect(isValidUrlDateRange(null, "2026-06-01")).toBe(false);
    expect(isValidUrlDateRange("2026-06-01", null)).toBe(false);
    expect(isValidUrlDateRange(null, null)).toBe(false);
  });
});

describe("serializeUrlValue", () => {
  it("非默认值写入并 trim", () => {
    const params = new URLSearchParams("keep=1");
    serializeUrlValue(params, "q", "  alpha  ", "");
    expect(params.toString()).toBe("keep=1&q=alpha");
  });

  it("默认值与空串从 URL 删除", () => {
    const params = new URLSearchParams("q=alpha&page=3");
    serializeUrlValue(params, "q", "", "");
    expect(params.get("q")).toBeNull();
    serializeUrlValue(params, "page", "3", "3");
    expect(params.get("page")).toBeNull();
  });
});

describe("serializeUrlStringSet", () => {
  it("重复 key 写入、去重、排序", () => {
    const params = new URLSearchParams();
    serializeUrlStringSet(params, "severity", ["high", "low", "high"]);
    expect(params.getAll("severity")).toEqual(["high", "low"]);
  });

  it("先删后写：旧值被替换，不残留", () => {
    const params = new URLSearchParams("severity=low");
    serializeUrlStringSet(params, "severity", ["high"]);
    expect(params.getAll("severity")).toEqual(["high"]);
  });

  it("空集合删除 key", () => {
    const params = new URLSearchParams("severity=low");
    serializeUrlStringSet(params, "severity", []);
    expect(params.has("severity")).toBe(false);
  });

  it("未拥有的其他 key 保持不动", () => {
    const params = new URLSearchParams("eventId=e-1&severity=low");
    serializeUrlStringSet(params, "severity", ["high"]);
    expect(params.get("eventId")).toBe("e-1");
  });
});

describe("serializeUrlPositiveInt", () => {
  it("非默认值写入，默认值删除，非法值删除", () => {
    const params = new URLSearchParams("page=5");
    serializeUrlPositiveInt(params, "page", 2, 1);
    expect(params.get("page")).toBe("2");

    serializeUrlPositiveInt(params, "page", 1, 1);
    expect(params.has("page")).toBe(false);

    serializeUrlPositiveInt(params, "page", 0, 1);
    expect(params.has("page")).toBe(false);
  });
});
