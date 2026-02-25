import { NewsEventBriefPayloadSchema } from "../news-event-brief.schema";

describe("NewsEventBriefPayloadSchema", () => {
  const basePayload = {
    detailed_summary: "第一段。\n\n第二段。",
    tldr: "简要概述",
    key_points: [{ text: "关键事实", citations: [1] }],
    why_it_matters: [],
    latest_update: null,
    what_to_watch: [],
    comparison: {
      consensus: [],
      divergence: []
    },
    limitations: null
  };

  it("accepts payload with detailed_summary", () => {
    const parsed = NewsEventBriefPayloadSchema.parse(basePayload);
    expect(parsed.detailed_summary).toBe(basePayload.detailed_summary);
  });

  it("rejects payload without detailed_summary", () => {
    const parsed = NewsEventBriefPayloadSchema.safeParse({
      ...basePayload,
      detailed_summary: undefined
    });
    expect(parsed.success).toBe(false);
  });
});
