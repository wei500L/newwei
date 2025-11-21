import { zodToJsonSchema } from "zod-to-json-schema";
import { NewsPromptBuilder } from "../news-prompt.builder";
import { DEFAULT_NEWS_PROMPT_CONFIG } from "../news-prompt-config.service";
import { CleanedNewsSchema } from "../news-pipeline.schema";

describe("NewsPromptBuilder", () => {
  const builder = new NewsPromptBuilder();

  it("includes language hints in the system prompt", () => {
    const prompt = builder.buildSystemPrompt(DEFAULT_NEWS_PROMPT_CONFIG, "zh-CN");
    expect(prompt).toContain("zh-CN");
  });

  it("builds user prompts with metadata and keywords", () => {
    const prompt = builder.buildUserPrompt(DEFAULT_NEWS_PROMPT_CONFIG, {
      url: "https://example.com/story",
      markdown: "# Title\nBody",
      metadata: { title: "Title" },
      keywords: ["ai", "policy"],
      summaryHints: ["focus on regulation"],
      language: "en",
      cacheHit: false,
    });
    expect(prompt).toContain("https://example.com/story");
    expect(prompt).toContain("focus on regulation");
    expect(prompt).toContain("# Title");
  });

  it("returns a json schema response format with required fields", () => {
    const format = builder.buildResponseFormat();
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("clean_news_payload");
    expect(format.json_schema.schema).toEqual(
      zodToJsonSchema(CleanedNewsSchema, { $refStrategy: "none" }),
    );
  });
});
