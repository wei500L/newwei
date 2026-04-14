import { NotificationSocketErrorCode } from "@modular/utils";
import { sign } from "jsonwebtoken";

import type { AuthenticatedUser } from "../auth/auth.service";
import { UserSessionManager } from "../websocket/user-session-manager.service";
import type { WsConnectionRateLimiterService } from "../websocket/ws-connection-rate-limiter.service";

import { NotificationsGateway } from "./notifications.gateway";

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

const jwtConfig = {
  secret: "test-secret-1234567890",
  issuer: "test-issuer",
  audience: "test-audience",
};

function createToken(userId: string, orgId: string) {
  return sign({ sub: userId, orgId, permissions: [] }, jwtConfig.secret, {
    issuer: jwtConfig.issuer,
    audience: jwtConfig.audience,
    jwtid: "jti-1",
  });
}

function createFakeServer() {
  const rooms = new Map<string, Set<string>>();
  const emit = jest.fn();

  return {
    addToRooms(socketId: string, roomList: string[]) {
      for (const room of roomList) {
        const set = rooms.get(room) ?? new Set<string>();
        set.add(socketId);
        rooms.set(room, set);
      }
    },
    removeSocket(socketId: string) {
      for (const set of rooms.values()) {
        set.delete(socketId);
      }
    },
    in(room: string) {
      return {
        allSockets: async () => new Set(rooms.get(room) ?? []),
      };
    },
    to() {
      return { emit };
    },
  } as any;
}

function createClient(
  server: ReturnType<typeof createFakeServer>,
  params: { id: string; token: string; ip?: string },
) {
  const ip = params.ip ?? "127.0.0.1";
  return {
    id: params.id,
    data: {},
    handshake: {
      headers: {
        origin: "http://localhost:3000",
        "x-forwarded-for": ip,
      },
      auth: { token: params.token },
      query: {},
      address: ip,
    },
    join: jest.fn(async (rooms: string[]) => {
      server.addToRooms(params.id, rooms);
    }),
    emit: jest.fn(),
    disconnect: jest.fn(() => {
      server.removeSocket(params.id);
    }),
  } as any;
}

function createMockRateLimiter(
  overrides?: Partial<WsConnectionRateLimiterService>,
): WsConnectionRateLimiterService {
  return {
    checkConnectionRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
    checkUserConnectionRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
    recordFailedAuth: jest.fn().mockResolvedValue(undefined),
    getBackoffDelay: jest.fn().mockResolvedValue(0),
    clearBackoff: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe("NotificationsGateway", () => {
  it("emits unauthorized error code when authentication fails", async () => {
    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 50,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 999,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60,
      },
    } as any;

    const authService = { getUserProfile: jest.fn() } as any;
    const accessTokenBlacklist = { has: jest.fn() } as any;
    const dispatcher = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);

    const gateway = new NotificationsGateway(
      env,
      authService,
      accessTokenBlacklist,
      dispatcher,
      sessions,
      createMockRateLimiter(),
    );
    const server = createFakeServer();
    (gateway as any).server = server;

    const client = createClient(server, {
      id: "s-unauthorized",
      token: "bad-token",
    });
    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("notification:error", {
      code: NotificationSocketErrorCode.Unauthorized,
      message: "Unauthorized",
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(
      (gateway as any).connectionRateLimiter.recordFailedAuth,
    ).toHaveBeenCalledWith("127.0.0.1");
  });

  it("enforces max connections per user", async () => {
    const profile: AuthenticatedUser = {
      id: "user-1",
      orgId: "org-1",
      email: "user@example.com",
      roleIds: [],
      permissions: [],
      firstName: "Test",
      lastName: "User",
    };

    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 1,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 999,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60,
      },
    } as any;

    const authService = {
      getUserProfile: jest.fn().mockResolvedValue(profile),
    } as any;
    const accessTokenBlacklist = {
      has: jest.fn().mockResolvedValue(false),
    } as any;
    const dispatcher = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);

    const gateway = new NotificationsGateway(
      env,
      authService,
      accessTokenBlacklist,
      dispatcher,
      sessions,
      createMockRateLimiter(),
    );
    const server = createFakeServer();
    (gateway as any).server = server;
    const token = createToken(profile.id, profile.orgId);

    const client1 = createClient(server, { id: "s1", token });
    await gateway.handleConnection(client1);
    expect(client1.join).toHaveBeenCalledTimes(1);
    expect(client1.disconnect).not.toHaveBeenCalled();
    expect(
      (gateway as any).connectionRateLimiter.clearBackoff,
    ).toHaveBeenCalledWith("127.0.0.1");

    const client2 = createClient(server, { id: "s2", token });
    await gateway.handleConnection(client2);
    expect(client2.join).not.toHaveBeenCalled();
    expect(client2.emit).toHaveBeenCalledWith("notification:error", {
      code: NotificationSocketErrorCode.TooManyConnections,
      message: "Too many connections",
    });
    expect(client2.disconnect).toHaveBeenCalledWith(true);
    expect(
      (gateway as any).connectionRateLimiter.recordFailedAuth,
    ).not.toHaveBeenCalled();
  });

  it("rate limits connection attempts per IP", async () => {
    const profile: AuthenticatedUser = {
      id: "user-1",
      orgId: "org-1",
      email: "user@example.com",
      roleIds: [],
      permissions: [],
      firstName: "Test",
      lastName: "User",
    };

    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 50,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 1,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60,
      },
    } as any;

    const authService = {
      getUserProfile: jest.fn().mockResolvedValue(profile),
    } as any;
    const accessTokenBlacklist = {
      has: jest.fn().mockResolvedValue(false),
    } as any;
    const dispatcher = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);
    const rateLimiter = createMockRateLimiter({
      checkConnectionRateLimit: jest
        .fn()
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false, retryAfterMs: 60000 }),
    });

    const gateway = new NotificationsGateway(
      env,
      authService,
      accessTokenBlacklist,
      dispatcher,
      sessions,
      rateLimiter,
    );
    const server = createFakeServer();
    (gateway as any).server = server;
    const token = createToken(profile.id, profile.orgId);

    const client1 = createClient(server, { id: "s1", token, ip: "10.0.0.1" });
    await gateway.handleConnection(client1);
    expect(client1.disconnect).not.toHaveBeenCalled();

    const client2 = createClient(server, { id: "s2", token, ip: "10.0.0.1" });
    await gateway.handleConnection(client2);
    expect(client2.emit).toHaveBeenCalledWith("notification:error", {
      code: NotificationSocketErrorCode.RateLimitExceeded,
      message: "Rate limit exceeded",
      retryAfterMs: 60000,
    });
    expect(client2.disconnect).toHaveBeenCalledWith(true);
    expect(rateLimiter.checkConnectionRateLimit).toHaveBeenNthCalledWith(
      2,
      "10.0.0.1",
    );
  });

  it("enforces auth backoff before token verification", async () => {
    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 50,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 999,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60,
      },
    } as any;

    const authService = { getUserProfile: jest.fn() } as any;
    const accessTokenBlacklist = { has: jest.fn() } as any;
    const dispatcher = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);
    const rateLimiter = createMockRateLimiter({
      getBackoffDelay: jest.fn().mockResolvedValue(8000),
    });

    const gateway = new NotificationsGateway(
      env,
      authService,
      accessTokenBlacklist,
      dispatcher,
      sessions,
      rateLimiter,
    );
    const server = createFakeServer();
    (gateway as any).server = server;
    const client = createClient(server, {
      id: "s-backoff",
      token: createToken("user-1", "org-1"),
      ip: "10.0.0.2",
    });

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("notification:error", {
      code: NotificationSocketErrorCode.TooManyFailedAttempts,
      message: "Too many failed attempts",
      retryAfterMs: 8000,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(authService.getUserProfile).not.toHaveBeenCalled();
  });

  it("preserves retryAfterMs for per-user connection throttling", async () => {
    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 50,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 999,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60,
      },
    } as any;

    const authService = { getUserProfile: jest.fn() } as any;
    const accessTokenBlacklist = { has: jest.fn().mockResolvedValue(false) } as any;
    const dispatcher = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);
    const rateLimiter = createMockRateLimiter({
      checkUserConnectionRateLimit: jest
        .fn()
        .mockResolvedValue({ allowed: false, retryAfterMs: 45000 }),
    });

    const gateway = new NotificationsGateway(
      env,
      authService,
      accessTokenBlacklist,
      dispatcher,
      sessions,
      rateLimiter,
    );
    const server = createFakeServer();
    (gateway as any).server = server;
    const client = createClient(server, {
      id: "s-user-throttle",
      token: createToken("user-1", "org-1"),
      ip: "10.0.0.3",
    });

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith("notification:error", {
      code: NotificationSocketErrorCode.TooManyConnectionAttempts,
      message: "Too many connection attempts",
      retryAfterMs: 45000,
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(authService.getUserProfile).not.toHaveBeenCalled();
  });

  it("disconnects existing clients on module destroy", async () => {
    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 50,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 999,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60,
      },
    } as any;

    const authService = { getUserProfile: jest.fn() } as any;
    const accessTokenBlacklist = { has: jest.fn() } as any;
    const dispatcher = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);

    const gateway = new NotificationsGateway(
      env,
      authService,
      accessTokenBlacklist,
      dispatcher,
      sessions,
      createMockRateLimiter(),
    );

    const socket1 = { id: "s1", disconnect: jest.fn() };
    const socket2 = { id: "s2", disconnect: jest.fn() };
    (gateway as any).server = {
      sockets: {
        sockets: new Map([
          ["s1", socket1],
          ["s2", socket2],
        ]),
      },
    };
    const unsubscribe = jest.fn();
    (gateway as any).unsubscribe = unsubscribe;

    await gateway.onModuleDestroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(socket1.disconnect).toHaveBeenCalledWith(true);
    expect(socket2.disconnect).toHaveBeenCalledWith(true);
  });
});
