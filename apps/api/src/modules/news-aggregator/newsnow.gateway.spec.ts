import { sign } from "jsonwebtoken";
import { RealtimeSocketErrorCode } from "@modular/utils";

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

  const serverMock = {
    emit: jest.fn(),
  } as any;

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
    gateway = new NewsnowGateway(
      envMock,
      authServiceMock,
      accessTokenBlacklistMock,
      dispatcherMock,
      sessionsMock,
    );
    gateway.server = serverMock;
  });

  function createClient(token: string) {
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
      emit: jest.fn(),
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
    expect(client.disconnect).not.toHaveBeenCalled();
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
});
