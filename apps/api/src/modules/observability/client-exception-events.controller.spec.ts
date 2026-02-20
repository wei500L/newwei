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

  let controller: ClientExceptionEventsController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new ClientExceptionEventsController(exceptionEvents as any);
  });

  it("throws when message is missing", async () => {
    await expect(
      controller.report(
        user,
        "trace-1",
        {
          kind: "http"
        }
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(exceptionEvents.record).not.toHaveBeenCalled();
  });

  it("records normalized event and uses current user context", async () => {
    await expect(
      controller.report(user, "trace-from-header", {
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
  });

  it("falls back to body traceId when x-trace-id is absent", async () => {
    await controller.report(user, undefined, {
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
});
