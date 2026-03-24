jest.mock("@modular/mongo", () => ({
  disconnectMongo: jest.fn(),
}));

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  };
});

import { disconnectMongo } from "@modular/mongo";

import { ApplicationShutdownService } from "./application-shutdown.service";

describe("ApplicationShutdownService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("disconnects Mongo and the websocket adapter registry only once", async () => {
    const webSocketAdapterRegistry = {
      disconnectRedisIoAdapter: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new ApplicationShutdownService(webSocketAdapterRegistry);

    await service.onApplicationShutdown("SIGTERM");
    await service.onApplicationShutdown("SIGINT");

    expect(disconnectMongo).toHaveBeenCalledTimes(1);
    expect(
      webSocketAdapterRegistry.disconnectRedisIoAdapter,
    ).toHaveBeenCalledTimes(1);
  });

  it("continues shutdown when resource teardown fails", async () => {
    (disconnectMongo as jest.Mock).mockRejectedValueOnce(
      new Error("mongo failed"),
    );
    const webSocketAdapterRegistry = {
      disconnectRedisIoAdapter: jest
        .fn()
        .mockRejectedValueOnce(new Error("redis adapter failed")),
    } as any;

    const service = new ApplicationShutdownService(webSocketAdapterRegistry);

    await expect(
      service.onApplicationShutdown("SIGTERM"),
    ).resolves.toBeUndefined();
  });
});
