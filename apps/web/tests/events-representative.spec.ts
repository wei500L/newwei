import { describe, expect, it } from "vitest";

import { pickRepresentativeProcessedItemId } from "../app/(app)/events/utils";

describe("pickRepresentativeProcessedItemId", () => {
  it("prefers representativeProcessedItemId when present", () => {
    expect(
      pickRepresentativeProcessedItemId({
        representativeProcessedItemId: "pi-1",
        items: [{ processedItemId: "pi-2" }]
      })
    ).toBe("pi-1");
  });

  it("falls back to first item.processedItemId", () => {
    expect(
      pickRepresentativeProcessedItemId({
        representativeProcessedItemId: null,
        items: [{ processedItemId: null }, { processedItemId: "pi-2" }]
      })
    ).toBe("pi-2");
  });

  it("returns null when nothing is available", () => {
    expect(pickRepresentativeProcessedItemId({ representativeProcessedItemId: null, items: [] })).toBeNull();
    expect(pickRepresentativeProcessedItemId(null)).toBeNull();
  });
});

