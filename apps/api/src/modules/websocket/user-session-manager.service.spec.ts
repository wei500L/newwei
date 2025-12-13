import { UserSessionManager } from "./user-session-manager.service";

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

function createClient(server: ReturnType<typeof createFakeServer>, socketId: string) {
  return {
    id: socketId,
    data: {},
    join: jest.fn(async (rooms: string[]) => {
      server.addToRooms(socketId, rooms);
    })
  } as any;
}

describe("UserSessionManager", () => {
  it("enforces max connections per user", async () => {
    const env = {
      webSocketSecurity: {
        maxConnectionsPerUser: 1,
        maxConnectionsPerIp: 50,
        connectRateLimitPerIp: 999,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60
      }
    } as any;
    const manager = new UserSessionManager(env);
    const server = createFakeServer();

    await manager.register(server, createClient(server, "s1"), { userId: "u1", orgId: "o1", ip: "10.0.0.1" });
    await expect(
      manager.register(server, createClient(server, "s2"), { userId: "u1", orgId: "o1", ip: "10.0.0.2" })
    ).rejects.toThrow("Too many connections");
  });

  it("enforces max connections per IP", async () => {
    const env = {
      webSocketSecurity: {
        maxConnectionsPerUser: 50,
        maxConnectionsPerIp: 1,
        connectRateLimitPerIp: 999,
        connectRateLimitPerUser: 999,
        connectRateLimitWindowSeconds: 60
      }
    } as any;
    const manager = new UserSessionManager(env);
    const server = createFakeServer();

    await manager.register(server, createClient(server, "s1"), { userId: "u1", orgId: "o1", ip: "10.0.0.1" });
    await expect(
      manager.register(server, createClient(server, "s2"), { userId: "u2", orgId: "o1", ip: "10.0.0.1" })
    ).rejects.toThrow("Too many connections");
  });
});

