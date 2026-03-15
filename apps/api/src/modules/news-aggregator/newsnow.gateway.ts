import {
  createLogger,
  RealtimeSocketErrorCode,
  type RealtimeSocketErrorPayload,
} from "@modular/utils";
import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { verify } from "jsonwebtoken";
import { Server, Socket } from "socket.io";

import { AccessTokenBlacklistService } from "../auth/access-token-blacklist.service";
import {
  AuthService,
  AuthenticatedUser,
  JwtPayload,
} from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import { UserSessionManager } from "../websocket/user-session-manager.service";

import {
  NewsnowRealtimeDispatcher,
  NewsnowRealtimeEvent,
} from "./newsnow-realtime.dispatcher";

interface RateLimitState {
  windowStartMs: number;
  count: number;
}

@WebSocketGateway({
  namespace: "newsnow",
  cors: {
    origin: true,
    credentials: true,
  },
})
export class NewsnowGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = createLogger({ name: "newsnow-gateway" });
  private unsubscribe?: () => void;
  private readonly connectAttemptsByIp = new Map<string, RateLimitState>();
  private readonly connectAttemptsByUserId = new Map<string, RateLimitState>();

  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly dispatcher: NewsnowRealtimeDispatcher,
    private readonly sessions: UserSessionManager,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.dispatcher.registerListener(async (event) =>
      this.broadcast(event),
    );
  }

  async onModuleDestroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.connectAttemptsByIp.clear();
    this.connectAttemptsByUserId.clear();
  }

  async handleConnection(client: Socket) {
    const ip = this.extractClientIp(client);
    try {
      if (!this.isOriginAllowed(this.extractOrigin(client))) {
        throw new Error("Origin not allowed");
      }

      this.enforceConnectRateLimit(
        this.connectAttemptsByIp,
        ip ? `ip:${ip}` : "ip:unknown",
        this.env.webSocketSecurity.connectRateLimitPerIp,
      );

      const token = this.extractToken(client);
      const payload = this.verifyToken(token);
      this.enforceConnectRateLimit(
        this.connectAttemptsByUserId,
        `user:${payload.sub}`,
        this.env.webSocketSecurity.connectRateLimitPerUser,
      );
      await this.ensureNotRevoked(payload);
      const profile = await this.authService.getUserProfile(
        payload.sub,
        payload.orgId,
      );
      if (!profile.permissions.includes("items.read")) {
        throw new Error("Insufficient permissions");
      }

      client.data.user = profile;
      client.data.clientIp = ip;

      const { userConnections } = await this.sessions.register(
        this.server,
        client,
        {
          userId: profile.id,
          orgId: profile.orgId,
          ip,
        },
      );
      client.emit("newsnow:connected", {
        orgId: profile.orgId,
        userId: profile.id,
      });
      this.logger.info(
        {
          socketId: client.id,
          orgId: profile.orgId,
          userId: profile.id,
          ip,
          userConnections,
        },
        "NewsNow socket connected",
      );
    } catch (error) {
      this.sessions.unregister(client);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const responseMessage =
        errorMessage === "Too many connections" ||
        errorMessage === "Too many connection attempts"
          ? errorMessage
          : "Unauthorized";
      this.logger.warn(
        { socketId: client.id, ip, error: errorMessage },
        "NewsNow socket authentication failed",
      );
      client.emit("newsnow:error", this.toSocketErrorPayload(responseMessage));
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const profile = client.data?.user as AuthenticatedUser | undefined;
    this.sessions.unregister(client);
    this.logger.info(
      {
        socketId: client.id,
        userId: profile?.id,
        orgId: profile?.orgId,
        ip: client.data?.clientIp,
      },
      "NewsNow socket disconnected",
    );
  }

  private async broadcast(event: NewsnowRealtimeEvent) {
    if (!this.server) {
      return;
    }
    if (typeof event.orgId === "string" && event.orgId.trim().length > 0) {
      this.sessions.emitToOrg(
        this.server,
        event.orgId,
        "newsnow:update",
        event,
      );
      return;
    }
    this.server.emit("newsnow:update", event);
  }

  private verifyToken(token: string): JwtPayload {
    const jwtConfig = this.env.jwtConfig;
    const decoded = verify(token, jwtConfig.secret, {
      audience: jwtConfig.audience,
      issuer: jwtConfig.issuer,
    });
    if (!decoded || typeof decoded === "string") {
      throw new Error("Invalid token");
    }
    const payload = decoded as Partial<JwtPayload>;
    if (!payload.sub || typeof payload.sub !== "string") {
      throw new Error("Invalid token payload");
    }
    if (!payload.orgId || typeof payload.orgId !== "string") {
      throw new Error("Invalid token payload");
    }
    const permissions = Array.isArray(payload.permissions)
      ? payload.permissions.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return {
      sub: payload.sub,
      orgId: payload.orgId,
      permissions,
      jti: typeof payload.jti === "string" ? payload.jti : undefined,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
      iat: typeof payload.iat === "number" ? payload.iat : undefined,
    };
  }

  private async ensureNotRevoked(payload: JwtPayload) {
    if (payload.jti) {
      const revoked = await this.accessTokenBlacklist.has(payload.jti);
      if (revoked) {
        throw new Error("Token revoked");
      }
    }
  }

  private extractToken(client: Socket): string {
    const headerAuth = client.handshake.headers.authorization;
    const tokenFromHeader = this.parseAuthorizationHeader(headerAuth);
    if (tokenFromHeader) {
      return tokenFromHeader;
    }
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === "string" && authToken.length > 0) {
      return authToken;
    }
    const queryToken = client.handshake.query?.token;
    if (typeof queryToken === "string" && queryToken.length > 0) {
      return queryToken;
    }
    if (
      Array.isArray(queryToken) &&
      queryToken.length > 0 &&
      typeof queryToken[0] === "string"
    ) {
      return queryToken[0];
    }
    throw new Error("Missing auth token");
  }

  private parseAuthorizationHeader(authHeader: string | string[] | undefined) {
    if (!authHeader) {
      return undefined;
    }
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (typeof headerValue !== "string") {
      return undefined;
    }
    const trimmed = headerValue.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      return trimmed.slice(7);
    }
    return undefined;
  }

  private enforceConnectRateLimit(
    map: Map<string, RateLimitState>,
    key: string,
    limit: number,
  ) {
    const windowMs =
      this.env.webSocketSecurity.connectRateLimitWindowSeconds * 1000;
    const now = Date.now();
    const current = map.get(key);
    if (!current || now - current.windowStartMs >= windowMs) {
      map.set(key, { windowStartMs: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      throw new Error("Too many connection attempts");
    }
  }

  private toSocketErrorPayload(
    errorMessage: string,
  ): RealtimeSocketErrorPayload {
    if (errorMessage === "Too many connections") {
      return {
        code: RealtimeSocketErrorCode.TooManyConnections,
        message: "Too many connections",
      };
    }
    if (errorMessage === "Too many connection attempts") {
      return {
        code: RealtimeSocketErrorCode.TooManyConnectionAttempts,
        message: "Too many connection attempts",
      };
    }
    return {
      code: RealtimeSocketErrorCode.Unauthorized,
      message: "Unauthorized",
    };
  }

  private extractOrigin(client: Socket) {
    const originHeader =
      client.handshake.headers.origin ?? client.handshake.headers.referer;
    const raw = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = new URL(raw);
      return parsed.origin;
    } catch {
      return raw;
    }
  }

  private isOriginAllowed(origin?: string | null) {
    if (!origin) {
      return true;
    }
    const corsConfig = this.env.graphqlConfig.corsOrigin;
    if (!corsConfig) {
      return true;
    }
    const allowed = corsConfig
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        try {
          return new URL(entry).origin;
        } catch {
          return entry;
        }
      });
    return allowed.length === 0 || allowed.includes(origin);
  }

  private extractClientIp(client: Socket) {
    const forwardedHeader = client.handshake.headers["x-forwarded-for"];
    const forwarded = Array.isArray(forwardedHeader)
      ? forwardedHeader[0]
      : forwardedHeader;
    const ipFromForwarded = forwarded?.split(",")[0]?.trim();
    const address =
      typeof client.handshake.address === "string"
        ? client.handshake.address
        : undefined;
    const ip = ipFromForwarded || address;
    return ip ? ip.replace(/^::ffff:/, "") : undefined;
  }
}
