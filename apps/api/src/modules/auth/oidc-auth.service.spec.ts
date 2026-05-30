import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import { validateSsrfUrlAsync } from "../../common/validators/ssrf-url.validator";

import { OidcAuthService } from "./oidc-auth.service";

jest.mock("../../common/validators/ssrf-url.validator", () => ({
  validateSsrfUrlAsync: jest.fn(),
}));

const validateSsrfUrlAsyncMock =
  validateSsrfUrlAsync as jest.MockedFunction<typeof validateSsrfUrlAsync>;

const API_BASE_URL = "https://api.example.com";
const ISSUER = "https://idp.example.com";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const AUTHORIZATION_ENDPOINT = `${ISSUER}/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/jwks`;
const ORG_ID = "org-1";
const CLIENT_ID = "oidc-client";
const CLIENT_SECRET = "oidc-secret";
const STATE = "state-1";
const CODE = "code-1";
const CODE_VERIFIER = "verifier-1";
const NONCE = "nonce-1";
const USER_ID = "user-1";
const USER_EMAIL = "User@example.com";
const SUBJECT = "subject-1";
const KEY_ID = "key-1";

describe("OidcAuthService", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    validateSsrfUrlAsyncMock.mockImplementation(async (url: string) => {
      if (url.includes("169.254.169.254")) {
        return { valid: false, reason: "blocked metadata endpoint" };
      }
      return { valid: true };
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it("builds the OIDC redirect URI from the API base URL", () => {
    const service = new OidcAuthService(
      {} as any,
      {} as any,
      {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === "API_BASE_URL") {
            return "https://api.example.com";
          }
          return undefined;
        }),
      } as any,
      {} as any,
      {} as any,
    );

    expect((service as any).getCallbackUrl()).toBe(
      "https://api.example.com/api/auth/oidc/callback",
    );
  });

  it("accepts a valid id_token signed by the provider JWKS", async () => {
    const fixture = await createSigningFixture();
    const idToken = await signIdToken(fixture.privateKey);
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [fixture.publicJwk] },
    });

    await expect(
      harness.service.handleCallback({
        state: STATE,
        code: CODE,
        ipAddress: "203.0.113.10",
        userAgent: "jest",
      }),
    ).resolves.toEqual({ handoffToken: "handoff-1" });

    expect(harness.authService.beginTrustedLogin).toHaveBeenCalledWith(
      USER_ID,
      ORG_ID,
      "203.0.113.10",
      "jest",
      "login_with_oidc",
    );
    expect(harness.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: USER_EMAIL.toLowerCase() },
    });
    expect(harness.prisma.authChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "sso_handoff",
        userId: USER_ID,
        orgId: ORG_ID,
      }),
    });
  });

  it("rejects an id_token signed by a key that is not in the provider JWKS", async () => {
    const trustedFixture = await createSigningFixture();
    const attackerFixture = await createSigningFixture();
    const idToken = await signIdToken(attackerFixture.privateKey);
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [trustedFixture.publicJwk] },
    });

    await expect(
      harness.service.handleCallback({ state: STATE, code: CODE }),
    ).rejects.toThrow("OIDC identity token validation failed");

    expect(harness.authService.beginTrustedLogin).not.toHaveBeenCalled();
    expect(harness.prisma.authChallenge.create).not.toHaveBeenCalled();
  });

  it("rejects an id_token with the wrong nonce", async () => {
    const fixture = await createSigningFixture();
    const idToken = await signIdToken(fixture.privateKey, {
      payload: { nonce: "attacker-nonce" },
    });
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [fixture.publicJwk] },
    });

    await expect(
      harness.service.handleCallback({ state: STATE, code: CODE }),
    ).rejects.toThrow("OIDC identity token validation failed");

    expect(harness.authService.beginTrustedLogin).not.toHaveBeenCalled();
  });

  it("rejects an id_token with the wrong audience", async () => {
    const fixture = await createSigningFixture();
    const idToken = await signIdToken(fixture.privateKey, {
      audience: "other-client",
    });
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [fixture.publicJwk] },
    });

    await expect(
      harness.service.handleCallback({ state: STATE, code: CODE }),
    ).rejects.toThrow("OIDC identity token validation failed");

    expect(harness.authService.beginTrustedLogin).not.toHaveBeenCalled();
  });

  it("rejects an id_token with multiple audiences and no matching azp", async () => {
    const fixture = await createSigningFixture();
    const idToken = await signIdToken(fixture.privateKey, {
      audience: [CLIENT_ID, "api://other"],
    });
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [fixture.publicJwk] },
    });

    await expect(
      harness.service.handleCallback({ state: STATE, code: CODE }),
    ).rejects.toThrow("OIDC identity token validation failed");

    expect(harness.authService.beginTrustedLogin).not.toHaveBeenCalled();
  });

  it("rejects an expired id_token", async () => {
    const fixture = await createSigningFixture();
    const idToken = await signIdToken(fixture.privateKey, {
      expiresAt: Math.floor(Date.now() / 1000) - 120,
    });
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [fixture.publicJwk] },
    });

    await expect(
      harness.service.handleCallback({ state: STATE, code: CODE }),
    ).rejects.toThrow("OIDC identity token validation failed");

    expect(harness.authService.beginTrustedLogin).not.toHaveBeenCalled();
  });

  it("rejects discovery documents without a JWKS URI", async () => {
    const fixture = await createSigningFixture();
    const idToken = await signIdToken(fixture.privateKey);
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [fixture.publicJwk] },
      discovery: { jwks_uri: undefined },
    });

    await expect(
      harness.service.handleCallback({ state: STATE, code: CODE }),
    ).rejects.toThrow("OIDC discovery document is invalid");

    expect(harness.authService.beginTrustedLogin).not.toHaveBeenCalled();
  });

  it("rejects discovery documents whose issuer does not match the configured issuer", async () => {
    const fixture = await createSigningFixture();
    const idToken = await signIdToken(fixture.privateKey);
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [fixture.publicJwk] },
      discovery: { issuer: "https://evil.example.com" },
    });

    await expect(
      harness.service.handleCallback({ state: STATE, code: CODE }),
    ).rejects.toThrow("OIDC discovery issuer does not match configured issuer");

    expect(harness.authService.beginTrustedLogin).not.toHaveBeenCalled();
  });

  it("blocks private or metadata OIDC endpoints", async () => {
    const fixture = await createSigningFixture();
    const idToken = await signIdToken(fixture.privateKey);
    const harness = createServiceHarness();
    installFetchMock({
      idToken,
      jwks: { keys: [fixture.publicJwk] },
      discovery: { jwks_uri: "https://169.254.169.254/jwks" },
    });

    await expect(
      harness.service.handleCallback({ state: STATE, code: CODE }),
    ).rejects.toThrow("OIDC JWKS URL is not allowed");

    expect(harness.authService.beginTrustedLogin).not.toHaveBeenCalled();
  });
});

function createServiceHarness() {
  const prisma = {
    org: {
      findUnique: jest.fn().mockResolvedValue({
        id: ORG_ID,
        oidcConfig: {
          enabled: true,
          issuerUrl: ISSUER,
          discoveryUrl: null,
          clientId: CLIENT_ID,
          clientSecret: { ciphertext: "secret" },
          scopes: ["openid", "email", "profile"],
          buttonLabel: null,
        },
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: USER_ID,
        email: USER_EMAIL,
      }),
    },
    authChallenge: {
      create: jest.fn().mockResolvedValue({ id: "handoff-1" }),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const cache = {
    get: jest.fn().mockResolvedValue({
      orgId: ORG_ID,
      codeVerifier: CODE_VERIFIER,
      nonce: NONCE,
    }),
    set: jest.fn(),
    del: jest.fn(),
  };
  const env = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === "API_BASE_URL") {
        return API_BASE_URL;
      }
      return undefined;
    }),
  };
  const authSecurity = {
    decodeSecret: jest.fn().mockResolvedValue(CLIENT_SECRET),
  };
  const authService = {
    beginTrustedLogin: jest.fn().mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
      accessToken: "access-token",
      refreshToken: "refresh-token",
      organizations: [],
      expiresIn: 900,
    }),
  };

  return {
    service: new OidcAuthService(
      prisma as any,
      cache as any,
      env as any,
      authSecurity as any,
      authService as any,
    ),
    prisma,
    cache,
    env,
    authSecurity,
    authService,
  };
}

async function createSigningFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KEY_ID;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk };
}

async function signIdToken(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  options?: {
    audience?: string | string[];
    expiresAt?: number;
    payload?: Record<string, unknown>;
  },
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    nonce: NONCE,
    email: USER_EMAIL,
    email_verified: true,
    ...(options?.payload ?? {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(ISSUER)
    .setAudience(options?.audience ?? CLIENT_ID)
    .setSubject(SUBJECT)
    .setIssuedAt(now)
    .setExpirationTime(options?.expiresAt ?? now + 300)
    .sign(privateKey);
}

function installFetchMock(params: {
  idToken: string;
  jwks: { keys: JWK[] };
  discovery?: Partial<{
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
  }>;
}) {
  global.fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : input;
    if (url === DISCOVERY_URL) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: AUTHORIZATION_ENDPOINT,
        token_endpoint: TOKEN_ENDPOINT,
        jwks_uri: JWKS_URI,
        ...params.discovery,
      });
    }
    if (url === TOKEN_ENDPOINT) {
      expect(init?.method).toBe("POST");
      return jsonResponse({ id_token: params.idToken });
    }
    if (url === JWKS_URI) {
      return jsonResponse(params.jwks);
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as any;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}
