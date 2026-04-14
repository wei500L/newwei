import { RealtimeSocketErrorCode } from "@modular/utils";
import { sign } from "jsonwebtoken";

import type { WsConnectionRateLimiterService } from "../websocket/ws-connection-rate-limiter.service";

import { QualityGateway } from "./quality.gateway";

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

describe("QualityGateway", () => {
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

  const publisherMock = {
    registerListener: jest.fn(() => () => undefined),
  } as any;

  const sessionsMock = {
    register: jest.fn(),
    unregister: jest.fn(),
    orgRoom: jest.fn((orgId: string) => `org:${orgId}`),
  } as any;

  const connectionRateLimiterMock = {
    checkConnectionRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
    getBackoffDelay: jest.fn().mockResolvedValue(0),
    clearBackoff: jest.fn().mockResolvedValue(undefined),
    recordFailedAuth: jest.fn().mockResolvedValue(undefined),
  } as Partial<WsConnectionRateLimiterService>;

  let gateway: QualityGateway;

  beforeEach(() => {
    jest.resetAllMocks();
    publisherMock.registerListener.mockImplementation(() => () => undefined);
    accessTokenBlacklistMock.has.mockResolvedValue(false);
    connectionRateLimiterMock.checkConnectionRateLimit = jest
      .fn()
      .mockResolvedValue({ allowed: true });
    connectionRateLimiterMock.getBackoffDelay = jest
      .fn()
      .mockResolvedValue(0);
    connectionRateLimiterMock.clearBackoff = jest
      .fn()
      .mockResolvedValue(undefined);
    connectionRateLimiterMock.recordFailedAuth = jest
      .fn()
      .mockResolvedValue(undefined);
    gateway = new QualityGateway(
      envMock,
      authServiceMock,
      accessTokenBlacklistMock,
      publisherMock,
      publisherMock,
      publisherMock,
      publisherMock,
      publisherMock,
      sessionsMock,
      connectionRateLimiterMock as WsConnectionRateLimiterService,
    );
    gateway.server = { to: jest.fn(() => ({ emit: jest.fn() })) } as any;
  });

  function createToken(
    overrides?: Partial<{ permissions: string[]; orgId: string; sub: string }>,
  ) {
    return sign(
      {
        sub: overrides?.sub ?? "user-1",
        orgId: overrides?.orgId ?? "org-1",
        permissions: overrides?.permissions ?? ["settings.manage"],
      },
      envMock.jwtConfig.secret,
      {
        audience: envMock.jwtConfig.audience,
        issuer: envMock.jwtConfig.issuer,
      },
    );
  }

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

  it("maps rate-limit failures to stable websocket error codes", async () => {
    (
      connectionRateLimiterMock.checkConnectionRateLimit as jest.Mock
    ).mockResolvedValue({ allowed: false, retryAfterMs: 60000 });

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("quality:error", {
      code: RealtimeSocketErrorCode.RateLimitExceeded,
      message: "Rate limit exceeded",
      retryAfterMs: 60000,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it("maps auth-backoff failures to stable websocket error codes", async () => {
    (connectionRateLimiterMock.getBackoffDelay as jest.Mock).mockResolvedValue(
      8000,
    );

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("quality:error", {
      code: RealtimeSocketErrorCode.TooManyFailedAttempts,
      message: "Too many failed attempts",
      retryAfterMs: 8000,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it("maps session capacity failures to stable websocket error codes", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: ["settings.manage"],
    });
    sessionsMock.register.mockRejectedValue(new Error("Too many connections"));

    const client = createClient(createToken());

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("quality:error", {
      code: RealtimeSocketErrorCode.TooManyConnections,
      message: "Too many connections",
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(connectionRateLimiterMock.recordFailedAuth).not.toHaveBeenCalled();
  });

  it("maps permission/auth failures to unauthorized websocket error codes", async () => {
    authServiceMock.getUserProfile.mockResolvedValue({
      id: "user-1",
      orgId: "org-1",
      permissions: [],
    });

    const client = createClient(createToken({ permissions: [] }));

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("quality:error", {
      code: RealtimeSocketErrorCode.Unauthorized,
      message: "Unauthorized",
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(connectionRateLimiterMock.recordFailedAuth).toHaveBeenCalledWith(
      "127.0.0.1",
    );
  });
});
