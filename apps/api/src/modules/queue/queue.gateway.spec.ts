import { sign } from "jsonwebtoken";

import type { AuthenticatedUser } from "../auth/auth.service";
import { UserSessionManager } from "../websocket/user-session-manager.service";

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

    const gateway = new QueueGateway(env, authService, accessTokenBlacklist, queueEvents, sessions);
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
});
