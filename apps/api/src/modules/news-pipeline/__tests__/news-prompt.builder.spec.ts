import { NewsPromptBuilder } from "../news-prompt.builder";

describe("NewsPromptBuilder", () => {
  const builder = new NewsPromptBuilder();

  it("includes language hints in the system prompt", () => {
    const prompt = builder.buildSystemPrompt("zh-CN");
    expect(prompt).toContain("zh-CN");
  });

  it("builds user prompts with metadata and keywords", () => {
    const prompt = builder.buildUserPrompt({
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = (format.json_schema.schema as any)?.properties;
    expect(schema.title).toBeDefined();
    expect(schema.cleaned_markdown).toBeDefined();
    expect(schema.key_points).toBeDefined();
    expect(schema.removed_noise_types).toBeDefined();
  });
});
