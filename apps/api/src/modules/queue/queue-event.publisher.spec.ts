jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
  }),
}));

import { QueueEventPublisher } from "./queue-event.publisher";

describe("QueueEventPublisher", () => {
  const createContext = () => {
    const handlers: Record<string, (...args: any[]) => Promise<void> | void> = {};

    const events = {
      on: jest.fn((event: string, handler: (...args: any[]) => Promise<void> | void) => {
        handlers[event] = handler;
      }),
      off: jest.fn(),
    } as any;

    const queue = {
      getJob: jest.fn().mockResolvedValue({
        data: {
          orgId: "org-1",
          pipelineJobId: "pipeline-1",
          sourceId: "source-1",
          rawItemId: "raw-1",
          itemMetaId: "meta-1",
          processedItemId: "processed-1",
        },
      }),
    } as any;

    const publisher = new QueueEventPublisher(events, queue);

    return { publisher, events, queue, handlers };
  };

  it("publishes enriched pipeline payload from queue job data", async () => {
    const { publisher, handlers } = createContext();
    const listener = jest.fn();
    publisher.registerListener(listener);

    await handlers.active?.({ jobId: "job-1", prev: "waiting" });

    expect(listener).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        event: "ACTIVE",
        jobId: "job-1",
        data: { prev: "waiting" },
        pipelineJobId: "pipeline-1",
        sourceId: "source-1",
        rawItemId: "raw-1",
        itemMetaId: "meta-1",
        processedItemId: "processed-1",
      }),
    );
  });

  it("falls back to cached org context when completed jobs are removed", async () => {
    const { publisher, handlers, queue } = createContext();
    const listener = jest.fn();
    publisher.registerListener(listener);

    queue.getJob = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          orgId: "org-1",
          pipelineJobId: "pipeline-2",
          sourceId: "source-2",
          rawItemId: "raw-2",
          itemMetaId: "meta-2",
          processedItemId: "processed-2",
        },
      })
      .mockResolvedValueOnce(null);

    await handlers.active?.({ jobId: "job-2", prev: "waiting" });
    await handlers.failed?.({ jobId: "job-2", failedReason: "boom" });

    expect(listener).toHaveBeenNthCalledWith(
      1,
      "org-1",
      expect.objectContaining({
        event: "ACTIVE",
        jobId: "job-2",
        pipelineJobId: "pipeline-2",
      }),
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      "org-1",
      expect.objectContaining({
        event: "FAILED",
        jobId: "job-2",
        data: { reason: "boom" },
        pipelineJobId: "pipeline-2",
        sourceId: "source-2",
      }),
    );
    expect((publisher as any).orgCache.has("job-2")).toBe(false);
  });

  it("prunes expired cached job context during later writes", () => {
    const { publisher } = createContext();
    const dateNowSpy = jest.spyOn(Date, "now");

    dateNowSpy.mockReturnValue(0);
    (publisher as any).setCachedJobContext("job-expired", { orgId: "org-old" });

    dateNowSpy.mockReturnValue(550_000);
    (publisher as any).setCachedJobContext("job-fresh", { orgId: "org-fresh" });

    dateNowSpy.mockReturnValue(610_000);
    (publisher as any).setCachedJobContext("job-new", { orgId: "org-new" });

    expect((publisher as any).orgCache.has("job-expired")).toBe(false);
    expect((publisher as any).orgCache.get("job-fresh")).toMatchObject({
      orgId: "org-fresh",
    });
    expect((publisher as any).orgCache.get("job-new")).toMatchObject({
      orgId: "org-new",
    });
    dateNowSpy.mockRestore();
  });

  it("unbinds queue event handlers on module destroy", async () => {
    const { publisher, events } = createContext();

    await publisher.onModuleDestroy();

    expect(events.off).toHaveBeenCalledTimes(4);
    expect(events.off).toHaveBeenCalledWith("active", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("completed", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("failed", expect.any(Function));
  });
});
