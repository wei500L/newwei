import {
  CommonTimeZone,
  DatePrecision,
  getTimeZoneOffsetMs,
  parseDateRange,
  parseDateTime,
  parseDateTimeDetailed,
  toISODateString,
} from "@modular/utils";

describe("Date utils", () => {
  it("parses Chinese year-month with month precision", () => {
    const parsed = parseDateTimeDetailed("2023年5月");
    expect(parsed?.precision).toBe(DatePrecision.Month);
    expect(parsed?.date.toISOString()).toBe("2023-05-01T00:00:00.000Z");
  });

  it("parses Chinese full date", () => {
    expect(parseDateTime("2023年5月12日")?.toISOString()).toBe("2023-05-12T00:00:00.000Z");
  });

  it("parses quarter formats", () => {
    expect(parseDateTime("2023Q2")?.toISOString()).toBe("2023-04-01T00:00:00.000Z");
    expect(parseDateTime("2023年第4季度")?.toISOString()).toBe("2023-10-01T00:00:00.000Z");
  });

  it("parses naive datetime using provided time zone", () => {
    expect(parseDateTime("2023-05-01 12:34:56")?.toISOString()).toBe("2023-05-01T12:34:56.000Z");
    expect(
      parseDateTime("2023-05-01 12:34:56", { timeZone: CommonTimeZone.AsiaShanghai })?.toISOString(),
    ).toBe("2023-05-01T04:34:56.000Z");
  });

  it("parses explicit timezone offsets without overriding", () => {
    expect(
      parseDateTime("2023-05-01T00:00:00+08:00", { timeZone: CommonTimeZone.UTC })?.toISOString(),
    ).toBe("2023-04-30T16:00:00.000Z");
  });

  it("parses month ranges", () => {
    expect(parseDateRange("2023年5月")?.start.toISOString()).toBe("2023-05-01T00:00:00.000Z");
    expect(parseDateRange("2023年5月")?.endExclusive.toISOString()).toBe("2023-06-01T00:00:00.000Z");

    const sh = parseDateRange("2023-05", { timeZone: CommonTimeZone.AsiaShanghai });
    expect(sh?.start.toISOString()).toBe("2023-04-30T16:00:00.000Z");
    expect(sh?.endExclusive.toISOString()).toBe("2023-05-31T16:00:00.000Z");
  });

  it("formats ISO date in a specific time zone", () => {
    const utcMidnight = new Date("2023-04-30T16:00:00.000Z");
    expect(toISODateString(utcMidnight, CommonTimeZone.UTC)).toBe("2023-04-30");
    expect(toISODateString(utcMidnight, CommonTimeZone.AsiaShanghai)).toBe("2023-05-01");
  });

  it("returns stable time zone offsets", () => {
    const offset = getTimeZoneOffsetMs(new Date("2023-01-01T00:00:00.000Z"), CommonTimeZone.AsiaShanghai);
    expect(offset).toBe(8 * 60 * 60 * 1000);
  });
});

