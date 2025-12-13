import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { Server, Socket } from "socket.io";

import { EnvService } from "../config/config.service";

export interface UserSession {
  userId: string;
  orgId: string;
  ip?: string;
}

export interface RegisterSessionResult {
  userConnections: number;
  ipConnections?: number;
}

@Injectable()
export class UserSessionManager {
  private readonly logger = createLogger({ name: "user-session-manager" });

  constructor(private readonly env: EnvService) {}

  async register(server: Server, client: Socket, session: UserSession): Promise<RegisterSessionResult> {
    client.data.userSession = session;

    const { maxConnectionsPerUser, maxConnectionsPerIp } = this.env.webSocketSecurity;
    const existingUserConnections = await this.getRoomConnectionCount(server, this.userRoom(session.userId));
    if (existingUserConnections >= maxConnectionsPerUser) {
      throw new Error("Too many connections");
    }

    let existingIpConnections: number | undefined;
    if (session.ip) {
      existingIpConnections = await this.getRoomConnectionCount(server, this.ipRoom(session.ip));
      if (existingIpConnections >= maxConnectionsPerIp) {
        throw new Error("Too many connections");
      }
    }

    const rooms = [this.orgRoom(session.orgId), this.userRoom(session.userId)];
    if (session.ip) {
      rooms.push(this.ipRoom(session.ip));
    }
    await client.join(rooms);

    return {
      userConnections: existingUserConnections + 1,
      ipConnections: session.ip ? (existingIpConnections ?? 0) + 1 : undefined
    };
  }

  unregister(client: Socket) {
    if (client.data) {
      client.data.userSession = undefined;
    }
  }

  async isUserOnline(server: Server, userId: string) {
    return (await this.getRoomConnectionCount(server, this.userRoom(userId))) > 0;
  }

  emitToUser<TPayload>(server: Server, userId: string, event: string, payload: TPayload) {
    server.to(this.userRoom(userId)).emit(event, payload);
  }

  emitToOrg<TPayload>(server: Server, orgId: string, event: string, payload: TPayload) {
    server.to(this.orgRoom(orgId)).emit(event, payload);
  }

  orgRoom(orgId: string) {
    return `org:${orgId}`;
  }

  userRoom(userId: string) {
    return `user:${userId}`;
  }

  ipRoom(ip: string) {
    return `ip:${ip}`;
  }

  private async getRoomConnectionCount(server: Server, room: string) {
    try {
      const socketIds = await server.in(room).allSockets();
      return socketIds.size;
    } catch (error) {
      this.logger.warn(
        { room, error: error instanceof Error ? error.message : String(error) },
        "Failed to fetch socket room size"
      );
      return 0;
    }
  }
}
