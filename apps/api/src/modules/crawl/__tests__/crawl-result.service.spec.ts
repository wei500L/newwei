import { CrawlResultService } from "../crawl-result.service";

describe("CrawlResultService", () => {
  const createService = (maxBytes: number) =>
    new CrawlResultService(
      {} as any,
      {
        crawl4aiConfig: {
          media: { fetchTimeoutMs: 1000, maxBytes, maxPerResult: 10 }
        }
      } as any,
      {} as any
    );

  it("skips inline assets when the Data URI is too long", () => {
    const service = createService(8);
    const bufferFromSpy = jest.spyOn(Buffer, "from");
    const dataUri = `data:image/png;base64,${"A".repeat(5000)}`;

    const asset = (service as any).buildInlineMediaAsset(dataUri, "image", {});

    expect(asset).toBeUndefined();
    expect(bufferFromSpy).not.toHaveBeenCalled();
    bufferFromSpy.mockRestore();
  });

  it("skips inline assets when the decoded bytes exceed maxBytes", () => {
    const service = createService(4);
    const bufferFromSpy = jest.spyOn(Buffer, "from");
    const payload = Buffer.alloc(5).toString("base64");
    const dataUri = `data:image/png;base64,${payload}`;

    const asset = (service as any).buildInlineMediaAsset(dataUri, "image", {});

    expect(asset).toBeUndefined();
    expect(bufferFromSpy).not.toHaveBeenCalled();
    bufferFromSpy.mockRestore();
  });

  it("builds an asset for small inline base64 media", () => {
    const service = createService(128);
    const payload = Buffer.from("hello").toString("base64");
    const dataUri = `data:image/png;base64,${payload}`;

    const asset = (service as any).buildInlineMediaAsset(dataUri, "image", {});

    expect(asset).toEqual(
      expect.objectContaining({
        kind: "image",
        bytes: 5,
        contentType: "image/png",
        sourceUrl: dataUri,
        dataUri
      })
    );
  });

  it("ignores non-base64 data URIs", () => {
    const service = createService(128);

    const asset = (service as any).buildInlineMediaAsset("data:image/png,hello", "image", {});

    expect(asset).toBeUndefined();
  });
});

