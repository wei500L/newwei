import { BadRequestException } from "@nestjs/common";

import type { AuthenticatedUser } from "../auth/auth.service";

import { ClientExceptionEventsController } from "./client-exception-events.controller";

describe("ClientExceptionEventsController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    email: "demo@example.com",
    orgId: "org-1",
    roleIds: ["role-1"],
    permissions: ["items.read"],
    firstName: "Demo",
    lastName: "User"
  };

  const exceptionEvents = {
    record: jest.fn()
  };
  const rateLimiter = {
    consume: jest.fn().mockResolvedValue(true)
  };
  const env = {
    observabilityClientExceptionRateLimit: {
      userLimit: 30,
      ipLimit: 120,
      windowSeconds: 45
    }
  };
  const request = {
    ip: "127.0.0.1",
    headers: {}
  };

  let controller: ClientExceptionEventsController;

  beforeEach(() => {
    jest.resetAllMocks();
    rateLimiter.consume.mockResolvedValue(true);
    controller = new ClientExceptionEventsController(
      exceptionEvents as any,
      rateLimiter as any,
      env as any
    );
  });

  it("throws when message is missing", async () => {
    await expect(
      controller.report(
        user,
        request as any,
        "trace-1",
        {
          kind: "http"
        }
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(exceptionEvents.record).not.toHaveBeenCalled();
    expect(rateLimiter.consume).not.toHaveBeenCalled();
  });

  it("records normalized event and uses current user context", async () => {
    await expect(
      controller.report(user, request as any, "trace-from-header", {
        kind: "http",
        traceId: "trace-from-body",
        timestamp: "2026-02-20T10:11:12.000Z",
        statusCode: 502,
        message: " Auth service unavailable ",
        path: "/api/organizations/switch",
        method: "post",
        operation: "organization-switch",
        operationName: "web-api-organization-switch",
        errorName: "AbortError",
        stack: "stack should be ignored",
        orgId: "forged-org",
        userId: "forged-user"
      })
    ).resolves.toEqual({ ok: true });

    expect(exceptionEvents.record).toHaveBeenCalledWith({
      kind: "http",
      traceId: "trace-from-header",
      timestamp: "2026-02-20T10:11:12.000Z",
      statusCode: 502,
      message: "Auth service unavailable",
      path: "/api/organizations/switch",
      method: "POST",
      operation: "organization-switch",
      operationName: "web-api-organization-switch",
      errorName: "AbortError",
      stack: undefined,
      orgId: "org-1",
      userId: "user-1"
    });
    expect(rateLimiter.consume).toHaveBeenNthCalledWith(
      1,
      "observability:client-exception:user:org-1:user-1",
      30,
      45
    );
    expect(rateLimiter.consume).toHaveBeenNthCalledWith(
      2,
      "observability:client-exception:ip:org-1:127.0.0.1",
      120,
      45
    );
  });

  it("falls back to body traceId when x-trace-id is absent", async () => {
    await controller.report(user, request as any, undefined, {
      kind: "unknown",
      traceId: "trace-from-body",
      message: "something failed"
    });

    expect(exceptionEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-from-body"
      })
    );
  });

  it("throws when client event ingestion is rate limited", async () => {
    rateLimiter.consume.mockResolvedValueOnce(false);

    await expect(
      controller.report(user, request as any, "trace-rate-limit", {
        kind: "http",
        message: "rate limited"
      })
    ).rejects.toMatchObject({ status: 429 });

    expect(exceptionEvents.record).not.toHaveBeenCalled();
  });

  it("throws when message exceeds max length", async () => {
    const longMessage = "x".repeat(1_001);

    await expect(
      controller.report(user, request as any, "trace-long", {
        kind: "http",
        message: longMessage
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(exceptionEvents.record).not.toHaveBeenCalled();
    expect(rateLimiter.consume).not.toHaveBeenCalled();
  });
});
