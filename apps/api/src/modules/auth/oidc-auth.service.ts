import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import crypto from "node:crypto";

import { validateSsrfUrlAsync } from "../../common/validators/ssrf-url.validator";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { AuthSecurityService } from "./auth-security.service";
import { AuthService } from "./auth.service";

interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
}

interface OidcStatePayload {
  orgId: string;
  codeVerifier: string;
  nonce: string;
}

interface OidcIdTokenClaims extends JWTPayload {
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  azp?: unknown;
}

const OIDC_STATE_TTL_SECONDS = 10 * 60;
const OIDC_CLOCK_TOLERANCE_SECONDS = 60;
const OIDC_FETCH_TIMEOUT_MS = 8_000;
const OIDC_DISCOVERY_CACHE_TTL_SECONDS = 60 * 60;
const OIDC_JWKS_CACHE_TTL_SECONDS = 24 * 60 * 60;
const OIDC_PUBLIC_ID_TOKEN_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

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
      requireEmailVerified: config?.requireEmailVerified ?? true,
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
    requireEmailVerified?: boolean;
  }) {
    const existing = await this.prisma.orgOidcConfig.findUnique({
      where: { orgId: params.orgId },
    });
    const nextSecret = params.clientSecret?.trim()
      ? await this.authSecurity.encodeSecret(params.clientSecret.trim())
      : (existing?.clientSecret ?? null);
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
        requireEmailVerified: params.requireEmailVerified ?? true,
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
        requireEmailVerified: params.requireEmailVerified ?? true,
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
      requireEmailVerified: config.requireEmailVerified,
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
      throw new BadRequestException(
        "OIDC is not configured for this organization",
      );
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
    url.searchParams.set(
      "scope",
      this.readScopes(org.oidcConfig.scopes).join(" "),
    );
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
    // Atomic read-and-delete: two concurrent callbacks for the same state
    // must not both see the payload (each would try to exchange the same
    // authorization code with the IdP).
    const cachedState = await this.cache.getdel<OidcStatePayload>(stateKey);
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
      throw new UnauthorizedException(
        "OIDC is not configured for this organization",
      );
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

    const claims = await this.verifyIdToken({
      idToken: tokenPayload.id_token,
      discovery,
      clientId: org.oidcConfig.clientId,
      nonce: cachedState.nonce,
      requireEmailVerified: org.oidcConfig.requireEmailVerified ?? true,
    });

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

    if ("mfaRequired" in result || "mfaEnrollmentRequired" in result) {
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
      throw new UnauthorizedException(
        "SSO handoff token is invalid or expired",
      );
    }
    if (challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException(
        "SSO handoff token is invalid or expired",
      );
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
    const validatedDiscoveryUrl = await this.assertAllowedOidcUrl(
      discoveryUrl,
      "discovery",
    );

    // Discovery documents change rarely; cache per URL so the public SSO
    // endpoints do not hit the IdP on every login.
    const cacheKey = `oidc:discovery:${validatedDiscoveryUrl}`;
    const cached = await this.cache.get<OidcDiscoveryDocument>(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await fetch(validatedDiscoveryUrl, {
      signal: AbortSignal.timeout(OIDC_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new BadRequestException("Failed to load OIDC discovery document");
    }
    const discovery = (await response.json()) as OidcDiscoveryDocument;
    if (
      !this.isNonEmptyString(discovery.issuer) ||
      !this.isNonEmptyString(discovery.authorization_endpoint) ||
      !this.isNonEmptyString(discovery.token_endpoint) ||
      !this.isNonEmptyString(discovery.jwks_uri)
    ) {
      throw new BadRequestException("OIDC discovery document is invalid");
    }

    if (
      this.normalizeIssuerUrl(discovery.issuer) !==
      this.normalizeIssuerUrl(config.issuerUrl)
    ) {
      throw new BadRequestException(
        "OIDC discovery issuer does not match configured issuer",
      );
    }

    await this.assertAllowedOidcUrl(
      discovery.authorization_endpoint,
      "authorization",
    );
    await this.assertAllowedOidcUrl(discovery.token_endpoint, "token");
    await this.assertAllowedOidcUrl(discovery.jwks_uri, "JWKS");

    await this.cache
      .set(cacheKey, discovery, OIDC_DISCOVERY_CACHE_TTL_SECONDS)
      .catch(() => undefined);
    return discovery;
  }

  private readScopes(value: Prisma.JsonValue | null | undefined) {
    if (!Array.isArray(value)) {
      return ["openid", "email", "profile"];
    }
    const scopes = value.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
    return scopes.length > 0 ? scopes : ["openid", "email", "profile"];
  }

  private getCallbackUrl() {
    const apiBaseUrl =
      this.env.get<string>("API_BASE_URL", { infer: true }) ??
      process.env.API_BASE_URL;
    if (!apiBaseUrl) {
      throw new BadRequestException("API_BASE_URL is required for OIDC");
    }
    // Strip a trailing path so an API_BASE_URL that already carries the
    // "/api" global prefix (as the web app normalizes it) does not produce
    // a doubled "/api/api/..." callback URL that silently breaks SSO.
    const normalizedBase = apiBaseUrl
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/api\/?$/i, "");
    return `${normalizedBase}/api/auth/oidc/callback`;
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

  private async verifyIdToken(params: {
    idToken: string;
    discovery: OidcDiscoveryDocument;
    clientId: string;
    nonce: string;
    requireEmailVerified: boolean;
  }) {
    try {
      const jwksUrl = await this.assertAllowedOidcUrl(
        params.discovery.jwks_uri,
        "JWKS",
      );

      // Cache the key set (rotation is rare); if signature verification then
      // fails, refresh once to cover a just-rotated key with a new kid.
      const cacheKey = `oidc:jwks:${jwksUrl}`;
      let jwks = await this.cache.get<JSONWebKeySet>(cacheKey);
      if (!jwks) {
        jwks = await this.fetchJwks(jwksUrl);
        await this.cache
          .set(cacheKey, jwks, OIDC_JWKS_CACHE_TTL_SECONDS)
          .catch(() => undefined);
      }

      try {
        const { payload } = await jwtVerify<OidcIdTokenClaims>(
          params.idToken,
          createLocalJWKSet(jwks),
          {
            issuer: params.discovery.issuer,
            audience: params.clientId,
            algorithms: OIDC_PUBLIC_ID_TOKEN_ALGORITHMS,
            clockTolerance: OIDC_CLOCK_TOLERANCE_SECONDS,
            requiredClaims: ["exp", "sub", "nonce", "email"],
          },
        );

        this.assertValidVerifiedClaims(
          payload,
          params.clientId,
          params.nonce,
          params.requireEmailVerified,
        );
        return payload;
      } catch (signatureError) {
        // One refresh attempt for key rotation before failing hard.
        const freshJwks = await this.fetchJwks(jwksUrl);
        await this.cache
          .set(cacheKey, freshJwks, OIDC_JWKS_CACHE_TTL_SECONDS)
          .catch(() => undefined);
        const { payload } = await jwtVerify<OidcIdTokenClaims>(
          params.idToken,
          createLocalJWKSet(freshJwks),
          {
            issuer: params.discovery.issuer,
            audience: params.clientId,
            algorithms: OIDC_PUBLIC_ID_TOKEN_ALGORITHMS,
            clockTolerance: OIDC_CLOCK_TOLERANCE_SECONDS,
            requiredClaims: ["exp", "sub", "nonce", "email"],
          },
        );

        this.assertValidVerifiedClaims(
          payload,
          params.clientId,
          params.nonce,
          params.requireEmailVerified,
        );
        return payload;
      }
    } catch {
      throw new UnauthorizedException("OIDC identity token validation failed");
    }
  }

  private async fetchJwks(jwksUrl: URL | string): Promise<JSONWebKeySet> {
    const response = await fetch(jwksUrl, {
      signal: AbortSignal.timeout(OIDC_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error("Failed to load OIDC JWKS");
    }
    const jwks = (await response.json()) as JSONWebKeySet;
    if (!Array.isArray(jwks.keys)) {
      throw new Error("OIDC JWKS is invalid");
    }
    return jwks;
  }

  private assertValidVerifiedClaims(
    claims: OidcIdTokenClaims,
    clientId: string,
    nonce: string,
    requireEmailVerified: boolean,
  ): asserts claims is OidcIdTokenClaims & { email: string; nonce: string } {
    if (
      claims.nonce !== nonce ||
      typeof claims.email !== "string" ||
      claims.email.trim().length === 0
    ) {
      throw new UnauthorizedException("OIDC identity token validation failed");
    }
    if (requireEmailVerified && claims.email_verified !== true) {
      throw new UnauthorizedException("OIDC identity token validation failed");
    }

    const audience = Array.isArray(claims.aud)
      ? claims.aud
      : claims.aud
        ? [claims.aud]
        : [];
    if (
      claims.azp !== undefined &&
      (typeof claims.azp !== "string" || claims.azp !== clientId)
    ) {
      throw new UnauthorizedException("OIDC identity token validation failed");
    }
    if (audience.length > 1 && claims.azp !== clientId) {
      throw new UnauthorizedException("OIDC identity token validation failed");
    }
  }

  private async assertAllowedOidcUrl(rawUrl: string, label: string) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BadRequestException(`OIDC ${label} URL is invalid`);
    }

    if (url.protocol !== "https:") {
      throw new BadRequestException(`OIDC ${label} URL must use HTTPS`);
    }

    const validation = await validateSsrfUrlAsync(url.toString());
    if (!validation.valid) {
      throw new BadRequestException(`OIDC ${label} URL is not allowed`);
    }

    return url;
  }

  private normalizeIssuerUrl(value: string) {
    const trimmed = value.trim();
    try {
      const url = new URL(trimmed);
      url.hash = "";
      url.search = "";
      return url.toString().replace(/\/+$/, "");
    } catch {
      return trimmed.replace(/\/+$/, "");
    }
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }
}
