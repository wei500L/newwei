import { describe, expect, it } from "vitest";

import { parseNewsClassificationTaxonomyJson } from "../lib/news-classification-taxonomy";

describe("parseNewsClassificationTaxonomyJson", () => {
  it("returns invalidJson for malformed JSON", () => {
    const result = parseNewsClassificationTaxonomyJson("{");
    expect(result).toEqual({
      ok: false,
      error: { code: "invalidJson" },
    });
  });

  it("returns mustBeArray when taxonomy root is not an array", () => {
    const result = parseNewsClassificationTaxonomyJson('{"path":"tech/ai"}');
    expect(result).toEqual({
      ok: false,
      error: { code: "mustBeArray" },
    });
  });

  it("returns minItems when taxonomy array is empty", () => {
    const result = parseNewsClassificationTaxonomyJson("[]");
    expect(result).toEqual({
      ok: false,
      error: { code: "minItems" },
    });
  });

  it("returns nodeInvalid with index/field for invalid node fields", () => {
    const result = parseNewsClassificationTaxonomyJson(
      JSON.stringify([
        {
          path: "tech/ai/model-release",
          displayName: "AI Model Release",
          description: "desc",
          legacyCategory: "ai",
          keywords: ["model"],
          synonyms: ["launch"],
        },
        {
          path: "tech/ai/policy",
          displayName: "AI Policy",
          description: "desc",
          legacyCategory: "not-supported",
          keywords: ["policy"],
          synonyms: ["governance"],
        },
      ]),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "nodeInvalid",
        field: "legacyCategory",
        index: 2,
      },
    });
  });

  it("returns nodeInvalid when string list entries are invalid", () => {
    const result = parseNewsClassificationTaxonomyJson(
      JSON.stringify([
        {
          path: "tech/ai/model-release",
          displayName: "AI Model Release",
          description: "desc",
          legacyCategory: "ai",
          keywords: ["model", ""],
          synonyms: ["launch"],
        },
      ]),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "nodeInvalid",
        field: "keywords",
        index: 1,
      },
    });
  });

  it("parses valid taxonomy nodes", () => {
    const result = parseNewsClassificationTaxonomyJson(
      JSON.stringify([
        {
          path: "tech/ai/model-release",
          displayName: " AI Model Release ",
          description: " Model updates ",
          legacyCategory: "ai",
          keywords: [" model ", "llm"],
          synonyms: [" launch "],
        },
      ]),
    );
    expect(result).toEqual({
      ok: true,
      taxonomy: [
        {
          path: "tech/ai/model-release",
          displayName: "AI Model Release",
          description: "Model updates",
          legacyCategory: "ai",
          keywords: ["model", "llm"],
          synonyms: ["launch"],
        },
      ],
    });
  });
});
