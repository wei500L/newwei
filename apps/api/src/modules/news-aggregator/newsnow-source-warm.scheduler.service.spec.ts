import { NewsnowSourceWarmSchedulerService } from "./newsnow-source-warm.scheduler.service";

describe("NewsnowSourceWarmSchedulerService", () => {
  const activeSources = {
    getAllActiveSourceIds: jest.fn(),
  };
  const aggregator = {
    fetchSource: jest.fn(),
  };

  let service: NewsnowSourceWarmSchedulerService;

  beforeEach(() => {
    jest.resetAllMocks();
    activeSources.getAllActiveSourceIds.mockReturnValue([
      "weibo",
      "hackernews",
      "baidu",
    ]);
    aggregator.fetchSource.mockResolvedValue(undefined);
    service = new NewsnowSourceWarmSchedulerService(
      activeSources as never,
      aggregator as never,
    );
  });

  it("warms each active source without forcing refresh", async () => {
    await service.refreshScheduled();

    expect(activeSources.getAllActiveSourceIds).toHaveBeenCalledTimes(1);
    expect(aggregator.fetchSource).toHaveBeenCalledTimes(3);
    expect(aggregator.fetchSource).toHaveBeenNthCalledWith(1, "weibo", false);
    expect(aggregator.fetchSource).toHaveBeenNthCalledWith(
      2,
      "hackernews",
      false,
    );
    expect(aggregator.fetchSource).toHaveBeenNthCalledWith(3, "baidu", false);
  });

  it("continues warming remaining sources after one failure", async () => {
    aggregator.fetchSource
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);

    await service.refreshScheduled();

    expect(aggregator.fetchSource).toHaveBeenCalledTimes(3);
  });

  it("skips scheduler work when there are no active sources", async () => {
    activeSources.getAllActiveSourceIds.mockReturnValue([]);

    await service.refreshScheduled();

    expect(aggregator.fetchSource).not.toHaveBeenCalled();
  });
});
