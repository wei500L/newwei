jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

interface MockRedisInstance {
  options: Record<string, unknown>;
  status: string;
  on: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
}

const mockRedisInstances: MockRedisInstance[] = [];
const mockRedisConstructor = jest.fn((options: Record<string, unknown>) => {
  const instance: MockRedisInstance = {
    options,
    status: "ready",
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue("OK"),
    disconnect: jest.fn(),
  };
  mockRedisInstances.push(instance);
  return instance;
});

jest.mock("ioredis", () => ({
  __esModule: true,
  default: mockRedisConstructor,
}));

import { BullmqConnectionService } from "./bullmq-connection.service";

const env = {
  redisConfig: {
    host: "redis",
    port: 6379,
    username: "default",
    password: "secret",
    db: 2,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
  },
} as any;

describe("BullmqConnectionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisInstances.length = 0;
  });

  it("reuses one shared BullMQ Redis client", () => {
    const service = new BullmqConnectionService(env);

    const first = service.getSharedConnection();
    const second = service.getSharedConnection();

    expect(first).toBe(second);
    expect(mockRedisConstructor).toHaveBeenCalledTimes(1);
    expect(mockRedisInstances[0].options).toEqual(
      expect.objectContaining({
        host: "redis",
        port: 6379,
        db: 2,
        enableAutoPipelining: true,
        maxRetriesPerRequest: null,
        connectionName: expect.stringContaining("bullmq:shared"),
      }),
    );
    expect(mockRedisInstances[0].on).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });

  it("builds dedicated BullMQ connection options without creating a client", () => {
    const service = new BullmqConnectionService(env);

    expect(service.createDedicatedConnectionOptions("events:queue name")).toEqual(
      expect.objectContaining({
        host: "redis",
        port: 6379,
        db: 2,
        maxRetriesPerRequest: null,
        connectionName: expect.stringContaining("events:queue-name"),
      }),
    );
    expect(mockRedisConstructor).not.toHaveBeenCalled();
  });

  it("quits the shared client on shutdown", async () => {
    const service = new BullmqConnectionService(env);
    const connection = service.getSharedConnection() as unknown as MockRedisInstance;

    await service.shutdown();

    expect(connection.quit).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).not.toHaveBeenCalled();

    service.getSharedConnection();
    expect(mockRedisConstructor).toHaveBeenCalledTimes(2);
  });

  it("disconnects the shared client when graceful quit fails", async () => {
    const service = new BullmqConnectionService(env);
    const connection = service.getSharedConnection() as unknown as MockRedisInstance;
    connection.quit.mockRejectedValueOnce(new Error("quit failed"));

    await service.shutdown();

    expect(connection.quit).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});
