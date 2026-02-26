import {
  __testing,
  backfillCrawlResultFingerprints,
  createResumeStore,
  parseCliArgsFromArgs,
  parseResumeState,
} from "../../scripts/backfill-canonical-url-fingerprints";

describe("backfill-canonical-url-fingerprints script helpers", () => {
  it("parses resume flags and disables resume in dry-run mode", () => {
    const parsed = parseCliArgsFromArgs([
      "--dry-run",
      "--resume-key=my-key",
      "--reset-resume",
      "--batch-size=1200",
      "--max-rows=200",
      "--org-id=org-1",
    ]);
    expect(parsed).toMatchObject({
      dryRun: true,
      useResume: false,
      resetResume: false,
      resumeKey: "my-key",
      batchSize: 1200,
      maxRows: 200,
      orgId: "org-1",
    });
  });

  it("falls back to empty resume state when org does not match", () => {
    const parsed = parseResumeState(
      {
        version: 1,
        orgId: "org-other",
        updatedAt: "2026-01-01T00:00:00.000Z",
        cursorByStage: { crawlResult: "cursor-1" },
      },
      "org-1",
    );
    expect(parsed.orgId).toBe("org-1");
    expect(parsed.cursorByStage).toEqual({});
  });

  it("persists and clears stage cursor in resume store", async () => {
    let stored: unknown = null;
    const prisma = {
      systemSetting: {
        findUnique: jest.fn(async () =>
          stored === null ? null : { value: stored },
        ),
        upsert: jest.fn(async ({ create, update }: any) => {
          stored = create?.value ?? update?.value ?? null;
          return { key: "k" };
        }),
        deleteMany: jest.fn(async () => {
          stored = null;
          return { count: 1 };
        }),
      },
    } as any;
    const options = {
      dryRun: false,
      batchSize: 100,
      maxRows: undefined,
      orgId: "org-1",
      useResume: true,
      resetResume: false,
      resumeKey: "org-1",
    };
    const store = await createResumeStore(prisma, options);
    expect(store).toBeTruthy();

    await store?.saveCursor("crawlResult", "cursor-a");
    await store?.saveCursor("article", "cursor-b");
    await store?.clearCursor("article");
    expect(store?.snapshot().cursorByStage).toEqual({
      crawlResult: "cursor-a",
    });
  });

  it("falls back to id>cursor scan when stale cursor cannot be resolved", async () => {
    const resumeStore = {
      settingKey: "k",
      getCursor: jest.fn().mockReturnValue("stale-cursor"),
      saveCursor: jest.fn().mockResolvedValue(undefined),
      clearCursor: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
      snapshot: jest.fn().mockReturnValue({}),
    } as any;
    const prisma = {
      crawlResult: {
        findMany: jest
          .fn()
          .mockRejectedValueOnce({
            code: "P2025",
            message: "Record to search for not found.",
          })
          .mockResolvedValueOnce([
            {
              id: "id-2",
              sourceUrl: "https://example.com/a",
              sourceUrlFingerprint: "old",
              metadata: null,
            },
          ])
          .mockResolvedValueOnce([]),
        update: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    const options = {
      dryRun: true,
      batchSize: 100,
      maxRows: undefined,
      orgId: undefined,
      useResume: true,
      resetResume: false,
      resumeKey: "all-orgs",
    };

    const result = await backfillCrawlResultFingerprints(
      prisma,
      options,
      resumeStore,
    );

    expect(__testing.isCursorNotFoundError({ code: "P2025" })).toBe(true);
    expect(resumeStore.clearCursor).toHaveBeenCalledWith("crawlResult");
    expect(prisma.crawlResult.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { gt: "stale-cursor" },
        }),
      }),
    );
    expect(result.completed).toBe(true);
    expect(result.stats.scanned).toBe(1);
  });
});
