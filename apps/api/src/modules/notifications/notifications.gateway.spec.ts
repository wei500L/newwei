import jwt from "jsonwebtoken";

import type { AuthenticatedUser } from "../auth/auth.service";
import { NotificationsGateway } from "./notifications.gateway";

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

const jwtConfig = {
  secret: "test-secret-1234567890",
  issuer: "test-issuer",
  audience: "test-audience"
};

function createToken(userId: string, orgId: string) {
  return jwt.sign(
    { sub: userId, orgId, permissions: [] },
    jwtConfig.secret,
    { issuer: jwtConfig.issuer, audience: jwtConfig.audience, jwtid: "jti-1" }
  );
}

function createClient(params: { id: string; token: string; ip?: string }) {
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
    join: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn()
  } as any;
}

describe("NotificationsGateway", () => {
  it("enforces max connections per user", async () => {
    const profile: AuthenticatedUser = {
      id: "user-1",
      orgId: "org-1",
      email: "user@example.com",
      roleIds: [],
      permissions: [],
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
    const dispatcher = { registerListener: jest.fn() } as any;

    const gateway = new NotificationsGateway(env, authService, accessTokenBlacklist, dispatcher);
    const token = createToken(profile.id, profile.orgId);

    const client1 = createClient({ id: "s1", token });
    await gateway.handleConnection(client1);
    expect(client1.join).toHaveBeenCalledTimes(1);
    expect(client1.disconnect).not.toHaveBeenCalled();

    const client2 = createClient({ id: "s2", token });
    await gateway.handleConnection(client2);
    expect(client2.join).not.toHaveBeenCalled();
    expect(client2.emit).toHaveBeenCalledWith("notification:error", { message: "Too many connections" });
    expect(client2.disconnect).toHaveBeenCalledWith(true);

    const connectionsByUserId = (gateway as any).connectionsByUserId as Map<string, Set<string>>;
    expect(connectionsByUserId.get(profile.id)?.size).toBe(1);
  });

  it("rate limits connection attempts per IP", async () => {
    const profile: AuthenticatedUser = {
      id: "user-1",
      orgId: "org-1",
      email: "user@example.com",
      roleIds: [],
      permissions: [],
      firstName: "Test",
      lastName: "User"
    };

    const env = {
      jwtConfig,
      graphqlConfig: { corsOrigin: undefined },
      webSocketSecurity: {
        maxConnectionsPerUser: 50,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 1,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60
      }
    } as any;

    const authService = { getUserProfile: jest.fn().mockResolvedValue(profile) } as any;
    const accessTokenBlacklist = { has: jest.fn().mockResolvedValue(false) } as any;
    const dispatcher = { registerListener: jest.fn() } as any;

    const gateway = new NotificationsGateway(env, authService, accessTokenBlacklist, dispatcher);
    const token = createToken(profile.id, profile.orgId);

    const client1 = createClient({ id: "s1", token, ip: "10.0.0.1" });
    await gateway.handleConnection(client1);
    expect(client1.disconnect).not.toHaveBeenCalled();

    const client2 = createClient({ id: "s2", token, ip: "10.0.0.1" });
    await gateway.handleConnection(client2);
    expect(client2.emit).toHaveBeenCalledWith("notification:error", { message: "Too many connection attempts" });
    expect(client2.disconnect).toHaveBeenCalledWith(true);
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
        connectRateLimitWindowSeconds: 60
      }
    } as any;

    const authService = { getUserProfile: jest.fn() } as any;
    const accessTokenBlacklist = { has: jest.fn() } as any;
    const dispatcher = { registerListener: jest.fn() } as any;

    const gateway = new NotificationsGateway(env, authService, accessTokenBlacklist, dispatcher);

    const socket1 = { id: "s1", disconnect: jest.fn() };
    const socket2 = { id: "s2", disconnect: jest.fn() };
    (gateway as any).server = { sockets: new Map([["s1", socket1], ["s2", socket2]]) };
    const unsubscribe = jest.fn();
    (gateway as any).unsubscribe = unsubscribe;
    (gateway as any).connectionsByUserId.set("user-1", new Set(["s1"]));

    await gateway.onModuleDestroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(socket1.disconnect).toHaveBeenCalledWith(true);
    expect(socket2.disconnect).toHaveBeenCalledWith(true);
    expect(((gateway as any).connectionsByUserId as Map<string, Set<string>>).size).toBe(0);
  });
});
