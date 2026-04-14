import { RealtimeSocketErrorCode } from "@modular/utils";
import { sign } from "jsonwebtoken";

import type { WsConnectionRateLimiterService } from "../websocket/ws-connection-rate-limiter.service";

import { NewsnowGateway } from "./newsnow.gateway";

describe("NewsnowGateway", () => {
  const envMock = {
    jwtConfig: {
      secret: "test-secret",
      audience: "test-audience",
      issuer: "test-issuer",
    },
    graphqlConfig: {
      corsOrigin: "http://localhost:3000",
    },
    webSocketSecurity: {
      connectRateLimitPerIp: 20,
      connectRateLimitPerUser: 20,
      connectRateLimitWindowSeconds: 60,
    },
  } as any;

  const authServiceMock = {
    getUserProfile: jest.fn(),
  } as any;

  const accessTokenBlacklistMock = {
    has: jest.fn().mockResolvedValue(false),
  } as any;

  let realtimeListener: ((event: any) => Promise<void>) | undefined;
  const dispatcherMock = {
    registerListener: jest.fn((listener: (event: any) => Promise<void>) => {
      realtimeListener = listener;
      return () => {
        realtimeListener = undefined;
      };
    }),
  } as any;

  const sessionsMock = {
    register: jest.fn(),
    unregister: jest.fn(),
  } as any;

  const registryServiceMock = {
    getMetadata: jest.fn().mockReturnValue({
      sources: {
        weibo: { name: "微博" },
        hackernews: { name: "Hacker News" },
      },
      columns: {},
    }),
  } as any;

  const activeSourcesMock = {
    setActiveSources: jest.fn(),
    removeSocket: jest.fn(),
  } as any;

  const serverMock = {
    emit: jest.fn(),
  } as any;

  const connectionRateLimiterMock = {
    checkConnectionRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
    checkUserConnectionRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
    recordFailedAuth: jest.fn().mockResolvedValue(undefined),
    getBackoffDelay: jest.fn().mockResolvedValue(0),
    clearBackoff: jest.fn().mockResolvedValue(undefined),
  } as Partial<WsConnectionRateLimiterService>;

  let gateway: NewsnowGateway;

  beforeEach(() => {
    jest.resetAllMocks();
    realtimeListener = undefined;
    dispatcherMock.registerListener.mockImplementation(
      (listener: (event: any) => Promise<void>) => {
        realtimeListener = listener;
        return () => {
          realtimeListener = undefined;
        };
      },
    );
    connectionRateLimiterMock.checkConnectionRateLimit = jest
      .fn()
      .mockResolvedValue({ allowed: true });
    connectionRateLimiterMock.checkUserConnectionRateLimit = jest
      .fn()
      .mockResolvedValue({ allowed: true });
    connectionRateLimiterMock.recordFailedAuth = jest
      .fn()
      .mockResolvedValue(undefined);
    connectionRateLimiterMock.getBackoffDelay = jest.fn().mockResolvedValue(0);
    connectionRateLimiterMock.clearBackoff = jest.fn().mockResolvedValue(undefined);
    registryServiceMock.getMetadata.mockReturnValue({
      sources: {
        weibo: { name: "微博" },
        hackernews: { name: "Hacker News" },
      },
      columns: {},
    });
    gateway = new NewsnowGateway(
      envMock,
      authServiceMock,
      accessTokenBlacklistMock,
      dispatcherMock,
      sessionsMock,
      registryServiceMock,
      activeSourcesMock,
      connectionRateLimiterMock as WsConnectionRateLimiterService,
    );
    gateway.server = serverMock;
  });

  function createClient(token: string) {
    const handlers: Record<string, (payload: any) => void> = {};
    return {
      id: "socket-1",
      handshake: {
        headers: {
          origin: "http://localhost:3000",
        },
        auth: { token },
        query: {},
        address: "::ffff:127.0.0.1",
      },
      data: {},
      handlers,
      emit: jest.fn(),
      on: jest.fn((event: string, handler: (payload: any) => void) => {
        handlers[event] = handler;
      }),
      disconnect: jest.fn(),
    } as any;
  }

  function createToken(
    overrides?: Partial<{ permissions: string[]; orgId: string; sub: string }>,
  ) {
    return sign(
      {
        sub: overrides?.sub ?? "user-1",
        orgId: overrides?.orgId ?? "org-1",
        permissions: overrides?.permissions ?? ["items.read"],
      },
      envMock.jwtConfig.secret,
      {
        audience: envMock.jwtConfig.audience,
        issuer: envMock.jwtConfig.issuer,
      },
    );
  }

  it("connects authenticated sockets and emits connected event", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: ["items.read"],
    });
    sessionsMock.register.mockResolvedValue({ userConnections: 1 });

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(authServiceMock.getUserProfile).toHaveBeenCalledWith(
      "user-1",
      "org-1",
    );
    expect(sessionsMock.register).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith("newsnow:connected", {
      orgId: "org-1",
      userId: "user-1",
    });
    expect(client.on).toHaveBeenCalledWith(
      "newsnow:set-active-sources",
      expect.any(Function),
    );
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(connectionRateLimiterMock.clearBackoff).toHaveBeenCalledWith(
      "127.0.0.1",
    );
  });

  it("rejects sockets without required permission", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: [],
    });

    const client = createClient(createToken({ permissions: [] }));

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("newsnow:error", {
      code: RealtimeSocketErrorCode.Unauthorized,
      message: "Unauthorized",
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(sessionsMock.unregister).toHaveBeenCalledWith(client);
    expect(connectionRateLimiterMock.recordFailedAuth).toHaveBeenCalledWith(
      "127.0.0.1",
    );
  });

  it("maps max-connection failures to stable websocket error codes", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: ["items.read"],
    });
    sessionsMock.register.mockRejectedValue(new Error("Too many connections"));

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("newsnow:error", {
      code: RealtimeSocketErrorCode.TooManyConnections,
      message: "Too many connections",
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(connectionRateLimiterMock.recordFailedAuth).not.toHaveBeenCalled();
  });

  it("maps IP rate-limit failures to stable websocket error codes", async () => {
    (
      connectionRateLimiterMock.checkConnectionRateLimit as jest.Mock
    ).mockResolvedValue({ allowed: false, retryAfterMs: 60000 });

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("newsnow:error", {
      code: RealtimeSocketErrorCode.RateLimitExceeded,
      message: "Rate limit exceeded",
      retryAfterMs: 60000,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it("maps auth backoff failures to stable websocket error codes", async () => {
    (
      connectionRateLimiterMock.getBackoffDelay as jest.Mock
    ).mockResolvedValue(8000);

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("newsnow:error", {
      code: RealtimeSocketErrorCode.TooManyFailedAttempts,
      message: "Too many failed attempts",
      retryAfterMs: 8000,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(authServiceMock.getUserProfile).not.toHaveBeenCalled();
  });

  it("maps user connection-attempt throttling to stable websocket error codes", async () => {
    (
      connectionRateLimiterMock.checkUserConnectionRateLimit as jest.Mock
    ).mockResolvedValue({ allowed: false, retryAfterMs: 60000 });

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("newsnow:error", {
      code: RealtimeSocketErrorCode.TooManyConnectionAttempts,
      message: "Too many connection attempts",
      retryAfterMs: 60000,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it("broadcasts realtime events received from dispatcher", async () => {
    gateway.onModuleInit();

    expect(dispatcherMock.registerListener).toHaveBeenCalledTimes(1);
    expect(realtimeListener).toBeDefined();

    await realtimeListener?.({
      sourceId: "weibo",
      newItemsCount: 2,
      topTitles: ["a", "b"],
      updatedTime: new Date().toISOString(),
      intervalMs: 120000,
      timestamp: new Date().toISOString(),
    });

    expect(serverMock.emit).toHaveBeenCalledWith(
      "newsnow:update",
      expect.objectContaining({ sourceId: "weibo", newItemsCount: 2 }),
    );
  });

  it("normalizes active source payloads from the socket", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: ["items.read"],
    });
    sessionsMock.register.mockResolvedValue({ userConnections: 1 });

    const client = createClient(createToken());

    await gateway.handleConnection(client);
    client.handlers["newsnow:set-active-sources"]?.({
      sourceIds: [" weibo ", "bad id", "missing", "hackernews", "weibo"],
    });

    expect(activeSourcesMock.setActiveSources).toHaveBeenCalledWith({
      socketId: "socket-1",
      orgId: "org-1",
      sourceIds: ["weibo", "hackernews"],
    });
  });

  it("clears active sources when sockets disconnect", () => {
    const client = createClient(createToken());
    client.data.user = {
      id: "user-1",
      orgId: "org-1",
      permissions: ["items.read"],
    };

    gateway.handleDisconnect(client);

    expect(activeSourcesMock.removeSocket).toHaveBeenCalledWith("socket-1");
    expect(sessionsMock.unregister).toHaveBeenCalledWith(client);
  });
});
