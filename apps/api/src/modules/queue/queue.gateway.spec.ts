import { sign } from "jsonwebtoken";

import type { AuthenticatedUser } from "../auth/auth.service";
import { UserSessionManager } from "../websocket/user-session-manager.service";
import type { WsConnectionRateLimiterService } from "../websocket/ws-connection-rate-limiter.service";

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  };
});

jest.mock("./queue-event.publisher", () => ({
  QueueEventPublisher: class QueueEventPublisher {}
}));

const jwtConfig = {
  secret: "test-secret-1234567890",
  issuer: "test-issuer",
  audience: "test-audience"
};

function createToken(userId: string, orgId: string) {
  return sign(
    { sub: userId, orgId, permissions: ["queue.manage"] },
    jwtConfig.secret,
    { issuer: jwtConfig.issuer, audience: jwtConfig.audience, jwtid: "jti-1" }
  );
}

function createFakeServer() {
  const rooms = new Map<string, Set<string>>();

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
        allSockets: async () => new Set(rooms.get(room) ?? [])
      };
    },
    to() {
      return { emit: jest.fn() };
    }
  } as any;
}

function createClient(server: ReturnType<typeof createFakeServer>, params: { id: string; token: string; ip?: string }) {
  const ip = params.ip ?? "127.0.0.1";
  return {
    id: params.id,
    data: {},
    handshake: {
      headers: {
        origin: "http://localhost:3000",
        "x-forwarded-for": ip
      },
      auth: { token: params.token },
      query: {},
      address: ip
    },
    join: jest.fn(async (rooms: string[]) => {
      server.addToRooms(params.id, rooms);
    }),
    emit: jest.fn(),
    disconnect: jest.fn(() => {
      server.removeSocket(params.id);
    })
  } as any;
}

function createMockRateLimiter(overrides?: Partial<WsConnectionRateLimiterService>): WsConnectionRateLimiterService {
  return {
    checkConnectionRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
    recordFailedAuth: jest.fn().mockResolvedValue(undefined),
    getBackoffDelay: jest.fn().mockResolvedValue(0),
    clearBackoff: jest.fn().mockResolvedValue(undefined),
    ...overrides
  } as any;
}

describe("QueueGateway", () => {
  it("enforces max connections per user", async () => {
    const { QueueGateway } = require("./queue.gateway") as typeof import("./queue.gateway");

    const profile: AuthenticatedUser = {
      id: "user-1",
      orgId: "org-1",
      email: "user@example.com",
      roleIds: [],
      permissions: ["queue.manage"],
      firstName: "Test",
      lastName: "User"
    };

    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 1,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 999,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60
      }
    } as any;

    const authService = { getUserProfile: jest.fn().mockResolvedValue(profile) } as any;
    const accessTokenBlacklist = { has: jest.fn().mockResolvedValue(false) } as any;
    const queueEvents = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);

    const gateway = new QueueGateway(env, authService, accessTokenBlacklist, queueEvents, sessions, createMockRateLimiter());
    const server = createFakeServer();
    (gateway as any).server = server;

    const token = createToken(profile.id, profile.orgId);

    const client1 = createClient(server, { id: "s1", token });
    await gateway.handleConnection(client1);
    expect(client1.disconnect).not.toHaveBeenCalled();

    const client2 = createClient(server, { id: "s2", token });
    await gateway.handleConnection(client2);
    expect(client2.emit).toHaveBeenCalledWith("queue:error", { message: "Too many connections" });
    expect(client2.disconnect).toHaveBeenCalledWith(true);
  });

  it("rejects connection when rate limit exceeded", async () => {
    const { QueueGateway } = require("./queue.gateway") as typeof import("./queue.gateway");

    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 5,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 60,
        connectRateLimitPerUser: 30,
        connectRateLimitWindowSeconds: 60
      }
    } as any;

    const authService = { getUserProfile: jest.fn() } as any;
    const accessTokenBlacklist = { has: jest.fn() } as any;
    const queueEvents = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);

    const rateLimiter = createMockRateLimiter({
      checkConnectionRateLimit: jest.fn().mockResolvedValue({ allowed: false, retryAfterMs: 60000 })
    });

    const gateway = new QueueGateway(env, authService, accessTokenBlacklist, queueEvents, sessions, rateLimiter);
    const server = createFakeServer();
    (gateway as any).server = server;

    const token = createToken("user-1", "org-1");
    const client = createClient(server, { id: "s1", token, ip: "192.168.1.100" });

    await gateway.handleConnection(client);

    expect(rateLimiter.checkConnectionRateLimit).toHaveBeenCalledWith("192.168.1.100");
    expect(client.emit).toHaveBeenCalledWith("queue:error", { message: "Rate limit exceeded", retryAfterMs: 60000 });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    // Auth should not be attempted when rate limited
    expect(authService.getUserProfile).not.toHaveBeenCalled();
  });

  it("rejects connection when in backoff period", async () => {
    const { QueueGateway } = require("./queue.gateway") as typeof import("./queue.gateway");

    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 5,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 60,
        connectRateLimitPerUser: 30,
        connectRateLimitWindowSeconds: 60
      }
    } as any;

    const authService = { getUserProfile: jest.fn() } as any;
    const accessTokenBlacklist = { has: jest.fn() } as any;
    const queueEvents = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);

    const rateLimiter = createMockRateLimiter({
      checkConnectionRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
      getBackoffDelay: jest.fn().mockResolvedValue(8000) // 8 seconds backoff
    });

    const gateway = new QueueGateway(env, authService, accessTokenBlacklist, queueEvents, sessions, rateLimiter);
    const server = createFakeServer();
    (gateway as any).server = server;

    const token = createToken("user-1", "org-1");
    const client = createClient(server, { id: "s1", token, ip: "192.168.1.100" });

    await gateway.handleConnection(client);

    expect(rateLimiter.getBackoffDelay).toHaveBeenCalledWith("192.168.1.100");
    expect(client.emit).toHaveBeenCalledWith("queue:error", { message: "Too many failed attempts", retryAfterMs: 8000 });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    // Auth should not be attempted when in backoff
    expect(authService.getUserProfile).not.toHaveBeenCalled();
  });

  it("records failed auth and applies backoff", async () => {
    const { QueueGateway } = require("./queue.gateway") as typeof import("./queue.gateway");

    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 5,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 60,
        connectRateLimitPerUser: 30,
        connectRateLimitWindowSeconds: 60
      }
    } as any;

    const authService = { getUserProfile: jest.fn().mockRejectedValue(new Error("User not found")) } as any;
    const accessTokenBlacklist = { has: jest.fn().mockResolvedValue(false) } as any;
    const queueEvents = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);

    const rateLimiter = createMockRateLimiter();

    const gateway = new QueueGateway(env, authService, accessTokenBlacklist, queueEvents, sessions, rateLimiter);
    const server = createFakeServer();
    (gateway as any).server = server;

    const token = createToken("user-1", "org-1");
    const client = createClient(server, { id: "s1", token, ip: "192.168.1.100" });

    await gateway.handleConnection(client);

    expect(rateLimiter.recordFailedAuth).toHaveBeenCalledWith("192.168.1.100");
    expect(client.emit).toHaveBeenCalledWith("queue:error", { message: "Unauthorized" });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it("clears backoff on successful authentication", async () => {
    const { QueueGateway } = require("./queue.gateway") as typeof import("./queue.gateway");

    const profile: AuthenticatedUser = {
      id: "user-1",
      orgId: "org-1",
      email: "user@example.com",
      roleIds: [],
      permissions: ["queue.manage"],
      firstName: "Test",
      lastName: "User"
    };

    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 5,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 60,
        connectRateLimitPerUser: 30,
        connectRateLimitWindowSeconds: 60
      }
    } as any;

    const authService = { getUserProfile: jest.fn().mockResolvedValue(profile) } as any;
    const accessTokenBlacklist = { has: jest.fn().mockResolvedValue(false) } as any;
    const queueEvents = { registerListener: jest.fn() } as any;
    const sessions = new UserSessionManager(env as any);

    const rateLimiter = createMockRateLimiter();

    const gateway = new QueueGateway(env, authService, accessTokenBlacklist, queueEvents, sessions, rateLimiter);
    const server = createFakeServer();
    (gateway as any).server = server;

    const token = createToken(profile.id, profile.orgId);
    const client = createClient(server, { id: "s1", token, ip: "192.168.1.100" });

    await gateway.handleConnection(client);

    expect(rateLimiter.clearBackoff).toHaveBeenCalledWith("192.168.1.100");
    expect(client.emit).toHaveBeenCalledWith("queue:connected", { orgId: profile.orgId, userId: profile.id });
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});
