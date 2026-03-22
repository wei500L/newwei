jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn()
  })
}));

jest.mock("@modular/mongo", () => ({
  AnalysisResultModel: {
    findById: jest.fn()
  }
}));

import { AnalysisQueueEventPublisher } from "./analysis-queue-event.publisher";

describe("AnalysisQueueEventPublisher", () => {
  const createPublisher = () => {
    const handlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
    const events = {
      on: jest.fn((event: string, handler: (...args: any[]) => Promise<void> | void) => {
        handlers[event] = handler;
      }),
      off: jest.fn()
    } as any;
    const queue = {
      getJob: jest.fn()
    } as any;
    const publisher = new AnalysisQueueEventPublisher(events, queue);

    return { publisher, events, handlers, queue };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("prunes expired org cache entries during later cache writes", () => {
    const { publisher } = createPublisher();
    const dateNowSpy = jest.spyOn(Date, "now");

    dateNowSpy.mockReturnValue(0);
    (publisher as any).setCachedOrgId("job-expired", "org-old");

    dateNowSpy.mockReturnValue(550_000);
    (publisher as any).setCachedOrgId("job-fresh", "org-fresh");

    dateNowSpy.mockReturnValue(610_000);
    (publisher as any).setCachedOrgId("job-new", "org-new");

    expect((publisher as any).orgCache.has("job-expired")).toBe(false);
    expect((publisher as any).orgCache.get("job-fresh")).toMatchObject({ orgId: "org-fresh" });
    expect((publisher as any).orgCache.get("job-new")).toMatchObject({ orgId: "org-new" });
  });

  it("publishes queue events using resolved org context", async () => {
    const { publisher, handlers, queue } = createPublisher();
    const listener = jest.fn();
    publisher.registerListener(listener);
    queue.getJob.mockResolvedValue({
      data: {
        orgId: "org-1"
      }
    });

    await handlers.active?.({ jobId: "job-1", prev: "waiting" });

    expect(listener).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        event: "ACTIVE",
        jobId: "job-1",
        data: { prev: "waiting" }
      })
    );
  });

  it("unbinds queue event handlers on module destroy", async () => {
    const { publisher, events } = createPublisher();

    await publisher.onModuleDestroy();

    expect(events.off).toHaveBeenCalledTimes(4);
    expect(events.off).toHaveBeenCalledWith("active", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("completed", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("failed", expect.any(Function));
  });
});
