import { NewsnowRealtimeDispatcher } from "./newsnow-realtime.dispatcher";

describe("NewsnowRealtimeDispatcher", () => {
  let dispatcher: NewsnowRealtimeDispatcher;

  beforeEach(() => {
    dispatcher = new NewsnowRealtimeDispatcher();
  });

  it("publishes org-scoped events with a timestamp", async () => {
    const listener = jest.fn();
    dispatcher.registerListener(listener);

    await dispatcher.publish({
      orgId: " org-1 ",
      sourceId: "weibo",
      newItemsCount: 2,
      topTitles: ["a", "b"],
      updatedTime: "2026-01-01T00:00:00.000Z",
      intervalMs: 120000,
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        sourceId: "weibo",
        newItemsCount: 2,
        timestamp: expect.any(String),
      }),
    );
  });

  it("drops events without a non-empty orgId", async () => {
    const listener = jest.fn();
    dispatcher.registerListener(listener);

    await dispatcher.publish({
      orgId: " ",
      sourceId: "weibo",
      newItemsCount: 2,
      topTitles: [],
      updatedTime: "2026-01-01T00:00:00.000Z",
      intervalMs: 120000,
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
