import { createLogger } from "@modular/utils";
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

import {
  isOriginAllowed as isOriginInAllowlist,
  parseCorsOriginAllowlist,
} from "../../../common/cors/cors-origin";
import { AccessTokenBlacklistService } from "../../auth/access-token-blacklist.service";
import {
  AuthService,
  type AuthenticatedUser,
  type JwtPayload,
} from "../../auth/auth.service";
import { EnvService } from "../../config/config.service";
import {
  isTrustProxyConfigured,
  resolveSocketClientIp,
} from "../../websocket/socket-client-ip";
import {
  buildRealtimeSocketErrorPayload,
  shouldRecordFailedSocketAuth,
} from "../../websocket/socket-error-payloads";
import {
  attachTokenRevalidation,
  cleanupTokenRevalidation,
} from "../../websocket/socket-token-revalidation";
import { UserSessionManager } from "../../websocket/user-session-manager.service";
import { WsConnectionRateLimiterService } from "../../websocket/ws-connection-rate-limiter.service";
import { SituationMonitorMonitorsService } from "../situation-monitor-monitors.service";

import { SITUATION_MONITOR_GLOBAL_SIGNALS_ROOM } from "./situation-monitor-signals.constants";
import { SituationMonitorSignalsDispatcher } from "./situation-monitor-signals.dispatcher";
import type {
  SituationMonitorRealtimeEvent,
  SituationOrefRealtimePayload,
  SituationTelegramRealtimePayload,
} from "./situation-monitor-signals.types";

type SupportedSituationMonitorRealtimeEvent =
  | SituationMonitorRealtimeEvent<SituationTelegramRealtimePayload>
  | SituationMonitorRealtimeEvent<SituationOrefRealtimePayload>;

const SITUATION_MONITOR_SIGNALS_NAMESPACE = "situation-monitor";

@WebSocketGateway({
  namespace: SITUATION_MONITOR_SIGNALS_NAMESPACE,
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
  private monitors?: SituationMonitorMonitorsService;

  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly dispatcher: SituationMonitorSignalsDispatcher,
    private readonly sessions: UserSessionManager,
    private readonly moduleRef: ModuleRef,
    private readonly connectionRateLimiter: WsConnectionRateLimiterService,
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
  }

  async handleConnection(client: Socket) {
    const ip = this.extractClientIp(client);

    try {
      const ipRateLimit =
        await this.connectionRateLimiter.checkConnectionRateLimit(ip ?? "");
      if (!ipRateLimit.allowed) {
        this.logger.warn(
          { socketId: client.id, ip },
          "Situation monitor socket connection rate limited",
        );
        client.emit(
          "situation:error",
          buildRealtimeSocketErrorPayload(
            "Rate limit exceeded",
            ipRateLimit.retryAfterMs,
          ),
        );
        client.disconnect(true);
        return;
      }

      const backoffDelay = await this.connectionRateLimiter.getBackoffDelay(
        ip ?? "",
      );
      if (backoffDelay > 0) {
        this.logger.warn(
          { socketId: client.id, ip, backoffDelay },
          "Situation monitor socket connection in backoff period",
        );
        client.emit(
          "situation:error",
          buildRealtimeSocketErrorPayload(
            "Too many failed attempts",
            backoffDelay,
          ),
        );
        client.disconnect(true);
        return;
      }

      if (!this.isOriginAllowed(this.extractOrigin(client))) {
        throw new Error("Origin not allowed");
      }

      const token = this.extractToken(client);
      const payload = this.verifyToken(token);

      const userRateLimit =
        await this.connectionRateLimiter.checkUserConnectionRateLimit(
          payload.sub,
        );
      if (!userRateLimit.allowed) {
        this.logger.warn(
          { socketId: client.id, ip, userId: payload.sub },
          "Situation monitor socket user connection attempts throttled",
        );
        client.emit(
          "situation:error",
          buildRealtimeSocketErrorPayload(
            "Too many connection attempts",
            userRateLimit.retryAfterMs,
          ),
        );
        client.disconnect(true);
        return;
      }

      await this.ensureNotRevoked(payload);
      const profile = await this.authService.getUserProfile(
        payload.sub,
        payload.orgId,
      );
      if (!profile.permissions.includes("items.read")) {
        throw new Error("Insufficient permissions");
      }
      await this.connectionRateLimiter.clearBackoff(ip ?? "");

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
      // Re-check revocation/expiry periodically: logout must cut the live socket.
      attachTokenRevalidation(client, payload, this.accessTokenBlacklist);


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
      if (shouldRecordFailedSocketAuth(errorMessage)) {
        await this.connectionRateLimiter.recordFailedAuth(ip ?? "");
      }
      this.sessions.unregister(client);
      this.logger.warn(
        { socketId: client.id, ip, error: errorMessage },
        "Situation monitor socket auth failed",
      );
      client.emit(
        "situation:error",
        buildRealtimeSocketErrorPayload(errorMessage),
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    cleanupTokenRevalidation(client);
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

    const usersByOrg = this.getConnectedUsersByOrg();
    if (usersByOrg.size === 0) {
      return;
    }

    await Promise.allSettled(
      Array.from(usersByOrg.entries()).map(async ([orgId, userIds]) => {
        const payloadsByUser = await this.augmentPayloadForOrg(
          event,
          orgId,
          userIds,
        );
        for (const userId of userIds) {
          this.sessions.emitToUser(
            this.server,
            userId,
            event.type,
            payloadsByUser.get(userId) ?? event.payload,
          );
        }
      }),
    );
  }

  /**
   * Delivers one realtime event only to the sockets connected to this Nest
   * instance, reusing the ordinary per-organization payload augmentation.
   *
   * The Socket.IO Redis adapter is deliberately bypassed: the Go
   * situation-signals worker publishes one message per update on the shared
   * Redis bridge channel and every NestJS instance receives it, so re-entering
   * a cluster-wide `broadcast` (room emit) would duplicate the event once per
   * instance. This method therefore emits directly to the local sockets and
   * never publishes anything back to Redis.
   *
   * This is read-only with respect to the dispatcher: feeding the event back
   * into `SituationMonitorSignalsDispatcher.publish` would push it onto the
   * bridge again and loop forever.
   */
  async emitLocalEvent(
    event: SupportedSituationMonitorRealtimeEvent,
  ): Promise<void> {
    if (!this.server) {
      return;
    }

    const localSockets = this.getLocalSockets();
    if (localSockets.length === 0) {
      return;
    }

    const usersByOrg = new Map<string, string[]>();
    const seenUsers = new Set<string>();
    for (const socket of localSockets) {
      const profile = socket.data?.user as AuthenticatedUser | undefined;
      if (!profile?.id || !profile.orgId) {
        continue;
      }
      const userKey = `${profile.orgId}:${profile.id}`;
      if (seenUsers.has(userKey)) {
        continue;
      }
      seenUsers.add(userKey);
      const userIds = usersByOrg.get(profile.orgId) ?? [];
      userIds.push(profile.id);
      usersByOrg.set(profile.orgId, userIds);
    }
    if (usersByOrg.size === 0) {
      return;
    }

    await Promise.allSettled(
      Array.from(usersByOrg.entries()).map(async ([orgId, userIds]) => {
        const payloadsByUser = await this.augmentPayloadForOrg(
          event,
          orgId,
          userIds,
        );
        const orgUserIds = new Set(userIds);
        for (const socket of localSockets) {
          const profile = socket.data?.user as AuthenticatedUser | undefined;
          if (
            !profile?.id ||
            profile.orgId !== orgId ||
            !orgUserIds.has(profile.id)
          ) {
            continue;
          }
          socket.emit(
            event.type,
            payloadsByUser.get(profile.id) ?? event.payload,
          );
        }
      }),
    );
  }

  private async augmentPayloadForOrg(
    event: SupportedSituationMonitorRealtimeEvent,
    orgId: string,
    userIds: string[],
  ): Promise<Map<string, SupportedSituationMonitorRealtimeEvent["payload"]>> {
    const fallback = new Map(
      userIds.map((userId) => [userId, event.payload] as const),
    );
    if (!this.monitors) {
      return fallback;
    }

    try {
      if (event.type === "situation:telegram.update") {
        const payload = event.payload as SituationTelegramRealtimePayload;
        return await this.monitors.augmentTelegramRealtimePayloadForUsers(
          orgId,
          userIds,
          payload,
        );
      }

      const payload = event.payload as SituationOrefRealtimePayload;
      return await this.monitors.augmentOrefRealtimePayloadForUsers(
        orgId,
        userIds,
        payload,
      );
    } catch (error) {
      this.logger.warn(
        {
          eventType: event.type,
          orgId,
          userCount: userIds.length,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to augment situation monitor realtime payload",
      );
      return fallback;
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
  private extractClientIp(client: Socket): string | undefined {
    // Only honor X-Forwarded-For behind a trusted proxy chain; the raw header
    // is client-controlled and would allow spoofing the rate-limit/backoff
    // keys (or poisoning a victim IP).
    return resolveSocketClientIp(client, isTrustProxyConfigured());
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
    return isOriginInAllowlist(
      origin,
      parseCorsOriginAllowlist(this.env.graphqlConfig.corsOrigin),
    );
  }

  /**
   * Local sockets of this situation-monitor namespace. Nest injects either the
   * namespaced Namespace (sockets -> Map) or the root Server (sockets -> default
   * namespace), so both shapes are resolved to the sockets of this gateway's own
   * namespace without touching the ordinary broadcast path.
   */
  private getLocalSockets(): Socket[] {
    if (!this.server) {
      return [];
    }
    const sockets: unknown = this.server.sockets;
    if (sockets instanceof Map) {
      return Array.from(sockets.values()) as Socket[];
    }
    // Root Server injection: `server.sockets` is the default namespace, so the
    // gateway namespace must be resolved explicitly to avoid missing its sockets.
    // A namespace instance exposes no `of`, so the presence of that method tells
    // the two shapes apart without guessing.
    if ("of" in this.server) {
      const namespaceSockets: unknown = this.server.of(
        SITUATION_MONITOR_SIGNALS_NAMESPACE,
      ).sockets;
      if (namespaceSockets instanceof Map) {
        return Array.from(namespaceSockets.values()) as Socket[];
      }
    }
    return [];
  }

  private getConnectedUsersByOrg() {
    const sockets = this.server?.sockets?.sockets;
    if (!sockets) {
      return new Map<string, string[]>();
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
    const usersByOrg = new Map<string, string[]>();
    for (const { orgId, userId } of users.values()) {
      const userIds = usersByOrg.get(orgId) ?? [];
      userIds.push(userId);
      usersByOrg.set(orgId, userIds);
    }
    return usersByOrg;
  }
}
