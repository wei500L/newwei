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
import { AlertsQueueEventPublisher } from "../alerts/alerts-queue-event.publisher";
import { AnalysisQueueEventPublisher } from "../analysis/analysis-queue-event.publisher";
import { AssistantQueueEventPublisher } from "../assistant/assistant-queue-event.publisher";
import { AccessTokenBlacklistService } from "../auth/access-token-blacklist.service";
import {
  AuthService,
  type AuthenticatedUser,
  type JwtPayload,
} from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import { CrawlQueueEventPublisher } from "../crawl/crawl-queue-event.publisher";
import { QueueEventPublisher } from "../queue/queue-event.publisher";
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

interface OpsLiveEventPayload {
  source: "pipeline" | "crawl" | "analysis" | "assistant" | "alerts";
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
  pipelineJobId?: string;
  sourceId?: string;
  rawItemId?: string;
  itemMetaId?: string;
  processedItemId?: string;
  taskId?: string;
  priorityClass?: "hot" | "normal";
  sourcePriority?: number;
}

@WebSocketGateway({
  namespace: "ops",
  cors: {
    origin: true,
    credentials: true,
  },
})
export class OpsGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = createLogger({ name: "ops-gateway" });
  private unsubscribePipeline?: () => void;
  private unsubscribeCrawl?: () => void;
  private unsubscribeAnalysis?: () => void;
  private unsubscribeAssistant?: () => void;
  private unsubscribeAlerts?: () => void;

  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService,
    private readonly queueEvents: QueueEventPublisher,
    private readonly crawlEvents: CrawlQueueEventPublisher,
    private readonly analysisEvents: AnalysisQueueEventPublisher,
    private readonly assistantEvents: AssistantQueueEventPublisher,
    private readonly alertsEvents: AlertsQueueEventPublisher,
    private readonly sessions: UserSessionManager,
    private readonly connectionRateLimiter: WsConnectionRateLimiterService,
  ) {}

  onModuleInit() {
    this.unsubscribePipeline = this.queueEvents.registerListener(
      (orgId, payload) => {
        this.broadcast(orgId, {
          source: "pipeline",
          event: payload.event,
          jobId: payload.jobId,
          data: payload.data,
          timestamp: payload.timestamp,
          pipelineJobId: payload.pipelineJobId,
          sourceId: payload.sourceId,
          rawItemId: payload.rawItemId,
          itemMetaId: payload.itemMetaId,
          processedItemId: payload.processedItemId,
        });
      },
    );
    this.unsubscribeCrawl = this.crawlEvents.registerListener(
      (orgId, payload) => {
        this.broadcast(orgId, {
          source: "crawl",
          event: payload.event,
          jobId: payload.jobId,
          data: payload.data,
          timestamp: payload.timestamp,
          sourceId: payload.sourceId,
          taskId: payload.taskId,
          priorityClass: payload.priorityClass,
          sourcePriority: payload.sourcePriority,
        });
      },
    );
    this.unsubscribeAnalysis = this.analysisEvents.registerListener(
      (orgId, payload) => {
        this.broadcast(orgId, {
          source: "analysis",
          event: payload.event,
          jobId: payload.jobId,
          data: payload.data,
          timestamp: payload.timestamp,
        });
      },
    );
    this.unsubscribeAssistant = this.assistantEvents.registerListener(
      (orgId, payload) => {
        this.broadcast(orgId, {
          source: "assistant",
          event: payload.event,
          jobId: payload.jobId,
          data: payload.data,
          timestamp: payload.timestamp,
        });
      },
    );
    this.unsubscribeAlerts = this.alertsEvents.registerListener(
      (orgId, payload) => {
        this.broadcast(orgId, {
          source: "alerts",
          event: payload.event,
          jobId: payload.jobId,
          data: payload.data,
          timestamp: payload.timestamp,
        });
      },
    );
  }

  async onModuleDestroy() {
    if (this.unsubscribePipeline) {
      this.unsubscribePipeline();
      this.unsubscribePipeline = undefined;
    }
    if (this.unsubscribeCrawl) {
      this.unsubscribeCrawl();
      this.unsubscribeCrawl = undefined;
    }
    if (this.unsubscribeAnalysis) {
      this.unsubscribeAnalysis();
      this.unsubscribeAnalysis = undefined;
    }
    if (this.unsubscribeAssistant) {
      this.unsubscribeAssistant();
      this.unsubscribeAssistant = undefined;
    }
    if (this.unsubscribeAlerts) {
      this.unsubscribeAlerts();
      this.unsubscribeAlerts = undefined;
    }
  }

  async handleConnection(client: Socket) {
    const ip = this.extractClientIp(client);
    try {
      const rateLimitResult =
        await this.connectionRateLimiter.checkConnectionRateLimit(ip ?? "");
      if (!rateLimitResult.allowed) {
        this.logger.warn(
          { socketId: client.id, ip },
          "WebSocket connection rate limited",
        );
        client.emit(
          "ops:error",
          buildRealtimeSocketErrorPayload(
            "Rate limit exceeded",
            rateLimitResult.retryAfterMs,
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
          "WebSocket connection in backoff period",
        );
        client.emit(
          "ops:error",
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
      const hasPermission =
        profile.permissions.includes("crawl.read") ||
        profile.permissions.includes("crawl.write");
      if (!hasPermission) {
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
      client.emit("ops:connected", {
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
        "Ops socket connected",
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
        "Ops socket authentication failed",
      );
      client.emit("ops:error", buildRealtimeSocketErrorPayload(errorMessage));
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
      "Ops socket disconnected",
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

    const headerAuth = client.handshake.headers.authorization;
    const tokenFromHeader = this.parseAuthorizationHeader(headerAuth);
    if (tokenFromHeader) {
      return tokenFromHeader;
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

  private broadcast(orgId: string, payload: OpsLiveEventPayload) {
    if (!this.server) {
      return;
    }
    this.server
      .to(this.sessions.orgRoom(orgId))
      .emit("ops:event", { orgId, ...payload });
  }

  private extractClientIp(client: Socket) {
    // Only honor X-Forwarded-For behind a trusted proxy chain; the raw
    // header is client-controlled and would allow spoofing the
    // rate-limit/backoff keys (or poisoning a victim IP).
    return resolveSocketClientIp(client, isTrustProxyConfigured());
  }
}
