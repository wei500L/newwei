import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

import { CacheService } from "../cache/cache.service";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

interface PendingTelegramAuthRequest {
  requestId: string;
  orgId: string;
  actorId: string;
  telegramApiId: string;
  telegramApiHash: string;
  phoneNumber: string;
  phoneCodeHash: string;
  session: string;
  createdAt: string;
}

interface StartTelegramAuthInput {
  telegramApiId: string;
  telegramApiHash: string;
  phoneNumber: string;
}

interface CompleteTelegramAuthInput {
  requestId: string;
  phoneCode: string;
  password?: string;
}

interface StartAuthContext {
  clientIp?: string;
}

interface CompletedTelegramAuthSession {
  telegramApiId: string;
  telegramApiHash: string;
  telegramSession: string;
}

const AUTH_CACHE_KEY_PREFIX = "situation-monitor:telegram-auth";
const AUTH_REQUEST_TTL_SECONDS = 10 * 60;
const START_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const START_RATE_LIMIT_PER_USER = 5;
const START_RATE_LIMIT_PER_IP = 15;
const START_RATE_LIMIT_PER_PHONE = 3;
const E164_PHONE_NUMBER_PATTERN = /^\+[1-9]\d{6,14}$/;

@Injectable()
export class SituationMonitorTelegramAuthService {
  private readonly logger = createLogger({ name: "situation-monitor-telegram-auth" });

  constructor(
    private readonly cache: CacheService,
    private readonly rateLimiter: RateLimiterService
  ) {}

  async startAuth(
    orgId: string,
    actorId: string,
    input: StartTelegramAuthInput,
    context?: StartAuthContext
  ): Promise<{ requestId: string; isCodeViaApp: boolean; expiresAt: string }> {
    const telegramApiId = this.normalizeApiId(input.telegramApiId);
    const apiId = Number(telegramApiId);
    const telegramApiHash = this.requireValue(input.telegramApiHash, "telegramApiHash");
    const phoneNumber = this.normalizePhoneNumber(input.phoneNumber);
    await this.enforceStartAuthRateLimit(orgId, actorId, phoneNumber, context?.clientIp);

    const client = new TelegramClient(new StringSession(""), apiId, telegramApiHash, {
      connectionRetries: 3,
    });

    try {
      await client.connect();
      const sentCode = await client.sendCode(
        { apiId, apiHash: telegramApiHash },
        phoneNumber
      );

      const requestId = randomUUID();
      const createdAt = new Date().toISOString();
      const expiresAtMs = Date.now() + AUTH_REQUEST_TTL_SECONDS * 1_000;

      const pending: PendingTelegramAuthRequest = {
        requestId,
        orgId,
        actorId,
        telegramApiId,
        telegramApiHash,
        phoneNumber,
        phoneCodeHash: sentCode.phoneCodeHash,
        session: String(client.session.save()),
        createdAt,
      };

      await this.cache.set(
        this.buildCacheKey(requestId),
        pending,
        AUTH_REQUEST_TTL_SECONDS
      );

      return {
        requestId,
        isCodeViaApp: sentCode.isCodeViaApp,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    } catch (error) {
      throw this.toBadRequest(error);
    } finally {
      await this.disconnectClient(client);
    }
  }

  async completeAuth(
    orgId: string,
    actorId: string,
    input: CompleteTelegramAuthInput
  ): Promise<CompletedTelegramAuthSession> {
    const requestId = this.requireValue(input.requestId, "requestId");
    const phoneCode = this.requireValue(input.phoneCode, "phoneCode");
    const password = this.normalizeString(input.password);
    const cacheKey = this.buildCacheKey(requestId);
    const pending = await this.cache.get<PendingTelegramAuthRequest>(cacheKey);

    if (!pending) {
      throw this.badRequest("TELEGRAM_AUTH_REQUEST_EXPIRED");
    }
    if (pending.orgId !== orgId || pending.actorId !== actorId) {
      throw this.badRequest("TELEGRAM_AUTH_REQUEST_MISMATCH");
    }

    const apiId = Number(pending.telegramApiId);
    const client = new TelegramClient(
      new StringSession(pending.session || ""),
      apiId,
      pending.telegramApiHash,
      { connectionRetries: 3 }
    );

    try {
      await client.connect();
      try {
        const result = await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: pending.phoneNumber,
            phoneCodeHash: pending.phoneCodeHash,
            phoneCode,
          })
        );
        if (result instanceof Api.auth.AuthorizationSignUpRequired) {
          throw this.badRequest("TELEGRAM_AUTH_SIGNUP_REQUIRED");
        }
      } catch (error) {
        if (this.isSessionPasswordNeeded(error)) {
          if (!password) {
            throw this.badRequest("TELEGRAM_AUTH_PASSWORD_REQUIRED");
          }
          await client.signInWithPassword(
            { apiId, apiHash: pending.telegramApiHash },
            {
              password: async () => password,
              onError: async (authError) => {
                throw authError;
              },
            }
          );
        } else if (error instanceof BadRequestException) {
          throw error;
        } else {
          throw this.toBadRequest(error);
        }
      }

      const telegramSession = String(client.session.save());
      await this.cache.del(cacheKey);

      return {
        telegramApiId: pending.telegramApiId,
        telegramApiHash: pending.telegramApiHash,
        telegramSession,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw this.toBadRequest(error);
    } finally {
      await this.disconnectClient(client);
    }
  }

  private buildCacheKey(requestId: string): string {
    return `${AUTH_CACHE_KEY_PREFIX}:${requestId}`;
  }

  private normalizeApiId(value: string): string {
    const normalized = this.requireValue(value, "telegramApiId");
    if (!/^\d+$/.test(normalized)) {
      throw this.badRequest("TELEGRAM_AUTH_API_ID_INVALID");
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw this.badRequest("TELEGRAM_AUTH_API_ID_INVALID");
    }
    return String(Math.trunc(parsed));
  }

  private requireValue(value: unknown, fieldName: string): string {
    const normalized = this.normalizeString(value);
    if (!normalized) {
      throw this.badRequest("TELEGRAM_AUTH_INVALID_INPUT", `${fieldName} is required`);
    }
    return normalized;
  }

  private normalizePhoneNumber(value: unknown): string {
    const phoneNumber = this.requireValue(value, "phoneNumber");
    if (!E164_PHONE_NUMBER_PATTERN.test(phoneNumber)) {
      throw this.badRequest("TELEGRAM_AUTH_PHONE_FORMAT_INVALID");
    }
    return phoneNumber;
  }

  private async enforceStartAuthRateLimit(
    orgId: string,
    actorId: string,
    phoneNumber: string,
    clientIp?: string
  ): Promise<void> {
    await this.consumeStartRateLimit(
      `situation-monitor:telegram-auth-start:user:${orgId}:${actorId}`,
      START_RATE_LIMIT_PER_USER
    );
    const normalizedIp = this.normalizeString(clientIp);
    if (normalizedIp) {
      await this.consumeStartRateLimit(
        `situation-monitor:telegram-auth-start:ip:${orgId}:${normalizedIp}`,
        START_RATE_LIMIT_PER_IP
      );
    }
    const phoneHash = createHash("sha256").update(phoneNumber).digest("hex");
    await this.consumeStartRateLimit(
      `situation-monitor:telegram-auth-start:phone:${orgId}:${phoneHash}`,
      START_RATE_LIMIT_PER_PHONE
    );
  }

  private async consumeStartRateLimit(key: string, limit: number): Promise<void> {
    if (!limit || limit <= 0) {
      return;
    }
    const allowed = await this.rateLimiter.consume(
      key,
      limit,
      START_RATE_LIMIT_WINDOW_SECONDS
    );
    if (!allowed) {
      throw this.tooManyRequests("TELEGRAM_AUTH_RATE_LIMIT");
    }
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private isSessionPasswordNeeded(error: unknown): boolean {
    const value = this.toErrorMessage(error);
    return value.toUpperCase().includes("SESSION_PASSWORD_NEEDED");
  }

  private toBadRequest(error: unknown): BadRequestException {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (
        typeof response === "object" &&
        response !== null &&
        "code" in response &&
        typeof (response as { code?: unknown }).code === "string"
      ) {
        return error;
      }
      const message = this.toErrorMessage(error);
      if (/^TELEGRAM_AUTH_[A-Z0-9_]+$/.test(message)) {
        return this.badRequest(message);
      }
      return this.badRequest("TELEGRAM_AUTH_INVALID_INPUT", message);
    }

    const message = this.toErrorMessage(error);
    const normalized = message.toUpperCase();

    if (normalized.includes("PHONE_CODE_INVALID") || normalized.includes("CODE_INVALID")) {
      return this.badRequest("TELEGRAM_AUTH_CODE_INVALID");
    }
    if (normalized.includes("PHONE_CODE_EXPIRED")) {
      return this.badRequest("TELEGRAM_AUTH_CODE_EXPIRED");
    }
    if (normalized.includes("PASSWORD_HASH_INVALID")) {
      return this.badRequest("TELEGRAM_AUTH_PASSWORD_INVALID");
    }
    if (normalized.includes("SESSION_PASSWORD_NEEDED")) {
      return this.badRequest("TELEGRAM_AUTH_PASSWORD_REQUIRED");
    }
    if (normalized.includes("FLOOD_WAIT")) {
      return this.badRequest("TELEGRAM_AUTH_RATE_LIMIT");
    }
    if (normalized.includes("PHONE_NUMBER_INVALID")) {
      return this.badRequest("TELEGRAM_AUTH_PHONE_INVALID");
    }
    if (normalized.includes("PHONE_NUMBER_BANNED")) {
      return this.badRequest("TELEGRAM_AUTH_PHONE_BANNED");
    }
    if (normalized.includes("PHONE_NUMBER_UNOCCUPIED")) {
      return this.badRequest("TELEGRAM_AUTH_PHONE_UNOCCUPIED");
    }
    if (normalized.includes("PHONE_CODE_EMPTY")) {
      return this.badRequest("TELEGRAM_AUTH_CODE_REQUIRED");
    }
    if (normalized.includes("API_ID_INVALID")) {
      return this.badRequest("TELEGRAM_AUTH_API_ID_INVALID");
    }
    if (normalized.includes("AUTH_RESTART")) {
      return this.badRequest("TELEGRAM_AUTH_RESTART_REQUIRED");
    }

    this.logger.warn({ error }, "Telegram auth request failed");
    return this.badRequest("TELEGRAM_AUTH_FAILED");
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (
      typeof error === "object" &&
      error &&
      "errorMessage" in error &&
      typeof (error as { errorMessage?: unknown }).errorMessage === "string"
    ) {
      return (error as { errorMessage: string }).errorMessage;
    }
    return String(error);
  }

  private async disconnectClient(client: TelegramClient): Promise<void> {
    try {
      await client.disconnect();
    } catch {
      // best effort
    }
  }

  private badRequest(code: string, detail?: string): BadRequestException {
    return new BadRequestException({
      code,
      message: code,
      ...(detail ? { detail } : {}),
    });
  }

  private tooManyRequests(code: string, detail?: string): TooManyRequestsException {
    return new TooManyRequestsException({
      code,
      message: code,
      ...(detail ? { detail } : {}),
    });
  }
}
