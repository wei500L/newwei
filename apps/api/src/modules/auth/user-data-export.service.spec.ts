import { AssistantRunModel } from "@modular/mongo";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

import type { AuthenticatedUser } from "./auth.service";
import { UserDataExportService } from "./user-data-export.service";

jest.mock("@modular/mongo", () => ({
  AssistantRunModel: {
    find: jest.fn(),
  },
}));

describe("UserDataExportService", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    email: "person@example.com",
    orgId: "org-1",
    roleIds: ["role-1"],
    permissions: [],
    firstName: "Person",
    lastName: "One",
  };

  const createPrismaMock = () =>
    ({
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: "user-1",
          email: "person@example.com",
          firstName: "Person",
          lastName: "One",
          recoveryCodes: [{ usedAt: null, createdAt: new Date("2026-01-01") }],
        }),
      },
      membership: {
        findUnique: jest.fn().mockResolvedValue({
          id: "membership-1",
          org: { id: "org-1", slug: "acme-eu", name: "Acme EU" },
        }),
      },
      userSetting: {
        findMany: jest.fn().mockResolvedValue([
          { key: "ui:onboarding:settings:v1", value: { completed: true } },
        ]),
      },
      userContentSubscription: {
        findMany: jest.fn().mockResolvedValue([
          { id: "sub-1", kind: "topic", displayValue: "Energy" },
        ]),
      },
      userNewsBehaviorAggregate: {
        findMany: jest.fn().mockResolvedValue([
          { signalType: "topic", signalKey: "Energy", score: 2 },
        ]),
      },
      userNewsSimilaritySnapshot: {
        findUnique: jest.fn().mockResolvedValue({
          dirty: false,
          computedAt: new Date("2026-02-01T00:00:00Z"),
        }),
      },
      userDigestDeliverySchedule: {
        findUnique: jest.fn().mockResolvedValue({ enabled: true }),
      },
      savedAnalysisView: {
        findMany: jest.fn().mockResolvedValue([{ id: "view-1" }]),
      },
      analysisThread: {
        findMany: jest.fn().mockResolvedValue([{ id: "thread-1" }]),
      },
      analysisComment: {
        findMany: jest.fn().mockResolvedValue([{ id: "comment-1" }]),
      },
      notification: {
        findMany: jest.fn().mockResolvedValue([{ id: "notification-1" }]),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit-1" }),
      },
      auditLogOutbox: {
        create: jest.fn(),
      },
    }) as any;

  const createAssistantFindChain = (runs: unknown[]) => {
    const chain = {
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(runs),
    };
    (AssistantRunModel.find as jest.Mock).mockReturnValue(chain);
    return chain;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("exports the current user's portable data without secret fields", async () => {
    const prisma = createPrismaMock();
    const rateLimiter = { consume: jest.fn().mockResolvedValue(true) };
    const behavior = {
      getProfile: jest.fn().mockResolvedValue({
        actions: {},
        positive: {},
        negative: {},
        net: {},
      }),
    };
    createAssistantFindChain([
      {
        _id: "assistant-1",
        orgId: "org-1",
        type: "query",
        status: "completed",
        input: { message: "hello" },
        triggeredById: "user-1",
        createdAt: new Date("2026-03-01T00:00:00Z"),
      },
    ]);

    const service = new UserDataExportService(
      prisma,
      rateLimiter as any,
      behavior as any,
    );
    const result = await service.exportUserData(user, "127.0.0.1");
    const payload = JSON.parse(result.buffer.toString("utf8"));

    expect(result.filename).toMatch(/^wei-user-data-acme-eu-\d{4}-\d{2}-\d{2}\.json$/);
    expect(payload.format).toBe("wei.user-data-export.v1");
    expect(payload.subject).toEqual({ userId: "user-1", orgId: "org-1" });
    expect(payload.sections.userSettings).toHaveLength(1);
    expect(payload.sections.newsBehavior.profile).toEqual(
      expect.objectContaining({ actions: {} }),
    );
    expect(payload.sections.newsBehavior.similaritySnapshot).not.toHaveProperty(
      "neighbors",
    );
    expect(payload.sections.assistantRuns).toEqual([
      expect.objectContaining({ id: "assistant-1", triggeredById: "user-1" }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("passwordHash");
    expect(JSON.stringify(payload)).not.toContain("tokenHash");
    expect(JSON.stringify(payload)).not.toContain("codeHash");
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          passwordHash: expect.anything(),
        }),
      }),
    );
    expect(AssistantRunModel.find).toHaveBeenCalledWith(
      { orgId: "org-1", triggeredById: "user-1" },
      expect.any(Object),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resource: "data_export",
          action: "download",
          ipAddress: "127.0.0.1",
        }),
      }),
    );
  });

  it("rate limits repeated export requests", async () => {
    const service = new UserDataExportService(
      createPrismaMock(),
      { consume: jest.fn().mockResolvedValue(false) } as any,
      { getProfile: jest.fn() } as any,
    );

    await expect(service.exportUserData(user)).rejects.toThrow(
      TooManyRequestsException,
    );
  });
});
