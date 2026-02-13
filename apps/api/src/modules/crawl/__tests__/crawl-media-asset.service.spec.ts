import { CrawlMediaAssetService } from "../crawl-media-asset.service";

describe("CrawlMediaAssetService", () => {
  const prisma = {
    crawlMediaAsset: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn()
    }
  } as any;
  const storageSettings = {
    getCrawlImageStorageProvider: jest.fn(),
    getStorageConfig: jest.fn()
  } as any;
  const storage = {
    uploadObject: jest.fn(),
    createObjectReadUrl: jest.fn(),
    deleteObject: jest.fn()
  } as any;
  const env = {
    jwtConfig: {
      secret: "test-secret"
    }
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    storageSettings.getStorageConfig.mockResolvedValue({
      presignedUrlTtlSeconds: 300
    });
  });

  it("stores media as mysql blob and returns signed preview URLs", async () => {
    storageSettings.getCrawlImageStorageProvider.mockResolvedValue("mysql");
    const service = new CrawlMediaAssetService(prisma, storageSettings, storage, env);
    const payload = Buffer.from("hello");

    await service.storeAsset({
      orgId: "org-1",
      taskId: "task-1",
      resultId: "result-1",
      kind: "image",
      sourceUrl: "https://example.com/a.png",
      bytes: payload.length,
      data: payload,
      contentType: "image/png"
    });

    expect(prisma.crawlMediaAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "mysql",
          blobData: payload,
          storageKey: null
        })
      })
    );
    expect(storage.uploadObject).not.toHaveBeenCalled();

    prisma.crawlMediaAsset.findMany.mockResolvedValue([
      {
        id: "asset-1",
        resultId: "result-1",
        provider: "mysql",
        kind: "image",
        sourceUrl: "https://example.com/a.png",
        bytes: payload.length,
        contentType: "image/png",
        blobData: payload,
        storageKey: null,
        width: null,
        height: null,
        alt: null,
        title: null,
        desc: null,
        poster: null,
        format: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        orgId: "org-1",
        taskId: "task-1"
      }
    ]);

    const grouped = await service.listAssetsByResultIds(["result-1"], {
      orgId: "org-1",
      userId: "user-1"
    });
    const first = grouped.get("result-1")?.[0];
    expect(first?.storageProvider).toBe("mysql");
    expect(first?.previewUrl).toMatch(
      /^\/api\/crawl-media-assets\/asset-1\/preview\?exp=\d+&org=org-1&user=user-1&sig=/
    );
    expect(first?.downloadUrl).toMatch(
      /^\/api\/crawl-media-assets\/asset-1\/download\?exp=\d+&org=org-1&user=user-1&sig=/
    );
  });

  it("stores media in s3 and returns signed preview url", async () => {
    storageSettings.getCrawlImageStorageProvider.mockResolvedValue("s3");
    storage.uploadObject.mockResolvedValue({
      objectKey: "crawl-media/org-1/task-1/result-1/file.png",
      publicUrl: "https://bucket.example.com/crawl-media/org-1/task-1/result-1/file.png"
    });
    storage.createObjectReadUrl
      .mockResolvedValueOnce("https://signed.example.com/file-preview.png")
      .mockResolvedValueOnce("https://signed.example.com/file-download.png");
    const service = new CrawlMediaAssetService(prisma, storageSettings, storage, env);
    const payload = Buffer.from("hello");

    await service.storeAsset({
      orgId: "org-1",
      taskId: "task-1",
      resultId: "result-1",
      kind: "image",
      sourceUrl: "https://example.com/a.png",
      bytes: payload.length,
      data: payload,
      contentType: "image/png"
    });

    expect(storage.uploadObject).toHaveBeenCalledTimes(1);
    expect(prisma.crawlMediaAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "s3",
          blobData: null,
          storageKey: expect.stringContaining("crawl-media/org-1/task-1/result-1/")
        })
      })
    );

    prisma.crawlMediaAsset.findMany.mockResolvedValue([
      {
        id: "asset-2",
        resultId: "result-1",
        provider: "s3",
        kind: "image",
        sourceUrl: "https://example.com/a.png",
        bytes: payload.length,
        contentType: "image/png",
        blobData: null,
        storageKey: "crawl-media/org-1/task-1/result-1/file.png",
        width: null,
        height: null,
        alt: null,
        title: null,
        desc: null,
        poster: null,
        format: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        orgId: "org-1",
        taskId: "task-1"
      }
    ]);

    const grouped = await service.listAssetsByResultIds(["result-1"], {
      orgId: "org-1",
      userId: "user-1"
    });
    const first = grouped.get("result-1")?.[0];
    expect(first?.storageProvider).toBe("s3");
    expect(first?.previewUrl).toBe("https://signed.example.com/file-preview.png");
    expect(first?.downloadUrl).toBe("https://signed.example.com/file-download.png");
    expect(storage.createObjectReadUrl).toHaveBeenCalledTimes(2);
    expect(storage.createObjectReadUrl).toHaveBeenNthCalledWith(
      1,
      "crawl-media/org-1/task-1/result-1/file.png",
      expect.objectContaining({
        responseContentType: "image/png",
        responseContentDisposition: expect.stringContaining("inline")
      })
    );
    expect(storage.createObjectReadUrl).toHaveBeenNthCalledWith(
      2,
      "crawl-media/org-1/task-1/result-1/file.png",
      expect.objectContaining({
        responseContentType: "image/png",
        responseContentDisposition: expect.stringContaining("attachment")
      })
    );
  });

  it("sanitizes unsafe content types and only signs attachment URLs", async () => {
    storageSettings.getCrawlImageStorageProvider.mockResolvedValue("s3");
    storage.uploadObject.mockResolvedValue({
      objectKey: "crawl-media/org-1/task-1/result-1/file.bin",
      publicUrl: "https://bucket.example.com/crawl-media/org-1/task-1/result-1/file.bin"
    });
    storage.createObjectReadUrl.mockResolvedValue("https://signed.example.com/file-download.bin");
    const service = new CrawlMediaAssetService(prisma, storageSettings, storage, env);
    const payload = Buffer.from("hello");

    await service.storeAsset({
      orgId: "org-1",
      taskId: "task-1",
      resultId: "result-1",
      kind: "image",
      sourceUrl: "https://example.com/a.png",
      bytes: payload.length,
      data: payload,
      contentType: "text/html; charset=utf-8"
    });

    expect(storage.uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "application/octet-stream"
      })
    );
    expect(prisma.crawlMediaAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentType: undefined
        })
      })
    );

    prisma.crawlMediaAsset.findMany.mockResolvedValue([
      {
        id: "asset-unsafe",
        resultId: "result-1",
        provider: "s3",
        kind: "image",
        sourceUrl: "https://example.com/a.png",
        bytes: payload.length,
        contentType: "text/html",
        blobData: null,
        storageKey: "crawl-media/org-1/task-1/result-1/file.bin",
        width: null,
        height: null,
        alt: null,
        title: null,
        desc: null,
        poster: null,
        format: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        orgId: "org-1",
        taskId: "task-1"
      }
    ]);

    const grouped = await service.listAssetsByResultIds(["result-1"], {
      orgId: "org-1",
      userId: "user-1"
    });
    const first = grouped.get("result-1")?.[0];
    expect(first?.contentType).toBe("application/octet-stream");
    expect(first?.previewUrl).toBeUndefined();
    expect(first?.downloadUrl).toBe("https://signed.example.com/file-download.bin");
    expect(storage.createObjectReadUrl).toHaveBeenCalledWith(
      "crawl-media/org-1/task-1/result-1/file.bin",
      expect.objectContaining({
        responseContentType: "application/octet-stream",
        responseContentDisposition: expect.stringContaining("attachment")
      })
    );
  });

  it("treats svg as download-only in list views", async () => {
    const service = new CrawlMediaAssetService(prisma, storageSettings, storage, env);
    const payload = Buffer.from("<svg></svg>");

    prisma.crawlMediaAsset.findMany.mockResolvedValue([
      {
        id: "asset-svg",
        resultId: "result-1",
        provider: "mysql",
        kind: "image",
        sourceUrl: "https://example.com/a.svg",
        bytes: payload.length,
        contentType: "image/svg+xml",
        blobData: payload,
        storageKey: null,
        width: null,
        height: null,
        alt: null,
        title: null,
        desc: null,
        poster: null,
        format: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        orgId: "org-1",
        taskId: "task-1"
      }
    ]);

    const grouped = await service.listAssetsByResultIds(["result-1"], {
      orgId: "org-1",
      userId: "user-1"
    });
    const first = grouped.get("result-1")?.[0];
    expect(first?.contentType).toBe("image/svg+xml");
    expect(first?.previewUrl).toBeUndefined();
    expect(first?.downloadUrl).toMatch(
      /^\/api\/crawl-media-assets\/asset-svg\/download\?exp=\d+&org=org-1&user=user-1&sig=/
    );
  });

  it("forces attachment disposition for svg preview delivery in s3 mode", async () => {
    const service = new CrawlMediaAssetService(prisma, storageSettings, storage, env);
    prisma.crawlMediaAsset.findFirst.mockResolvedValue({
      id: "asset-svg",
      resultId: "result-1",
      provider: "s3",
      kind: "image",
      sourceUrl: "https://example.com/a.svg",
      bytes: 11,
      contentType: "image/svg+xml",
      blobData: null,
      storageKey: "crawl-media/org-1/task-1/result-1/file.svg",
      width: null,
      height: null,
      alt: null,
      title: null,
      desc: null,
      poster: null,
      format: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      orgId: "org-1",
      taskId: "task-1"
    });
    storage.createObjectReadUrl.mockResolvedValue("https://signed.example.com/file.svg");

    const payload = await service.getAssetDeliveryPayload("asset-svg", "preview", {
      orgId: "org-1"
    });

    expect(payload).toMatchObject({
      contentType: "image/svg+xml",
      inlineSafe: false,
      bytes: 11
    });
    expect(storage.createObjectReadUrl).toHaveBeenCalledWith(
      "crawl-media/org-1/task-1/result-1/file.svg",
      expect.objectContaining({
        responseContentType: "image/svg+xml",
        responseContentDisposition: expect.stringContaining("attachment")
      })
    );
  });

  it("fails fast when s3 upload fails", async () => {
    storageSettings.getCrawlImageStorageProvider.mockResolvedValue("s3");
    storage.uploadObject.mockRejectedValue(new Error("Storage configuration is incomplete"));
    const service = new CrawlMediaAssetService(prisma, storageSettings, storage, env);

    await expect(
      service.storeAsset({
        orgId: "org-1",
        taskId: "task-1",
        resultId: "result-1",
        kind: "image",
        sourceUrl: "https://example.com/a.png",
        bytes: 5,
        data: Buffer.from("hello"),
        contentType: "image/png"
      })
    ).rejects.toThrow("Storage configuration is incomplete");

    expect(prisma.crawlMediaAsset.create).not.toHaveBeenCalled();
  });

  it("cleans up orphan S3 object when DB write fails after upload", async () => {
    storageSettings.getCrawlImageStorageProvider.mockResolvedValue("s3");
    storage.uploadObject.mockResolvedValue({
      objectKey: "crawl-media/org-1/task-1/result-1/file.png"
    });
    prisma.crawlMediaAsset.create.mockRejectedValue(new Error("DB write failed"));
    const service = new CrawlMediaAssetService(prisma, storageSettings, storage, env);

    await expect(
      service.storeAsset({
        orgId: "org-1",
        taskId: "task-1",
        resultId: "result-1",
        kind: "image",
        sourceUrl: "https://example.com/a.png",
        bytes: 5,
        data: Buffer.from("hello"),
        contentType: "image/png"
      })
    ).rejects.toThrow("DB write failed");

    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });
});
