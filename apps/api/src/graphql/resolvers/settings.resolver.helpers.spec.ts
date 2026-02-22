import { toNewsEventSourcePolicyInput } from "./settings.resolver.helpers";

describe("toNewsEventSourcePolicyInput", () => {
  const baseInput = {
    authoritativeDomains: ["reuters.com"],
    authoritativeLabels: ["reuters"],
    blogDomains: ["medium.com"],
    blogLabels: ["blog"],
  };

  it("omits categoryAuthority key when input leaves it undefined", () => {
    const result = toNewsEventSourcePolicyInput(baseInput as any);

    expect(
      Object.prototype.hasOwnProperty.call(result, "categoryAuthority"),
    ).toBe(false);
  });

  it("includes an empty categoryAuthority list when input explicitly sets null", () => {
    const result = toNewsEventSourcePolicyInput({
      ...baseInput,
      categoryAuthority: null,
    } as any);

    expect(
      Object.prototype.hasOwnProperty.call(result, "categoryAuthority"),
    ).toBe(true);
    expect(result.categoryAuthority).toEqual([]);
  });

  it("maps categoryAuthority entries and applies default numeric fallbacks", () => {
    const result = toNewsEventSourcePolicyInput({
      ...baseInput,
      categoryAuthority: [
        {
          categoryPrefix: "tech",
          authoritativeBoost: 0.3,
          blogPenalty: 0.2,
          unknownPenalty: 0.1,
          domainBoosts: [{ domain: "example.com", delta: 0.25 }],
        },
      ],
    } as any);

    expect(result.categoryAuthority).toEqual([
      {
        categoryPrefix: "tech",
        authoritativeBoost: 0.3,
        blogPenalty: 0.2,
        unknownPenalty: 0.1,
        minConfidenceFloor: 0,
        mismatchPenalty: 0,
        domainBoosts: [{ domain: "example.com", delta: 0.25 }],
      },
    ]);
  });
});
