import { BadRequestException } from "@nestjs/common";

import { assertNoCrawl4aiLlmOptions } from "../crawl4ai-llm.guard";

describe("assertNoCrawl4aiLlmOptions", () => {
  it("allows normal crawl options", () => {
    expect(() =>
      assertNoCrawl4aiLlmOptions({
        headless: true,
        enableStealthMode: true,
        userAgent: "UA",
        markdownOptions: { contentSource: "cleaned_html" }
      })
    ).not.toThrow();
  });

  it("blocks extraction_strategy (snake_case)", () => {
    expect(() =>
      assertNoCrawl4aiLlmOptions({
        extraction_strategy: { type: "llm" }
      })
    ).toThrow(BadRequestException);
  });

  it("blocks extractionStrategy (camelCase)", () => {
    expect(() =>
      assertNoCrawl4aiLlmOptions({
        extractionStrategy: { type: "llm" }
      })
    ).toThrow(BadRequestException);
  });

  it("blocks llm_config nested anywhere", () => {
    expect(() =>
      assertNoCrawl4aiLlmOptions({
        nested: {
          llm_config: { provider: "openai/gpt-4" }
        }
      })
    ).toThrow(BadRequestException);
  });
});

