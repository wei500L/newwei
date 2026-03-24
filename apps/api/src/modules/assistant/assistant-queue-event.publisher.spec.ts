jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@modular/mongo", () => ({
  AssistantRunModel: {
    findById: jest.fn(),
  },
}));

import { AssistantQueueEventPublisher } from "./assistant-queue-event.publisher";

describe("AssistantQueueEventPublisher", () => {
  const createPublisher = () => {
    const handlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
    const events = {
      on: jest.fn((event: string, handler: (...args: any[]) => Promise<void> | void) => {
        handlers[event] = handler;
      }),
      off: jest.fn(),
    } as any;
    const queue = {
      getJob: jest.fn(),
    } as any;
    const publisher = new AssistantQueueEventPublisher(events, queue);

    return { publisher, events, handlers, queue };
  };

  it("falls back to cached org context for terminal events and clears it afterward", async () => {
    const { publisher, handlers, queue } = createPublisher();
    const listener = jest.fn();
    publisher.registerListener(listener);

    queue.getJob
      .mockResolvedValueOnce({ data: { orgId: "org-1" } })
      .mockResolvedValueOnce(null);

    await handlers.active?.({ jobId: "job-1", prev: "waiting" });
    await handlers.completed?.({ jobId: "job-1", returnvalue: { ok: true } });

    expect(listener).toHaveBeenNthCalledWith(
      2,
      "org-1",
      expect.objectContaining({
        event: "COMPLETED",
        jobId: "job-1",
        data: { ok: true },
      }),
    );
    expect((publisher as any).orgCache.has("job-1")).toBe(false);
  });

  it("prunes expired org cache entries during later writes", () => {
    const { publisher } = createPublisher();
    const dateNowSpy = jest.spyOn(Date, "now");

    dateNowSpy.mockReturnValue(0);
    (publisher as any).setCachedOrgId("job-expired", "org-old");

    dateNowSpy.mockReturnValue(550_000);
    (publisher as any).setCachedOrgId("job-fresh", "org-fresh");

    dateNowSpy.mockReturnValue(610_000);
    (publisher as any).setCachedOrgId("job-new", "org-new");

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
    const { publisher, events } = createPublisher();

    await publisher.onModuleDestroy();

    expect(events.off).toHaveBeenCalledTimes(4);
    expect(events.off).toHaveBeenCalledWith("active", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("progress", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("completed", expect.any(Function));
    expect(events.off).toHaveBeenCalledWith("failed", expect.any(Function));
  });
});
