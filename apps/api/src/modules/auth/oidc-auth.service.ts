import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";

import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { AuthSecurityService } from "./auth-security.service";
import { AuthService } from "./auth.service";

interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

interface OidcStatePayload {
  orgId: string;
  codeVerifier: string;
  nonce: string;
}

const OIDC_STATE_TTL_SECONDS = 10 * 60;

@Injectable()
export class OidcAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly authSecurity: AuthSecurityService,
    private readonly authService: AuthService,
  ) {}

  async getConfig(orgId: string) {
    const config = await this.prisma.orgOidcConfig.findUnique({
      where: { orgId },
    });
    return {
      enabled: config?.enabled ?? false,
      issuerUrl: config?.issuerUrl ?? "",
      discoveryUrl: config?.discoveryUrl ?? "",
      clientId: config?.clientId ?? "",
      hasClientSecret: Boolean(config?.clientSecret),
      scopes: this.readScopes(config?.scopes ?? null),
      buttonLabel: config?.buttonLabel ?? "",
    };
  }

  async updateConfig(params: {
    orgId: string;
    actorId: string;
    enabled: boolean;
    issuerUrl: string;
    discoveryUrl?: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    buttonLabel?: string;
  }) {
    const existing = await this.prisma.orgOidcConfig.findUnique({
      where: { orgId: params.orgId },
    });
    const nextSecret = params.clientSecret?.trim()
      ? await this.authSecurity.encodeSecret(params.clientSecret.trim())
      : existing?.clientSecret ?? null;
    const nextScopes = (params.scopes ?? []).filter(
      (scope): scope is string =>
        typeof scope === "string" && scope.trim().length > 0,
    );

    const config = await this.prisma.orgOidcConfig.upsert({
      where: { orgId: params.orgId },
      update: {
        enabled: params.enabled,
        issuerUrl: params.issuerUrl.trim(),
        discoveryUrl: params.discoveryUrl?.trim() || null,
        clientId: params.clientId.trim(),
        clientSecret: nextSecret
          ? (nextSecret as Prisma.InputJsonValue)
          : Prisma.DbNull,
        scopes:
          nextScopes.length > 0
            ? (nextScopes as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        buttonLabel: params.buttonLabel?.trim() || null,
      },
      create: {
        orgId: params.orgId,
        enabled: params.enabled,
        issuerUrl: params.issuerUrl.trim(),
        discoveryUrl: params.discoveryUrl?.trim() || null,
        clientId: params.clientId.trim(),
        clientSecret: nextSecret
          ? (nextSecret as Prisma.InputJsonValue)
          : Prisma.DbNull,
        scopes:
          nextScopes.length > 0
            ? (nextScopes as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        buttonLabel: params.buttonLabel?.trim() || null,
      },
    });

    return {
      enabled: config.enabled,
      issuerUrl: config.issuerUrl,
      discoveryUrl: config.discoveryUrl ?? "",
      clientId: config.clientId,
      hasClientSecret: Boolean(config.clientSecret),
      scopes: this.readScopes(config.scopes),
      buttonLabel: config.buttonLabel ?? "",
    };
  }

  async buildAuthorizationUrl(orgIdentifier: string) {
    const org = await this.prisma.org.findFirst({
      where: {
        OR: [{ id: orgIdentifier }, { slug: orgIdentifier.toLowerCase() }],
      },
      include: {
        oidcConfig: true,
      },
    });
    if (!org?.oidcConfig?.enabled) {
      throw new BadRequestException("OIDC is not configured for this organization");
    }

    const discovery = await this.fetchDiscovery(org.oidcConfig);
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const codeVerifier = this.toBase64Url(crypto.randomBytes(32));
    const codeChallenge = this.toBase64Url(
      crypto.createHash("sha256").update(codeVerifier).digest(),
    );
    await this.cache.set<OidcStatePayload>(
      this.stateCacheKey(state),
      {
        orgId: org.id,
        codeVerifier,
        nonce,
      },
      OIDC_STATE_TTL_SECONDS,
    );

    const redirectUri = this.getCallbackUrl();
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("client_id", org.oidcConfig.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.readScopes(org.oidcConfig.scopes).join(" "));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return url.toString();
  }

  async handleCallback(params: {
    state?: string;
    code?: string;
    error?: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    if (params.error) {
      throw new UnauthorizedException(`OIDC login failed: ${params.error}`);
    }
    if (!params.state || !params.code) {
      throw new UnauthorizedException("OIDC callback is invalid");
    }

    const stateKey = this.stateCacheKey(params.state);
    const cachedState = await this.cache.get<OidcStatePayload>(stateKey);
    await this.cache.del(stateKey);
    if (!cachedState) {
      throw new UnauthorizedException("OIDC state is invalid or expired");
    }

    const org = await this.prisma.org.findUnique({
      where: { id: cachedState.orgId },
      include: {
        oidcConfig: true,
      },
    });
    if (!org?.oidcConfig?.enabled) {
      throw new UnauthorizedException("OIDC is not configured for this organization");
    }

    const discovery = await this.fetchDiscovery(org.oidcConfig);
    const clientSecret = await this.authSecurity.decodeSecret(
      org.oidcConfig.clientSecret,
    );

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: this.getCallbackUrl(),
      client_id: org.oidcConfig.clientId,
      code_verifier: cachedState.codeVerifier,
    });
    if (clientSecret) {
      body.set("client_secret", clientSecret);
    }

    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!tokenResponse.ok) {
      throw new UnauthorizedException("OIDC token exchange failed");
    }

    const tokenPayload = (await tokenResponse.json()) as {
      id_token?: string;
    };
    if (!tokenPayload.id_token) {
      throw new UnauthorizedException("OIDC response missing id_token");
    }

    const claims = this.decodeJwtPayload(tokenPayload.id_token) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      nonce?: string;
      email?: string;
      email_verified?: boolean;
    };
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== discovery.issuer ||
      !audience.includes(org.oidcConfig.clientId) ||
      claims.nonce !== cachedState.nonce ||
      !claims.email ||
      claims.exp === undefined ||
      claims.exp * 1000 < Date.now()
    ) {
      throw new UnauthorizedException("OIDC identity token validation failed");
    }

    const user = await this.prisma.user.findUnique({
      where: {
        email: claims.email.toLowerCase(),
      },
    });
    if (!user) {
      throw new UnauthorizedException(
        "Your account must be invited or approved before using SSO",
      );
    }

    const result = await this.authService.beginTrustedLogin(
      user.id,
      org.id,
      params.ipAddress,
      params.userAgent,
      "login_with_oidc",
    );

    if ("mfaRequired" in result) {
      return result;
    }

    const handoff = await this.prisma.authChallenge.create({
      data: {
        type: "sso_handoff",
        userId: user.id,
        orgId: org.id,
        payload: result as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    return {
      handoffToken: handoff.id,
    };
  }

  async exchangeHandoffToken(handoffToken: string) {
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { id: handoffToken },
    });
    if (!challenge || challenge.type !== "sso_handoff") {
      throw new UnauthorizedException("SSO handoff token is invalid or expired");
    }
    if (challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException("SSO handoff token is invalid or expired");
    }

    await this.prisma.authChallenge.update({
      where: { id: challenge.id },
      data: {
        consumedAt: new Date(),
      },
    });

    return challenge.payload;
  }

  private async fetchDiscovery(config: {
    issuerUrl: string;
    discoveryUrl: string | null;
  }): Promise<OidcDiscoveryDocument> {
    const discoveryUrl =
      config.discoveryUrl?.trim() ||
      `${config.issuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl);
    if (!response.ok) {
      throw new BadRequestException("Failed to load OIDC discovery document");
    }
    return (await response.json()) as OidcDiscoveryDocument;
  }

  private readScopes(value: Prisma.JsonValue | null | undefined) {
    if (!Array.isArray(value)) {
      return ["openid", "email", "profile"];
    }
    const scopes = value.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
    return scopes.length > 0 ? scopes : ["openid", "email", "profile"];
  }

  private getCallbackUrl() {
    const nextAuthUrl =
      this.env.get<string>("NEXTAUTH_URL", { infer: true }) ??
      process.env.NEXTAUTH_URL;
    if (!nextAuthUrl) {
      throw new BadRequestException("NEXTAUTH_URL is required for OIDC");
    }
    return `${nextAuthUrl.replace(/\/$/, "")}/api/auth/oidc/callback`;
  }

  private stateCacheKey(state: string) {
    return `auth:oidc:state:${state}`;
  }

  private toBase64Url(input: Buffer) {
    return input
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  private decodeJwtPayload(token: string) {
    const [, payload] = token.split(".");
    if (!payload) {
      throw new UnauthorizedException("OIDC token is invalid");
    }
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  }
}
