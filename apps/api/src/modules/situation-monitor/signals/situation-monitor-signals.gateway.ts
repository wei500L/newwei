import {
  createLogger,
  RealtimeSocketErrorCode,
  type RealtimeSocketErrorPayload,
} from "@modular/utils";
import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { verify } from "jsonwebtoken";
import { Server, Socket } from "socket.io";

import { AccessTokenBlacklistService } from "../../auth/access-token-blacklist.service";
import {
  AuthService,
  type AuthenticatedUser,
  type JwtPayload,
} from "../../auth/auth.service";
import { EnvService } from "../../config/config.service";
import { SituationMonitorMonitorsService } from "../situation-monitor-monitors.service";
import { UserSessionManager } from "../../websocket/user-session-manager.service";
import { SITUATION_MONITOR_GLOBAL_SIGNALS_ROOM } from "./situation-monitor-signals.constants";
import { SituationMonitorSignalsDispatcher } from "./situation-monitor-signals.dispatcher";
import type {
  SituationMonitorRealtimeEvent,
  SituationOrefRealtimePayload,
  SituationTelegramRealtimePayload,
} from "./situation-monitor-signals.types";

interface RateLimitState {
  windowStartMs: number;
  count: number;
}

type SupportedSituationMonitorRealtimeEvent =
  | SituationMonitorRealtimeEvent<SituationTelegramRealtimePayload>
  | SituationMonitorRealtimeEvent<SituationOrefRealtimePayload>;

@WebSocketGateway({
  namespace: "situation-monitor",
  cors: {
    origin: true,
    credentials: true,
  },
})
export class SituationMonitorSignalsGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = createLogger({
    name: "situation-monitor-signals-gateway",
  });
  private unsubscribe?: () => void;
  private readonly connectAttemptsByIp = new Map<string, RateLimitState>();
  private readonly connectAttemptsByUserId = new Map<string, RateLimitState>();
  private monitors?: SituationMonitorMonitorsService;

  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly dispatcher: SituationMonitorSignalsDispatcher,
    private readonly sessions: UserSessionManager,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    try {
      this.monitors = this.moduleRef.get(SituationMonitorMonitorsService, {
        strict: false,
      });
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Situation monitor monitor matcher unavailable for realtime payload augmentation",
      );
    }
    this.unsubscribe = this.dispatcher.registerListener(async (event) =>
      this.broadcast(event as SupportedSituationMonitorRealtimeEvent),
    );
  }

  async onModuleDestroy() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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
      await client.join(SITUATION_MONITOR_GLOBAL_SIGNALS_ROOM);

      client.emit("situation:connected", {
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
        "Situation monitor socket connected",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const responseMessage =
        errorMessage === "Too many connections" ||
        errorMessage === "Too many connection attempts"
          ? errorMessage
          : "Unauthorized";
      this.sessions.unregister(client);
      this.logger.warn(
        { socketId: client.id, ip, error: errorMessage },
        "Situation monitor socket auth failed",
      );
      client.emit(
        "situation:error",
        this.toSocketErrorPayload(responseMessage),
      );
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
      "Situation monitor socket disconnected",
    );
  }

  private async broadcast(
    event: SupportedSituationMonitorRealtimeEvent,
  ) {
    if (!this.server) {
      return;
    }

    const users = this.getConnectedUsers();
    if (users.length === 0) {
      return;
    }

    await Promise.allSettled(
      users.map(async ({ orgId, userId }) => {
        const payload = await this.augmentPayloadForUser(event, orgId, userId);
        this.sessions.emitToUser(this.server, userId, event.type, payload);
      }),
    );
  }

  private async augmentPayloadForUser(
    event: SupportedSituationMonitorRealtimeEvent,
    orgId: string,
    userId: string,
  ) {
    if (!this.monitors) {
      return event.payload;
    }

    try {
      if (event.type === "situation:telegram.update") {
        const payload = event.payload as SituationTelegramRealtimePayload;
        return await this.monitors.augmentTelegramRealtimePayload(
          orgId,
          userId,
          payload,
        );
      }

      const payload = event.payload as SituationOrefRealtimePayload;
      return await this.monitors.augmentOrefRealtimePayload(
        orgId,
        userId,
        payload,
      );
    } catch (error) {
      this.logger.warn(
        {
          eventType: event.type,
          orgId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to augment situation monitor realtime payload",
      );
      return event.payload;
    }
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
    if (!payload.jti) {
      return;
    }
    const revoked = await this.accessTokenBlacklist.has(payload.jti);
    if (revoked) {
      throw new Error("Token revoked");
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

  private parseAuthorizationHeader(
    authHeader: string | string[] | undefined,
  ): string | undefined {
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

  private extractClientIp(client: Socket): string | undefined {
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

  private extractOrigin(client: Socket): string | undefined {
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
      return undefined;
    }
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) {
      return true;
    }

    const normalizedOrigin = origin.replace(/\/$/, "");
    const configured = this.env.graphqlConfig.corsOrigin;

    if (!configured) {
      return true;
    }

    const allowlist = String(configured)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/\/$/, ""));

    if (allowlist.includes("*")) {
      return true;
    }

    return allowlist.includes(normalizedOrigin);
  }

  private getConnectedUsers() {
    const sockets = this.server?.sockets?.sockets;
    if (!sockets) {
      return [] as Array<{ orgId: string; userId: string }>;
    }

    const users = new Map<string, { orgId: string; userId: string }>();
    for (const socket of sockets.values()) {
      const profile = socket.data?.user as AuthenticatedUser | undefined;
      if (!profile?.id || !profile.orgId) {
        continue;
      }
      users.set(`${profile.orgId}:${profile.id}`, {
        orgId: profile.orgId,
        userId: profile.id,
      });
    }
    return Array.from(users.values());
  }
}
