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
          orgId: "org-1"
        }
      })
    } as any;

    const normalQueue = {
      getJob: jest.fn().mockResolvedValue({
        data: {
          orgId: "org-1"
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
        data: { prev: "waiting" }
      })
    );
    expect(listener).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        event: "FAILED",
        jobId: "job-normal",
        queueName: "crawl4ai-normal",
        data: { reason: "boom" }
      })
    );
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
