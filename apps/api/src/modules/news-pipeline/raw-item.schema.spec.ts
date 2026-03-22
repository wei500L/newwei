import { RawItemModel, buildComparableUrlVariants } from '@modular/mongo';

describe('RawItemModel schema', () => {
  it('derives comparable URL fields during validation', async () => {
    const url = 'https://Example.com/story/?ref=homepage#top';
    const comparable = buildComparableUrlVariants(url);
    const doc = new RawItemModel({
      itemMetaId: 'item-meta-1',
      payload: { url },
      source: 'manual',
    });

    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.urlComparableFull).toBe(comparable?.full);
    expect(doc.urlComparableFullHash).toBe(comparable?.fullHash);
    expect(doc.urlComparableBase).toBe(comparable?.base);
  });

  it('indexes the full comparable URL by hash instead of raw string value', () => {
    const indexes = RawItemModel.schema.indexes();

    expect(RawItemModel.schema.path('urlComparableFullHash')).toBeTruthy();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ urlComparableFullHash: 1, createdAt: -1 }, expect.any(Object)],
        [{ urlComparableBase: 1, createdAt: -1 }, expect.any(Object)],
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        [{ urlComparableFull: 1, createdAt: -1 }, expect.any(Object)],
      ]),
    );
  });
});
