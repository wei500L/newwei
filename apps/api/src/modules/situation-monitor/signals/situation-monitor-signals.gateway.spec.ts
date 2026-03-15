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

  const sessionsMock = {
    register: jest.fn(),
    unregister: jest.fn(),
  } as any;

  let gateway: SituationMonitorSignalsGateway;

  beforeEach(() => {
    jest.resetAllMocks();
    dispatcherMock.registerListener.mockImplementation(() => jest.fn());
    gateway = new SituationMonitorSignalsGateway(
      envMock,
      authServiceMock,
      accessTokenBlacklistMock,
      dispatcherMock,
      sessionsMock,
    );
    gateway.server = {
      to: jest.fn(() => ({ emit: jest.fn() })),
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
});
