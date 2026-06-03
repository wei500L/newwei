jest.mock("@modular/mongo", () => ({
  ItemReadModelModel: {
    find: jest.fn(),
  },
}));

import { ItemReadModelModel } from "@modular/mongo";

import {
  ItemReadModelLoader,
  ItemReadModelProcessedLoader,
  ItemReadModelProcessedPreviewLoader,
} from "./item-read-model.loader";

describe("ItemReadModelLoader projections", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (ItemReadModelModel.find as jest.Mock).mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
  });

  const env = { itemsReadModelEnabled: true } as any;

  it("loads meta without raw, processed, or search blobs", async () => {
    const loader = new ItemReadModelLoader(env);

    await loader.generateDataLoader().load("meta-1");

    const projection = (ItemReadModelModel.find as jest.Mock).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(projection).toMatchObject({
      orgId: 1,
      itemMetaId: 1,
      "meta.id": 1,
    });
    expect(projection.raw).toBeUndefined();
    expect(projection.processed).toBeUndefined();
    expect(projection.searchText).toBeUndefined();
    expect(projection.searchTerms).toBeUndefined();
  });

  it("loads processed preview without processed.result", async () => {
    const loader = new ItemReadModelProcessedPreviewLoader(env);

    await loader.generateDataLoader().load("meta-1");

    const projection = (ItemReadModelModel.find as jest.Mock).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(projection).toMatchObject({
      title: 1,
      summary: 1,
      "processed.id": 1,
      "processed.summaryEmbeddingDimensions": 1,
    });
    expect(projection["processed.result"]).toBeUndefined();
    expect(projection.processed).toBeUndefined();
  });

  it("loads full processed subtree only for full processed fields", async () => {
    const loader = new ItemReadModelProcessedLoader(env);

    await loader.generateDataLoader().load("meta-1");

    const projection = (ItemReadModelModel.find as jest.Mock).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(projection).toEqual({
      itemMetaId: 1,
      processed: 1,
    });
  });
});
