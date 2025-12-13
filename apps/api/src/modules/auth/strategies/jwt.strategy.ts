import { HttpException, Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { EnvService } from "../../config/config.service";
import { AuthService, JwtPayload } from "../auth.service";
import { AccessTokenBlacklistService } from "../access-token-blacklist.service";

function isPrismaNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === "P2025";
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly env: EnvService,
    private readonly authService: AuthService,
    private readonly accessTokenBlacklist: AccessTokenBlacklistService
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env.jwtConfig.secret,
      audience: env.jwtConfig.audience,
      issuer: env.jwtConfig.issuer
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.jti) {
      const isRevoked = await this.accessTokenBlacklist.has(payload.jti);
      if (isRevoked) {
        throw new UnauthorizedException("Access token revoked");
      }
    }

    let profile: Awaited<ReturnType<AuthService["getUserProfile"]>>;
    try {
      profile = await this.authService.getUserProfile(payload.sub, payload.orgId);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (isPrismaNotFoundError(error)) {
        throw new UnauthorizedException("Invalid access token");
      }
      throw error;
    }
    return {
      ...profile,
      accessTokenId: payload.jti,
      accessTokenExpiresAt: payload.exp ? payload.exp * 1000 : undefined
    };
  }
}
