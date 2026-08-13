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

import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service";
import { NewsnowActiveSourceRegistryService } from "./newsnow-active-source-registry.service";
import {
  NewsnowRealtimeDispatcher,
  NewsnowRealtimeEvent,
} from "./newsnow-realtime.dispatcher";

interface NewsnowSetActiveSourcesPayload {
  sourceIds?: unknown;
}

const ACTIVE_SOURCE_EVENT = "newsnow:set-active-sources";
const ACTIVE_SOURCE_ID_PATTERN = /^[a-z0-9_-]+$/i;
const MAX_ACTIVE_SOURCE_IDS = 60;

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

  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly dispatcher: NewsnowRealtimeDispatcher,
    private readonly sessions: UserSessionManager,
    private readonly registryService: NewsAggregatorRegistryService,
    private readonly activeSources: NewsnowActiveSourceRegistryService,
    private readonly connectionRateLimiter: WsConnectionRateLimiterService,
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
  }

  async handleConnection(client: Socket) {
    const ip = this.extractClientIp(client);
    try {
      const ipRateLimit =
        await this.connectionRateLimiter.checkConnectionRateLimit(ip ?? "");
      if (!ipRateLimit.allowed) {
        this.logger.warn(
          { socketId: client.id, ip },
          "NewsNow socket connection rate limited",
        );
        client.emit(
          "newsnow:error",
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
          "NewsNow socket connection in backoff period",
        );
        client.emit(
          "newsnow:error",
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
          "NewsNow socket user connection attempts throttled",
        );
        client.emit(
          "newsnow:error",
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

      // Register the active-sources listener BEFORE the auth round-trips
      // finish: clients emit it immediately after connect, and a listener
      // installed after several awaits would miss the first frame (the socket
      // would never enter the active-source registry and warm/refresh
      // targeting for that org silently breaks).
      client.on(ACTIVE_SOURCE_EVENT, (payload: NewsnowSetActiveSourcesPayload) => {
        this.handleSetActiveSources(client, payload);
      });

      client.data.user = profile;
      client.data.clientIp = ip;

      // Replay a first-frame active-sources emit that arrived before auth
      // completed.
      if (client.data.pendingActiveSources !== undefined) {
        this.handleSetActiveSources(client, client.data.pendingActiveSources);
        client.data.pendingActiveSources = undefined;
      }

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
        "NewsNow socket connected",
      );
    } catch (error) {
      this.sessions.unregister(client);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (shouldRecordFailedSocketAuth(errorMessage)) {
        await this.connectionRateLimiter.recordFailedAuth(ip ?? "");
      }
      this.logger.warn(
        { socketId: client.id, ip, error: errorMessage },
        "NewsNow socket authentication failed",
      );
      client.emit(
        "newsnow:error",
        buildRealtimeSocketErrorPayload(errorMessage),
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    cleanupTokenRevalidation(client);
    const profile = client.data?.user as AuthenticatedUser | undefined;
    this.activeSources.removeSocket(client.id);
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

    const orgId = typeof event.orgId === "string" ? event.orgId.trim() : "";
    if (!orgId) {
      this.logger.warn(
        { sourceId: event.sourceId },
        "Dropped NewsNow realtime event without orgId",
      );
      return;
    }

    this.sessions.emitToOrg(
      this.server,
      orgId,
      "newsnow:update",
      { ...event, orgId },
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

  private handleSetActiveSources(
    client: Socket,
    payload: NewsnowSetActiveSourcesPayload | undefined,
  ) {
    const profile = client.data?.user as AuthenticatedUser | undefined;
    if (!profile) {
      // Listener is registered before auth completes (so the client's
      // first-frame emit is not lost); buffer it until handleConnection
      // finishes authenticating.
      client.data.pendingActiveSources = payload;
      return;
    }

    this.activeSources.setActiveSources({
      socketId: client.id,
      orgId: profile.orgId,
      sourceIds: this.normalizeActiveSourceIds(payload?.sourceIds),
    });
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

  private normalizeActiveSourceIds(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }

    const knownSourceIds = new Set(
      Object.keys(this.registryService.getMetadata().sources),
    );
    const normalized: string[] = [];
    const seen = new Set<string>();
    let truncated = 0;

    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const sourceId = entry.trim();
      if (
        !sourceId ||
        !ACTIVE_SOURCE_ID_PATTERN.test(sourceId) ||
        seen.has(sourceId) ||
        !knownSourceIds.has(sourceId)
      ) {
        continue;
      }
      if (normalized.length >= MAX_ACTIVE_SOURCE_IDS) {
        truncated += 1;
        continue;
      }
      seen.add(sourceId);
      normalized.push(sourceId);
    }

    if (truncated > 0) {
      this.logger.warn(
        { activeCount: normalized.length, truncated, max: MAX_ACTIVE_SOURCE_IDS },
        "Newsnow active source list truncated at the server-side cap; sources beyond the cap will not receive realtime updates",
      );
    }

    return normalized;
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

  private extractClientIp(client: Socket) {
    // Only honor X-Forwarded-For behind a trusted proxy chain; the raw
    // header is client-controlled and would allow spoofing the
    // rate-limit/backoff keys (or poisoning a victim IP).
    return resolveSocketClientIp(client, isTrustProxyConfigured());
  }
}
