import { RealtimeSocketErrorCode } from "@modular/utils";
import { sign } from "jsonwebtoken";

import { SITUATION_MONITOR_GLOBAL_SIGNALS_ROOM } from "./situation-monitor-signals.constants";
import { SituationMonitorSignalsGateway } from "./situation-monitor-signals.gateway";

describe("SituationMonitorSignalsGateway", () => {
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
      connectRateLimitPerIp: 10,
      connectRateLimitPerUser: 1,
      connectRateLimitWindowSeconds: 60,
    },
  } as any;

  const authServiceMock = {
    getUserProfile: jest.fn(),
  } as any;

  const accessTokenBlacklistMock = {
    has: jest.fn().mockResolvedValue(false),
  } as any;

  const dispatcherMock = {
    registerListener: jest.fn(() => jest.fn()),
  } as any;

  const monitorsMock = {
    augmentTelegramRealtimePayload: jest.fn(),
    augmentOrefRealtimePayload: jest.fn(),
  } as any;

  const sessionsMock = {
    register: jest.fn(),
    emitToUser: jest.fn(),
    unregister: jest.fn(),
  } as any;

  const moduleRefMock = {
    get: jest.fn(),
  } as any;

  let gateway: SituationMonitorSignalsGateway;

  beforeEach(() => {
    jest.resetAllMocks();
    dispatcherMock.registerListener.mockImplementation(() => jest.fn());
    moduleRefMock.get.mockReturnValue(monitorsMock);
    gateway = new SituationMonitorSignalsGateway(
      envMock,
      authServiceMock,
      accessTokenBlacklistMock,
      dispatcherMock,
      sessionsMock,
      moduleRefMock,
    );
    gateway.server = {
      sockets: {
        sockets: new Map(),
      },
    } as any;
  });

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

  function createClient(token: string, id = "socket-1") {
    return {
      id,
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
      join: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("connects authenticated sockets and joins the global room", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: ["items.read"],
    });
    sessionsMock.register.mockResolvedValue({ userConnections: 1 });

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(client.join).toHaveBeenCalledWith(
      SITUATION_MONITOR_GLOBAL_SIGNALS_ROOM,
    );
    expect(client.emit).toHaveBeenCalledWith("situation:connected", {
      orgId: "org-1",
      userId: "user-1",
    });
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("maps unauthorized failures to stable websocket error codes", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: [],
    });

    const client = createClient(createToken({ permissions: [] }));

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("situation:error", {
      code: RealtimeSocketErrorCode.Unauthorized,
      message: "Unauthorized",
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(sessionsMock.unregister).toHaveBeenCalledWith(client);
  });

  it("maps connection-attempt throttling to stable websocket error codes", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: ["items.read"],
    });
    sessionsMock.register.mockResolvedValue({ userConnections: 1 });

    const firstClient = createClient(createToken(), "socket-1");
    await gateway.handleConnection(firstClient);

    const secondClient = createClient(createToken(), "socket-2");
    await gateway.handleConnection(secondClient);

    expect(secondClient.emit).toHaveBeenCalledWith("situation:error", {
      code: RealtimeSocketErrorCode.TooManyConnectionAttempts,
      message: "Too many connection attempts",
    });
    expect(secondClient.disconnect).toHaveBeenCalledWith(true);
  });

  it("broadcasts per-user monitor-augmented realtime payloads", async () => {
    gateway.onModuleInit();
    const listener = dispatcherMock.registerListener.mock.calls[0]?.[0];
    expect(typeof listener).toBe("function");

    const socketA = createClient(createToken(), "socket-a");
    socketA.data.user = {
      id: "user-1",
      orgId: "org-1",
      permissions: ["items.read"],
    };
    const socketB = createClient(createToken(), "socket-b");
    socketB.data.user = {
      id: "user-1",
      orgId: "org-1",
      permissions: ["items.read"],
    };
    const socketC = createClient(
      createToken({ sub: "user-2", orgId: "org-2" }),
      "socket-c",
    );
    socketC.data.user = {
      id: "user-2",
      orgId: "org-2",
      permissions: ["items.read"],
    };
    gateway.server.sockets.sockets = new Map([
      [socketA.id, socketA],
      [socketB.id, socketB],
      [socketC.id, socketC],
    ]);

    monitorsMock.augmentTelegramRealtimePayload
      .mockResolvedValueOnce({
        count: 1,
        updatedAt: "2026-03-22T00:00:00.000Z",
        items: [],
        monitorMatches: [{ itemKey: "telegram:item-1", monitorId: "m-1" }],
      })
      .mockResolvedValueOnce({
        count: 1,
        updatedAt: "2026-03-22T00:00:00.000Z",
        items: [],
        monitorMatches: [{ itemKey: "telegram:item-1", monitorId: "m-2" }],
      });

    await listener({
      type: "situation:telegram.update",
      timestamp: "2026-03-22T00:00:00.000Z",
      payload: {
        count: 1,
        updatedAt: "2026-03-22T00:00:00.000Z",
        items: [],
      },
    });

    expect(monitorsMock.augmentTelegramRealtimePayload).toHaveBeenCalledTimes(2);
    expect(monitorsMock.augmentTelegramRealtimePayload).toHaveBeenNthCalledWith(
      1,
      "org-1",
      "user-1",
      expect.objectContaining({ count: 1 }),
    );
    expect(monitorsMock.augmentTelegramRealtimePayload).toHaveBeenNthCalledWith(
      2,
      "org-2",
      "user-2",
      expect.objectContaining({ count: 1 }),
    );
    expect(sessionsMock.emitToUser).toHaveBeenCalledTimes(2);
    expect(sessionsMock.emitToUser).toHaveBeenCalledWith(
      gateway.server,
      "user-1",
      "situation:telegram.update",
      expect.objectContaining({
        monitorMatches: [{ itemKey: "telegram:item-1", monitorId: "m-1" }],
      }),
    );
    expect(sessionsMock.emitToUser).toHaveBeenCalledWith(
      gateway.server,
      "user-2",
      "situation:telegram.update",
      expect.objectContaining({
        monitorMatches: [{ itemKey: "telegram:item-1", monitorId: "m-2" }],
      }),
    );
  });
});
