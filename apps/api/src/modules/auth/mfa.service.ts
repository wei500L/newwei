import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { isMachineActorId, withMfaUserLock } from "./auth-factors.lock";
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashOpaqueToken,
  verifyTotpCode,
} from "./auth-flow.utils";
import { AuthSecurityService } from "./auth-security.service";

interface LoginChallengePayload {
  orgId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  action?: string | null;
}

const MFA_CHALLENGE_TTL_MINUTES = 10;
const MFA_ENROLLMENT_CHALLENGE_TTL_MINUTES = 15;
const MFA_ISSUER = "Modular";
const MFA_CODE_FAILURE_MESSAGE = "Invalid MFA verification code";
const MFA_CHALLENGE_LOCKED_MESSAGE =
  "Too many MFA verification attempts. Please sign in again.";
// AF5: the four authenticated MFA *write* routes must never materialize a
// UserTotpFactor for a machine identity. `MachineTokenService.validate`
// produces `machine:<tokenId>`, which is not a User row, so an upsert would
// fail the UserTotpFactor.userId foreign key and surface as a 500.
const MFA_HUMAN_REQUIRED_MESSAGE = "MFA management requires a human user";

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSecurity: AuthSecurityService,
    private readonly env: EnvService,
    private readonly cache: CacheService,
  ) {}

  async getStatus(userId: string) {
    const factor = await this.prisma.userTotpFactor.findUnique({
      where: { userId },
    });
    const recoveryCodesRemaining = await this.prisma.userRecoveryCode.count({
      where: {
        userId,
        usedAt: null,
      },
    });

    return {
      enabled: Boolean(factor?.verifiedAt && !factor?.disabledAt),
      enrolledAt: factor?.enrolledAt ?? null,
      verifiedAt: factor?.verifiedAt ?? null,
      lastUsedAt: factor?.lastUsedAt ?? null,
      recoveryCodesRemaining,
    };
  }

  async beginEnrollment(userId: string, accountName: string) {
    // AF5: reject machine identities before any factor row is written.
    await this.assertHumanMfaActor(userId);

    return withMfaUserLock(userId, async () => {
      const secret = generateTotpSecret();
      const storedSecret = await this.authSecurity.encodeSecret(secret);
      const existingFactor = await this.prisma.userTotpFactor.findUnique({
        where: { userId },
        select: {
          verifiedAt: true,
          disabledAt: true,
        },
      });

      if (existingFactor?.verifiedAt && !existingFactor.disabledAt) {
        // An active factor keeps its verified secret and recovery codes; the
        // replacement only becomes effective once verify-enroll promotes it.
        await this.prisma.userTotpFactor.update({
          where: { userId },
          data: {
            pendingSecret: storedSecret as Prisma.InputJsonValue,
            pendingLabel: accountName,
            pendingStartedAt: new Date(),
          },
        });
      } else {
        await this.prisma.userTotpFactor.upsert({
          where: { userId },
          update: {
            secret: storedSecret as Prisma.InputJsonValue,
            pendingSecret: Prisma.DbNull,
            label: accountName,
            pendingLabel: null,
            pendingStartedAt: null,
            verifiedAt: null,
            disabledAt: null,
            lastUsedAt: null,
          },
          create: {
            userId,
            secret: storedSecret as Prisma.InputJsonValue,
            label: accountName,
          },
        });
      }

      return {
        secret,
        otpauthUri: buildOtpAuthUri({
          issuer: MFA_ISSUER,
          accountName,
          secret,
        }),
      };
    });
  }

  async verifyEnrollment(userId: string, code: string) {
    await this.assertHumanMfaActor(userId);

    const recoveryCodes = generateRecoveryCodes();
    await withMfaUserLock(userId, async () => {
      // The factor is re-read inside the lock so a concurrent begin/verify/
      // disable cannot promote a stale snapshot.
      const factor = await this.prisma.userTotpFactor.findUnique({
        where: { userId },
      });
      if (!factor) {
        throw new BadRequestException("MFA enrollment is not initialized");
      }

      // AF1: a factor that is already active with no pending replacement has
      // already completed its enrollment. Completing it again would rotate the
      // recovery codes out from under the previous response, so it is refused
      // with the same message as "no enrollment in progress".
      const active = Boolean(factor.verifiedAt && !factor.disabledAt);
      if (active && !factor.pendingSecret) {
        throw new BadRequestException("MFA enrollment is not initialized");
      }

      const enrollmentSecretValue = factor.pendingSecret ?? factor.secret;
      const secret = await this.authSecurity.decodeSecret(enrollmentSecretValue);
      if (!secret || !verifyTotpCode(secret, code)) {
        throw new BadRequestException("Invalid MFA verification code");
      }

      const verifiedAt = new Date();
      // The factor promotion and the recovery-code replacement commit together
      // or not at all: a partial commit would leave the user with codes that do
      // not match the stored factor.
      await this.prisma.$transaction(async (tx) => {
        await tx.userTotpFactor.update({
          where: { userId },
          data: {
            secret: enrollmentSecretValue as Prisma.InputJsonValue,
            label: factor.pendingLabel ?? factor.label,
            pendingSecret: Prisma.DbNull,
            pendingLabel: null,
            pendingStartedAt: null,
            enrolledAt:
              factor.pendingSecret && factor.verifiedAt && !factor.disabledAt
                ? verifiedAt
                : factor.enrolledAt,
            verifiedAt,
            disabledAt: null,
            lastUsedAt: verifiedAt,
          },
        });
        await tx.userRecoveryCode.deleteMany({
          where: { userId },
        });
        await tx.userRecoveryCode.createMany({
          data: recoveryCodes.map((rawCode) => ({
            userId,
            codeHash: hashOpaqueToken(rawCode),
          })),
        });
      });

      // AF3: the committed change must be visible on the next profile read in
      // every organization the user belongs to. This runs after the commit,
      // still inside the per-user lock, and never replays the transaction, so a
      // cache failure cannot regenerate the recovery codes.
      await this.invalidateProfileCache(userId);
    });

    return {
      recoveryCodes,
      ...(await this.getStatus(userId)),
    };
  }

  async disable(userId: string, code: string) {
    await this.assertHumanMfaActor(userId);

    await withMfaUserLock(userId, async () => {
      // AF2: recovery-code consumption, the lastUsedAt refresh, the disable
      // write and the recovery-code deletion share one transaction. A failure
      // anywhere rolls the whole management action back, so a consumed code can
      // never authorize an action that did not commit.
      await this.prisma.$transaction(async (tx) => {
        await this.verifyFactorOrRecoveryCode(tx, userId, code);
        await tx.userTotpFactor.updateMany({
          where: { userId },
          data: {
            disabledAt: new Date(),
          },
        });
        await tx.userRecoveryCode.deleteMany({
          where: { userId },
        });
      });

      await this.invalidateProfileCache(userId);
    });

    return this.getStatus(userId);
  }

  async rotateRecoveryCodes(userId: string, code: string) {
    await this.assertHumanMfaActor(userId);

    // Generated once, before the transaction: the response must always carry
    // the exact set this call commits, and the set must never be regenerated by
    // a retry.
    const recoveryCodes = generateRecoveryCodes();
    await withMfaUserLock(userId, async () => {
      // AF2: the authorization (TOTP window check or single-use recovery-code
      // claim) and the whole replacement are one transaction, so two concurrent
      // rotations cannot each be authorized against the old set and then
      // overwrite each other.
      await this.prisma.$transaction(async (tx) => {
        await this.verifyFactorOrRecoveryCode(tx, userId, code);
        await tx.userRecoveryCode.deleteMany({
          where: { userId },
        });
        await tx.userRecoveryCode.createMany({
          data: recoveryCodes.map((rawCode) => ({
            userId,
            codeHash: hashOpaqueToken(rawCode),
          })),
        });
      });
    });

    return {
      recoveryCodes,
      ...(await this.getStatus(userId)),
    };
  }

  async getLoginRequirement(userId: string, orgId: string) {
    const factor = await this.prisma.userTotpFactor.findUnique({
      where: { userId },
      select: {
        verifiedAt: true,
        disabledAt: true,
      },
    });
    const enabled = Boolean(factor?.verifiedAt && !factor?.disabledAt);
    const policy = await this.authSecurity.getMfaPolicy();

    if (policy === "off") {
      return enabled ? "verify" : "none";
    }

    const isAdmin = await this.isOrgAdmin(userId, orgId);
    const applies =
      policy === "all_users" || (policy === "admins_only" && isAdmin);
    if (!applies) {
      return enabled ? "verify" : "none";
    }
    return enabled ? "verify" : "enroll";
  }

  async shouldRequireMfa(userId: string, orgId: string) {
    return (await this.getLoginRequirement(userId, orgId)) === "verify";
  }

  async createLoginChallenge(params: {
    userId: string;
    orgId: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const challenge = await this.prisma.authChallenge.create({
      data: {
        type: "mfa_login",
        userId: params.userId,
        orgId: params.orgId,
        payload: {
          orgId: params.orgId,
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
        } satisfies Prisma.InputJsonObject,
        expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MINUTES * 60_000),
      },
    });

    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  async createEnrollmentChallenge(params: {
    userId: string;
    orgId: string;
    ipAddress?: string;
    userAgent?: string;
    action?: string;
  }) {
    const challenge = await this.prisma.authChallenge.create({
      data: {
        type: "mfa_enrollment",
        userId: params.userId,
        orgId: params.orgId,
        payload: {
          orgId: params.orgId,
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
          action: params.action ?? "login",
        } satisfies Prisma.InputJsonObject,
        expiresAt: new Date(
          Date.now() + MFA_ENROLLMENT_CHALLENGE_TTL_MINUTES * 60_000,
        ),
      },
    });

    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  async beginEnrollmentWithChallenge(
    challengeId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const challenge = await this.getActiveChallenge(
      challengeId,
      "mfa_enrollment",
      "MFA enrollment challenge is invalid or expired",
    );
    if (!challenge.userId) {
      throw new UnauthorizedException(
        "MFA enrollment challenge is invalid or expired",
      );
    }

    // The enrollment challenge id travels through URL redirects (browser
    // history, referrers, logs). Bind it to the party that initiated the
    // flow so a third party holding only the id cannot enroll their own TOTP
    // device and take over the account.
    this.assertChallengeRequesterMatches(challenge, ipAddress, userAgent);

    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      select: {
        email: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException(
        "MFA enrollment challenge is invalid or expired",
      );
    }

    return this.beginEnrollment(challenge.userId, user.email);
  }

  async consumeLoginChallenge(challengeId: string, code: string) {
    const invalidChallengeMessage = "MFA challenge is invalid or expired";
    const challenge = await this.getActiveChallenge(
      challengeId,
      "mfa_login",
      invalidChallengeMessage,
    );
    if (!challenge.userId) {
      throw new UnauthorizedException(invalidChallengeMessage);
    }
    // Capture the narrowed id: TypeScript drops property narrowing inside the
    // transaction callback below.
    const challengeUserId = challenge.userId;

    try {
      // The public login challenge keeps its original single-use guarantee: the
      // recovery-code claim and the lastUsedAt refresh commit together, and the
      // challenge is only consumed after the credential verified.
      await this.prisma.$transaction(async (tx) => {
        await this.verifyFactorOrRecoveryCode(tx, challengeUserId, code);
      });
    } catch (error) {
      return this.recordChallengeFailure(
        challenge.id,
        invalidChallengeMessage,
        error,
      );
    }

    await this.consumeChallengeOrThrow(challenge.id, invalidChallengeMessage);

    const payload = this.parseLoginChallengePayload(challenge.payload);
    return {
      userId: challenge.userId,
      orgId: payload.orgId ?? challenge.orgId ?? "",
      ipAddress: payload.ipAddress ?? null,
      userAgent: payload.userAgent ?? null,
      action: payload.action ?? "login",
    };
  }

  async consumeEnrollmentChallenge(
    challengeId: string,
    code: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const invalidChallengeMessage =
      "MFA enrollment challenge is invalid or expired";
    const challenge = await this.getActiveChallenge(
      challengeId,
      "mfa_enrollment",
      invalidChallengeMessage,
    );
    if (!challenge.userId) {
      throw new UnauthorizedException(invalidChallengeMessage);
    }

    this.assertChallengeRequesterMatches(challenge, ipAddress, userAgent);

    // Atomically claim the challenge BEFORE verifyEnrollment: verifyEnrollment
    // rotates the TOTP secret and regenerates the recovery codes, so two
    // concurrent completes must not both run it — the loser's rotation would
    // invalidate the recovery codes returned to the winner.
    await this.consumeChallengeOrThrow(challenge.id, invalidChallengeMessage);

    let enrollment: Awaited<ReturnType<typeof this.verifyEnrollment>>;
    try {
      enrollment = await this.verifyEnrollment(challenge.userId, code);
    } catch (error) {
      if (this.isMfaCodeFailure(error)) {
        // Wrong code: give the challenge back so the user can retry with the
        // same challenge instead of restarting the whole enrollment flow.
        await this.prisma.authChallenge
          .updateMany({
            where: { id: challenge.id, consumedAt: { not: null } },
            data: { consumedAt: null },
          })
          .catch(() => undefined);
      }
      return this.recordChallengeFailure(
        challenge.id,
        invalidChallengeMessage,
        error,
      );
    }

    const payload = this.parseLoginChallengePayload(challenge.payload);
    return {
      userId: challenge.userId,
      orgId: payload.orgId ?? challenge.orgId ?? "",
      ipAddress: payload.ipAddress ?? null,
      userAgent: payload.userAgent ?? null,
      action: payload.action ?? "login",
      recoveryCodes: enrollment.recoveryCodes,
    };
  }

  /**
   * Verifies either the current TOTP code or one unused recovery code against
   * an explicit Prisma client.
   *
   * The client is always supplied by the caller so the credential check and the
   * caller's own state change share one transaction (AF2). Passing
   * `PrismaService` keeps the public login path on its original semantics;
   * passing a `Prisma.TransactionClient` never opens a second, nested
   * transaction.
   */
  private async verifyFactorOrRecoveryCode(
    client: Prisma.TransactionClient,
    userId: string,
    code: string,
  ): Promise<"totp" | "recovery_code"> {
    const factor = await client.userTotpFactor.findUnique({
      where: { userId },
    });
    const secret = factor
      ? await this.authSecurity.decodeSecret(factor.secret)
      : null;
    if (
      factor &&
      factor.verifiedAt &&
      !factor.disabledAt &&
      secret &&
      verifyTotpCode(secret, code)
    ) {
      await client.userTotpFactor.update({
        where: { userId },
        data: {
          lastUsedAt: new Date(),
        },
      });
      return "totp";
    }

    const recoveryCode = await client.userRecoveryCode.findFirst({
      where: {
        userId,
        codeHash: hashOpaqueToken(code.trim().toUpperCase()),
        usedAt: null,
      },
    });
    if (!recoveryCode) {
      throw new UnauthorizedException("Invalid MFA verification code");
    }
    // Atomic single-use claim: two concurrent operations must not both consume
    // the same recovery code (the findFirst above is racy on its own). The
    // conditional update and the affected-row check stay exactly as they were;
    // only the client changed, so the claim now participates in the caller's
    // transaction.
    const claimed = await client.userRecoveryCode.updateMany({
      where: { id: recoveryCode.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new UnauthorizedException("Invalid MFA verification code");
    }
    await client.userTotpFactor.updateMany({
      where: { userId },
      data: { lastUsedAt: new Date() },
    });
    return "recovery_code";
  }

  /**
   * AF5: every authenticated MFA write route requires a real human `User`.
   *
   * Machine access tokens authenticate through `JwtAuthGuard` as
   * `machine:<tokenId>`, which is not a `User` row. Rejecting them here keeps
   * the request away from the `UserTotpFactor.userId` foreign key (which would
   * otherwise fail as a generic 500) and is deliberately scoped to these four
   * routes: `GET /auth/mfa` keeps returning the empty factor state for machine
   * identities, and the OIDC tenant settings keep their machine-token boundary.
   */
  private async assertHumanMfaActor(userId: string): Promise<void> {
    if (isMachineActorId(userId)) {
      throw new ForbiddenException(MFA_HUMAN_REQUIRED_MESSAGE);
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new ForbiddenException(MFA_HUMAN_REQUIRED_MESSAGE);
    }
  }

  /**
   * AF3: drops the cached authenticated profile for this user in every
   * organization they belong to.
   *
   * `mfaEnabled` is part of the cached profile (`AuthService.getUserProfile` →
   * `buildAuthenticatedUser` → `MfaService.getStatus`), and the MFA factor is a
   * global user state, so leaving the other organizations' entries in place
   * would keep showing a stale `mfaEnabled` until the TTL expires. Only this
   * user's keys are touched.
   */
  private async invalidateProfileCache(userId: string): Promise<void> {
    await this.cache.del(`profile:${userId}:default`);

    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { orgId: true },
    });
    for (const membership of memberships) {
      await this.cache.del(`profile:${userId}:${membership.orgId}`);
    }
  }

  private get maxChallengeAttempts() {
    return Math.max(
      1,
      Math.floor(this.env.authMfaChallengeConfig.maxAttempts),
    );
  }

  private async consumeChallengeOrThrow(challengeId: string, message: string) {
    const result = await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        lockedAt: null,
        failedAttempts: { lt: this.maxChallengeAttempts },
        expiresAt: { gt: new Date() },
      },
      data: {
        consumedAt: new Date(),
      },
    });
    if (result.count !== 1) {
      await this.throwInactiveChallenge(challengeId, message);
    }
  }

  private async recordChallengeFailure(
    challengeId: string,
    message: string,
    error: unknown,
  ): Promise<never> {
    if (!this.isMfaCodeFailure(error)) {
      throw error;
    }

    const result = await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        lockedAt: null,
        failedAttempts: { lt: this.maxChallengeAttempts },
        expiresAt: { gt: new Date() },
      },
      data: {
        failedAttempts: { increment: 1 },
      },
    });
    if (result.count !== 1) {
      await this.throwInactiveChallenge(challengeId, message);
    }

    const updated = await this.prisma.authChallenge.findUnique({
      where: { id: challengeId },
      select: { failedAttempts: true },
    });
    if ((updated?.failedAttempts ?? 0) >= this.maxChallengeAttempts) {
      await this.lockChallenge(challengeId);
      throw new TooManyRequestsException(MFA_CHALLENGE_LOCKED_MESSAGE);
    }

    throw error;
  }

  private async throwInactiveChallenge(
    challengeId: string,
    message: string,
  ): Promise<never> {
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { id: challengeId },
      select: {
        failedAttempts: true,
        lockedAt: true,
      },
    });
    if (
      challenge?.lockedAt ||
      (challenge?.failedAttempts ?? 0) >= this.maxChallengeAttempts
    ) {
      await this.lockChallenge(challengeId);
      throw new TooManyRequestsException(MFA_CHALLENGE_LOCKED_MESSAGE);
    }

    throw new UnauthorizedException(message);
  }

  private async lockChallenge(challengeId: string) {
    await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        lockedAt: null,
      },
      data: {
        lockedAt: new Date(),
      },
    });
  }

  private isMfaCodeFailure(error: unknown) {
    if (!(error instanceof HttpException)) {
      return false;
    }

    const response = error.getResponse();
    if (typeof response === "string") {
      return response === MFA_CODE_FAILURE_MESSAGE;
    }
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return error.message === MFA_CODE_FAILURE_MESSAGE;
    }

    const message = (response as { message?: unknown }).message;
    if (typeof message === "string") {
      return message === MFA_CODE_FAILURE_MESSAGE;
    }
    return (
      Array.isArray(message) && message.includes(MFA_CODE_FAILURE_MESSAGE)
    );
  }

  private async isOrgAdmin(userId: string, orgId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          userId,
          orgId,
        },
      },
      include: {
        role: true,
        roles: {
          include: {
            role: true,
          },
        },
      },
    });
    if (!membership) {
      return false;
    }

    const names = [
      membership.role?.name,
      ...(membership.roles ?? []).map((entry) => entry.role?.name),
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());

    return names.includes("admin");
  }

  private assertChallengeRequesterMatches(
    challenge: {
      payload: Prisma.JsonValue;
    },
    ipAddress?: string,
    userAgent?: string,
  ) {
    const payload = this.parseLoginChallengePayload(challenge.payload);
    if (!payload.ipAddress && !payload.userAgent) {
      return;
    }

    if (payload.ipAddress && ipAddress) {
      const recordedIp = this.normalizeIp(payload.ipAddress);
      const callerIp = this.normalizeIp(ipAddress);
      if (callerIp && recordedIp && recordedIp !== callerIp) {
        throw new UnauthorizedException(
          "MFA enrollment challenge is invalid or expired",
        );
      }
    }

    if (payload.userAgent && userAgent && payload.userAgent !== userAgent) {
      throw new UnauthorizedException(
        "MFA enrollment challenge is invalid or expired",
      );
    }
  }

  private normalizeIp(ip: string): string {
    return ip.trim().replace(/^::ffff:/, "").toLowerCase();
  }

  private parseLoginChallengePayload(
    value: Prisma.JsonValue,
  ): Partial<LoginChallengePayload> {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return {};
    }

    return {
      orgId: typeof value.orgId === "string" ? value.orgId : undefined,
      ipAddress:
        typeof value.ipAddress === "string" ? value.ipAddress : undefined,
      userAgent:
        typeof value.userAgent === "string" ? value.userAgent : undefined,
      action: typeof value.action === "string" ? value.action : undefined,
    };
  }

  private async getActiveChallenge(
    challengeId: string,
    type: "mfa_login" | "mfa_enrollment",
    message: string,
  ) {
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { id: challengeId },
    });
    if (!challenge || challenge.type !== type) {
      throw new UnauthorizedException(message);
    }
    if (
      challenge.lockedAt ||
      challenge.failedAttempts >= this.maxChallengeAttempts
    ) {
      await this.lockChallenge(challenge.id);
      throw new TooManyRequestsException(MFA_CHALLENGE_LOCKED_MESSAGE);
    }
    if (challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException(message);
    }
    return challenge;
  }
}
