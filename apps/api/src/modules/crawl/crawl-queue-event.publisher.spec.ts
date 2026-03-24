jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn()
  })
}));

import { CrawlQueueEventPublisher } from "./crawl-queue-event.publisher";

describe("CrawlQueueEventPublisher", () => {
  const createContext = () => {
    const hotHandlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
    const normalHandlers: Record<string, (...args: any[]) => Promise<void> | void> = {};

    const hotEvents = {
      on: jest.fn((event: string, handler: (...args: any[]) => Promise<void> | void) => {
        hotHandlers[event] = handler;
      }),
      off: jest.fn()
    } as any;

    const normalEvents = {
      on: jest.fn((event: string, handler: (...args: any[]) => Promise<void> | void) => {
        normalHandlers[event] = handler;
      }),
      off: jest.fn()
    } as any;

    const hotQueue = {
      getJob: jest.fn().mockResolvedValue({
        data: {
          orgId: "org-1",
          taskId: "task-hot",
          priorityClass: "hot",
          sourcePriority: 90
        }
      })
    } as any;

    const normalQueue = {
      getJob: jest.fn().mockResolvedValue({
        data: {
          orgId: "org-1",
          taskId: "task-normal",
          priorityClass: "normal",
          sourcePriority: 10
        }
      })
    } as any;

    const publisher = new CrawlQueueEventPublisher(
      hotEvents,
      normalEvents,
      hotQueue,
      normalQueue
    );

    return {
      publisher,
      hotEvents,
      normalEvents,
      hotQueue,
      normalQueue,
      hotHandlers,
      normalHandlers
    };
  };

  it("publishes events from both hot and normal queues", async () => {
    const { publisher, hotHandlers, normalHandlers } = createContext();
    const listener = jest.fn();
    publisher.registerListener(listener);

    await hotHandlers.active?.({ jobId: "job-hot", prev: "waiting" });
    await normalHandlers.failed?.({ jobId: "job-normal", failedReason: "boom" });

    expect(listener).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        event: "ACTIVE",
        jobId: "job-hot",
        queueName: "crawl4ai-hot",
        data: { prev: "waiting" },
        taskId: "task-hot",
        priorityClass: "hot",
        sourcePriority: 90
      })
    );
    expect(listener).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        event: "FAILED",
        jobId: "job-normal",
        queueName: "crawl4ai-normal",
        data: { reason: "boom" },
        taskId: "task-normal",
        priorityClass: "normal",
        sourcePriority: 10
      })
    );
  });

  it("falls back to cached crawl context for terminal events and clears it afterward", async () => {
    const { publisher, hotHandlers, hotQueue } = createContext();
    const listener = jest.fn();
    publisher.registerListener(listener);

    hotQueue.getJob = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          orgId: "org-1",
          taskId: "task-hot-cache",
          priorityClass: "hot",
          sourcePriority: 90,
        },
      })
      .mockResolvedValueOnce(null);

    await hotHandlers.active?.({ jobId: "job-hot-cache", prev: "waiting" });
    await hotHandlers.failed?.({
      jobId: "job-hot-cache",
      failedReason: "boom",
    });

    expect(listener).toHaveBeenNthCalledWith(
      2,
      "org-1",
      expect.objectContaining({
        event: "FAILED",
        jobId: "job-hot-cache",
        taskId: "task-hot-cache",
      }),
    );
    expect((publisher as any).orgCache.has("crawl4ai-hot:job-hot-cache")).toBe(
      false,
    );
  });

  it("prunes expired crawl job context during later writes", () => {
    const { publisher } = createContext();
    const dateNowSpy = jest.spyOn(Date, "now");

    dateNowSpy.mockReturnValue(0);
    (publisher as any).setCachedJobContext("hot:expired", { orgId: "org-old" });

    dateNowSpy.mockReturnValue(550_000);
    (publisher as any).setCachedJobContext("hot:fresh", { orgId: "org-fresh" });

    dateNowSpy.mockReturnValue(610_000);
    (publisher as any).setCachedJobContext("hot:new", { orgId: "org-new" });

    expect((publisher as any).orgCache.has("hot:expired")).toBe(false);
    expect((publisher as any).orgCache.get("hot:fresh")).toMatchObject({
      orgId: "org-fresh",
    });
    expect((publisher as any).orgCache.get("hot:new")).toMatchObject({
      orgId: "org-new",
    });
    dateNowSpy.mockRestore();
  });

  it("unbinds queue event handlers on module destroy", async () => {
    const { publisher, hotEvents, normalEvents } = createContext();

    await publisher.onModuleDestroy();

    expect(hotEvents.off).toHaveBeenCalledTimes(4);
    expect(normalEvents.off).toHaveBeenCalledTimes(4);
    expect(hotEvents.off).toHaveBeenCalledWith("active", expect.any(Function));
    expect(hotEvents.off).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(hotEvents.off).toHaveBeenCalledWith("completed", expect.any(Function));
    expect(hotEvents.off).toHaveBeenCalledWith("failed", expect.any(Function));
    expect(normalEvents.off).toHaveBeenCalledWith("active", expect.any(Function));
    expect(normalEvents.off).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(normalEvents.off).toHaveBeenCalledWith("completed", expect.any(Function));
    expect(normalEvents.off).toHaveBeenCalledWith("failed", expect.any(Function));
  });
});
