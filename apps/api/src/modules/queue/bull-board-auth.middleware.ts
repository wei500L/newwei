import { createLogger } from "@modular/utils";
import type { NextFunction, Request, Response } from "express";
import { verify } from "jsonwebtoken";

import type { AccessTokenBlacklistService } from "../auth/access-token-blacklist.service";
import type { AuthService, JwtPayload } from "../auth/auth.service";
import type { EnvService } from "../config/config.service";

const QUEUE_MANAGE_PERMISSION = "queue.manage";

const logger = createLogger({ name: "bull-board-auth" });

class BullBoardAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export const createBullBoardAuthMiddleware = (
  env: EnvService,
  authService: AuthService,
  accessTokenBlacklist: AccessTokenBlacklistService,
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        throw new BullBoardAuthError("Missing auth token", 401);
      }

      const payload = verifyAccessToken(env, token);
      await ensureNotRevoked(accessTokenBlacklist, payload);
      const profile = await authService.getUserProfile(
        payload.sub,
        payload.orgId,
      );
      if (!profile.permissions.includes(QUEUE_MANAGE_PERMISSION)) {
        throw new BullBoardAuthError("Insufficient permissions", 403);
      }

      (req as Request & { user?: unknown }).user = profile;
      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        error instanceof BullBoardAuthError ? error.statusCode : 401;
      logger.warn(
        { path: req.originalUrl, message, status },
        "Bull Board authentication failed",
      );
      res.status(status).send(status === 403 ? "Forbidden" : "Authentication required");
    }
  };
};

function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const trimmed = authorization.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = trimmed.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

function verifyAccessToken(env: EnvService, token: string): JwtPayload {
  const jwtConfig = env.jwtConfig;
  const decoded = verify(token, jwtConfig.secret, {
    audience: jwtConfig.audience,
    issuer: jwtConfig.issuer,
  });

  if (!decoded || typeof decoded === "string") {
    throw new BullBoardAuthError("Invalid token", 401);
  }

  const payload = decoded as Partial<JwtPayload>;
  if (typeof payload.sub !== "string" || typeof payload.orgId !== "string") {
    throw new BullBoardAuthError("Invalid token payload", 401);
  }

  return {
    sub: payload.sub,
    orgId: payload.orgId,
    permissions: Array.isArray(payload.permissions)
      ? payload.permissions.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    jti: typeof payload.jti === "string" ? payload.jti : undefined,
    exp: typeof payload.exp === "number" ? payload.exp : undefined,
    iat: typeof payload.iat === "number" ? payload.iat : undefined,
  };
}

async function ensureNotRevoked(
  accessTokenBlacklist: AccessTokenBlacklistService,
  payload: JwtPayload,
) {
  if (payload.jti && (await accessTokenBlacklist.has(payload.jti))) {
    throw new BullBoardAuthError("Token revoked", 401);
  }
}
