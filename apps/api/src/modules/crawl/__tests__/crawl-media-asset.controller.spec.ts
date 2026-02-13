import { CrawlMediaAssetController } from "../crawl-media-asset.controller";

describe("CrawlMediaAssetController", () => {
  const mediaAssets = {
    verifySignedAssetAccess: jest.fn(),
    getAssetDeliveryPayload: jest.fn()
  } as any;

  const response = {
    setHeader: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
    redirect: jest.fn()
  } as any;

  let controller: CrawlMediaAssetController;

  beforeEach(() => {
    jest.resetAllMocks();
    response.status.mockReturnValue(response);
    controller = new CrawlMediaAssetController(mediaAssets);
    mediaAssets.verifySignedAssetAccess.mockReturnValue({ ok: true });
  });

  it("forces attachment for preview requests with unsafe content type", async () => {
    mediaAssets.getAssetDeliveryPayload.mockResolvedValue({
      contentType: "application/octet-stream",
      inlineSafe: false,
      bytes: 5,
      fileName: "asset.bin",
      data: Buffer.from("hello")
    });

    await controller.serveAsset(
      "asset-1",
      "preview",
      `${Date.now() + 60_000}`,
      "org-1",
      "user-1",
      "sig",
      response
    );

    expect(mediaAssets.getAssetDeliveryPayload).toHaveBeenCalledWith("asset-1", "preview", {
      orgId: "org-1"
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="asset.bin"'
    );
    expect(response.setHeader).not.toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.any(String)
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith(Buffer.from("hello"));
  });

  it("serves inline preview for safe media and applies strict CSP", async () => {
    mediaAssets.getAssetDeliveryPayload.mockResolvedValue({
      contentType: "image/png",
      inlineSafe: true,
      bytes: 5,
      fileName: "asset.png",
      data: Buffer.from("hello")
    });

    await controller.serveAsset(
      "asset-2",
      "preview",
      `${Date.now() + 60_000}`,
      "org-1",
      "user-1",
      "sig",
      response
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'inline; filename="asset.png"'
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      "default-src 'none'; sandbox"
    );
  });

  it("redirects when service returns signed object URL", async () => {
    mediaAssets.getAssetDeliveryPayload.mockResolvedValue({
      contentType: "image/png",
      inlineSafe: true,
      bytes: 5,
      fileName: "asset.png",
      redirectUrl: "https://signed.example.com/asset.png"
    });
    response.redirect.mockReturnValue(response);

    await controller.serveAsset(
      "asset-3",
      "preview",
      `${Date.now() + 60_000}`,
      "org-1",
      "user-1",
      "sig",
      response
    );

    expect(response.redirect).toHaveBeenCalledWith("https://signed.example.com/asset.png");
    expect(response.setHeader).not.toHaveBeenCalledWith(
      "Content-Disposition",
      expect.any(String)
    );
  });
});
