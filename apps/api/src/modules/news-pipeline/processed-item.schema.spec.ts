import { ProcessedItemModel } from "@modular/mongo";

describe("ProcessedItemModel schema", () => {
  it("includes cleaned_markdown_source in result payload", () => {
    const path = ProcessedItemModel.schema.path("result.cleaned_markdown_source");
    expect(path).toBeTruthy();
  });

  it("includes content_type in result payload", () => {
    const path = ProcessedItemModel.schema.path("result.content_type");
    expect(path).toBeTruthy();
  });

  it("includes summaryEmbeddingDimensions for lightweight embedding metadata reads", () => {
    const path = ProcessedItemModel.schema.path("summaryEmbeddingDimensions");
    expect(path).toBeTruthy();
  });
});
