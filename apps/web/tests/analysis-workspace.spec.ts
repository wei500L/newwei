import { describe, expect, it } from "vitest";

import {
  buildAnalysisSubjectHref,
  buildSavedViewHref,
  formatAnalysisActorName,
  sanitizeAnalysisQueryString,
} from "../lib/analysis-workspace";

describe("analysis workspace helpers", () => {
  it("removes transient params before saving", () => {
    expect(
      sanitizeAnalysisQueryString(
        "q=tariff&page=3&pageSize=50&savedView=view_1&topic=shipping",
      ),
    ).toBe("q=tariff&topic=shipping");
  });

  it("builds reopen links with saved view marker", () => {
    expect(
      buildSavedViewHref({
        id: "view_1",
        routePath: "/search",
        queryState: {
          queryString: "q=tariff&topic=shipping",
        },
      }),
    ).toBe("/search?q=tariff&topic=shipping&savedView=view_1");
  });

  it("falls back to email when actor name is empty", () => {
    expect(
      formatAnalysisActorName({
        id: "user_1",
        email: "analyst@example.com",
        firstName: " ",
        lastName: "",
        avatarUrl: null,
      }),
    ).toBe("analyst@example.com");
  });

  it("builds linked subject routes for task cards", () => {
    expect(buildAnalysisSubjectHref("item", "item-1")).toBe("/items/item-1");
    expect(buildAnalysisSubjectHref("event", "event-1")).toBe("/events/event-1");
    expect(buildAnalysisSubjectHref("saved_view", "view-1")).toBe(
      "/analysis?savedView=view-1",
    );
  });
});
