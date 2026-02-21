import {
  classifySourceByLabelAndUrl,
  createSourcePolicyMatcher,
  resolveSourceKey,
} from "../news-event-source-classifier";

describe("news-event-source-classifier", () => {
  it("prefers source label when resolving source key", () => {
    expect(resolveSourceKey("Reuters", "https://www.reuters.com/world/")).toBe(
      "Reuters",
    );
  });

  it("falls back to registrable domain when source label is empty", () => {
    expect(resolveSourceKey("", "https://www.bloomberg.com/markets")).toBe(
      "bloomberg.com",
    );
    expect(resolveSourceKey("", "https://news.bbc.co.uk/world")).toBe(
      "bbc.co.uk",
    );
  });

  it("classifies mainstream publishers as authoritative by domain", () => {
    expect(
      classifySourceByLabelAndUrl("", "https://www.reuters.com/world/"),
    ).toBe("authoritative");
    expect(
      classifySourceByLabelAndUrl("", "https://www.bloomberg.com/news"),
    ).toBe("authoritative");
    expect(
      classifySourceByLabelAndUrl(
        "",
        "https://english.kyodonews.net/news/2026/01/sample.html",
      ),
    ).toBe("authoritative");
  });

  it("classifies major publishers as authoritative by label", () => {
    expect(classifySourceByLabelAndUrl("Financial Times", null)).toBe(
      "authoritative",
    );
    expect(classifySourceByLabelAndUrl("Associated Press", null)).toBe(
      "authoritative",
    );
  });

  it("classifies blog and social channels as blog", () => {
    expect(
      classifySourceByLabelAndUrl(
        "Some Newsletter",
        "https://example.substack.com/p/alpha",
      ),
    ).toBe("blog");
    expect(
      classifySourceByLabelAndUrl(
        "Creator",
        "https://medium.com/@creator/post",
      ),
    ).toBe("blog");
  });

  it("uses blacklist precedence to prevent authoritative label spoofing", () => {
    expect(
      classifySourceByLabelAndUrl(
        "Reuters",
        "https://medium.com/@copy/reuters-roundup",
      ),
    ).toBe("blog");
  });

  it("supports runtime policy overrides from settings", () => {
    const matcher = createSourcePolicyMatcher({
      authoritativeDomains: [],
      authoritativeLabels: [],
      blogDomains: ["reuters.com"],
      blogLabels: [],
    });
    expect(
      classifySourceByLabelAndUrl(
        "Reuters",
        "https://www.reuters.com/world",
        matcher,
      ),
    ).toBe("blog");
  });

  it("avoids short-token false positives", () => {
    expect(
      classifySourceByLabelAndUrl("Maple Analysis", "https://example.com/post"),
    ).toBe("unknown");
  });
});
