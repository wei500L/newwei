import { createLogger } from "@modular/utils";
import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
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
} from "../../common/cors/cors-origin";
import { AccessTokenBlacklistService } from "../auth/access-token-blacklist.service";
import {
  AuthService,
  AuthenticatedUser,
  JwtPayload,
} from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import {
  isTrustProxyConfigured,
  resolveSocketClientIp,
} from "../websocket/socket-client-ip";
import {
  buildRealtimeSocketErrorPayload,
  shouldRecordFailedSocketAuth,
} from "../websocket/socket-error-payloads";
import {
  attachTokenRevalidation,
  cleanupTokenRevalidation,
} from "../websocket/socket-token-revalidation";
import { UserSessionManager } from "../websocket/user-session-manager.service";
import { WsConnectionRateLimiterService } from "../websocket/ws-connection-rate-limiter.service";

import {
  QueueEventPayload,
  QueueEventPublisher,
} from "./queue-event.publisher";

@WebSocketGateway({
  namespace: "queue",
  cors: {
    origin: true,
    credentials: true,
  },
})
export class QueueGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = createLogger({ name: "queue-gateway" });
  private unsubscribe?: () => void;

  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly queueEvents: QueueEventPublisher,
    private readonly sessions: UserSessionManager,
    private readonly connectionRateLimiter: WsConnectionRateLimiterService,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.queueEvents.registerListener(
      async (orgId, payload) => {
        this.broadcast(orgId, payload);
      },
    );
  }

  async onModuleDestroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  async handleConnection(client: Socket) {
    const ip = this.extractClientIp(client);
    try {
      // Check rate limit before any authentication
      const rateLimitResult =
        await this.connectionRateLimiter.checkConnectionRateLimit(ip ?? "");
      if (!rateLimitResult.allowed) {
        this.logger.warn(
          { socketId: client.id, ip },
          "WebSocket connection rate limited",
        );
        client.emit(
          "queue:error",
          buildRealtimeSocketErrorPayload(
            "Rate limit exceeded",
            rateLimitResult.retryAfterMs,
          ),
        );
        client.disconnect(true);
        return;
      }

      // Check backoff delay from previous failed auth attempts
      const backoffDelay = await this.connectionRateLimiter.getBackoffDelay(
        ip ?? "",
      );
      if (backoffDelay > 0) {
        this.logger.warn(
          { socketId: client.id, ip, backoffDelay },
          "WebSocket connection in backoff period",
        );
        client.emit(
          "queue:error",
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
      await this.ensureNotRevoked(payload);
      const profile = await this.authService.getUserProfile(
        payload.sub,
        payload.orgId,
      );
      if (!profile.permissions.includes("queue.manage")) {
        throw new Error("Insufficient permissions");
      }

      // Clear backoff on successful authentication
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
      client.emit("queue:connected", {
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
        "Queue socket connected",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (shouldRecordFailedSocketAuth(errorMessage)) {
        await this.connectionRateLimiter.recordFailedAuth(ip ?? "");
      }
      this.sessions.unregister(client);
      this.logger.warn(
        {
          socketId: client.id,
          ip,
          error: errorMessage,
        },
        "Queue socket authentication failed",
      );
      client.emit("queue:error", buildRealtimeSocketErrorPayload(errorMessage));
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
      "Queue socket disconnected",
    );
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
    return isOriginInAllowlist(
      origin,
      parseCorsOriginAllowlist(this.env.graphqlConfig.corsOrigin),
    );
  }

  private broadcast(orgId: string, payload: QueueEventPayload) {
    if (!this.server) {
      return;
    }
    this.server
      .to(this.orgRoom(orgId))
      .emit("queue:event", { orgId, ...payload });
  }

  private orgRoom(orgId: string) {
    return `org:${orgId}`;
  }

  private extractClientIp(client: Socket) {
    // Only honor X-Forwarded-For behind a trusted proxy chain; the raw
    // header is client-controlled and would allow spoofing the
    // rate-limit/backoff keys (or poisoning a victim IP).
    return resolveSocketClientIp(client, isTrustProxyConfigured());
  }
}
