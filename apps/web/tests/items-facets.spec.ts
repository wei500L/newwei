import { describe, expect, it } from "vitest";

import { resolveAvailableSentiments } from "../app/(app)/items/item-facets";

describe("items facet helpers", () => {
  it("keeps a selected sentiment visible even when the latest facet payload omits it", () => {
    expect(resolveAvailableSentiments([], ["negative"])).toEqual(["negative"]);
  });

  it("returns canonical sentiment order across selected and facet-provided values", () => {
    expect(
      resolveAvailableSentiments(["neutral", "positive"], ["negative", "neutral"]),
    ).toEqual(["positive", "neutral", "negative"]);
  });
});
