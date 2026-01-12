import { extractCountryCodeFromText, normalizeCountryCode } from "@modular/utils";

describe("geo utils - country extraction", () => {
  it("normalizes Chinese country labels to alpha3", () => {
    expect(normalizeCountryCode("美国")).toBe("USA");
    expect(normalizeCountryCode("美國")).toBe("USA");
    expect(normalizeCountryCode("中国")).toBe("CHN");
    expect(normalizeCountryCode("中國")).toBe("CHN");
    expect(normalizeCountryCode("中华人民共和国")).toBe("CHN");
    expect(normalizeCountryCode("中国台湾")).toBe("TWN");
    expect(normalizeCountryCode("台灣")).toBe("TWN");
    expect(normalizeCountryCode("东帝汶")).toBe("TLS");
  });

  it("extracts alpha3 codes from mixed location text", () => {
    expect(extractCountryCodeFromText("美国加州")).toBe("USA");
    expect(extractCountryCodeFromText("来自中国台湾省的消息")).toBe("TWN");
    expect(extractCountryCodeFromText("U.S. stocks")).toBe("USA");
    expect(extractCountryCodeFromText("Breaking news from the United Kingdom")).toBe("GBR");
  });
});

