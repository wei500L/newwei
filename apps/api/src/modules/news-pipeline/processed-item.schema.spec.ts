import { ProcessedItemModel } from "@modular/mongo";

describe("ProcessedItemModel schema", () => {
  it("includes cleaned_markdown_source in result payload", () => {
    const path = ProcessedItemModel.schema.path("result.cleaned_markdown_source");
    expect(path).toBeTruthy();
  });
});

