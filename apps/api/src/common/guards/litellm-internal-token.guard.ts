import { createLogger } from "@modular/utils";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { EnvService } from "../../modules/config/config.service";
import { extractBearerToken, tokensEqual } from "../internal-token";

const logger = createLogger({ name: "litellm-internal-token" });

@Injectable()
export class LitellmInternalTokenGuard implements CanActivate {
  constructor(private readonly env: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = this.env.liteLlmConfigInternalToken;
    if (!expected) {
      throw new ForbiddenException(
        "LITELLM_CONFIG_INTERNAL_TOKEN is not configured",
      );
    }

    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    if (!tokensEqual(token, expected)) {
      logger.warn(
        { path: request.path },
        "Rejected request with invalid internal bearer token",
      );
      throw new UnauthorizedException("Invalid bearer token");
    }

    return true;
  }
}
