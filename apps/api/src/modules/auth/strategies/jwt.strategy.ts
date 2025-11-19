import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { EnvService } from "../../config/config.service";
import { AuthService, JwtPayload } from "../auth.service";
import { AccessTokenBlacklistService } from "../access-token-blacklist.service";

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

    const profile = await this.authService.getUserProfile(payload.sub);
    return {
      ...profile,
      accessTokenId: payload.jti,
      accessTokenExpiresAt: payload.exp ? payload.exp * 1000 : undefined
    };
  }
}
