import {
  Prisma,
  AnalysisSubjectType,
  SavedAnalysisSurface,
  SavedAnalysisVisibility,
} from ".prisma/client";

import { AnalysisWorkspaceService } from "./analysis-workspace.service";

const prismaMock = {
  savedAnalysisView: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  analysisThread: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  analysisComment: {
    create: jest.fn(),
  },
  itemMeta: {
    findFirst: jest.fn(),
  },
  newsEvent: {
    findFirst: jest.fn(),
  },
} as any;

function createService() {
  return new AnalysisWorkspaceService(
    prismaMock,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function createSavedViewRow(overrides?: Partial<any>) {
  return {
    id: "view-1",
    title: "Shared view",
    description: null,
    surface: SavedAnalysisSurface.search,
    routePath: "/search",
    queryState: { queryString: "q=test" },
    visibility: SavedAnalysisVisibility.org_shared,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    createdById: "owner-1",
    createdBy: {
      id: "owner-1",
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "User",
      avatarUrl: null,
    },
    updatedBy: {
      id: "owner-1",
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "User",
      avatarUrl: null,
    },
    ...overrides,
  };
}

function createThreadRow(overrides?: Partial<any>) {
  return {
    id: "thread-1",
    orgId: "org-1",
    createdById: "user-1",
    updatedById: "user-1",
    subjectType: AnalysisSubjectType.item,
    subjectId: "item-1",
    noteMarkdown: "note",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    createdBy: {
      id: "user-1",
      email: "user@example.com",
      firstName: "User",
      lastName: "One",
      avatarUrl: null,
    },
    updatedBy: {
      id: "user-1",
      email: "user@example.com",
      firstName: "User",
      lastName: "One",
      avatarUrl: null,
    },
    comments: [],
    ...overrides,
  };
}

describe("AnalysisWorkspaceService", () => {
  let service: AnalysisWorkspaceService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = createService();
  });

  it("preserves delegated permissions when listing shared views", async () => {
    prismaMock.savedAnalysisView.findMany.mockResolvedValue([
      createSavedViewRow(),
    ]);

    const rows = await service.listViews(
      "org-1",
      { id: "manager-1", permissions: ["users.write"] },
      { scope: "shared" },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.canEdit).toBe(true);
  });

  it("preserves delegated permissions when loading a shared view", async () => {
    prismaMock.savedAnalysisView.findFirst.mockResolvedValue(
      createSavedViewRow(),
    );

    const row = await service.getView(
      "org-1",
      {
        id: "manager-1",
        permissions: ["users.write"],
      },
      "view-1",
    );

    expect(row.canEdit).toBe(true);
  });

  it("reuses an existing thread when first note creation loses a unique race", async () => {
    prismaMock.itemMeta.findFirst.mockResolvedValue({ id: "item-1" });
    prismaMock.analysisThread.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createThreadRow({ noteMarkdown: null }));
    prismaMock.analysisThread.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    prismaMock.analysisThread.update.mockResolvedValue(
      createThreadRow({
        updatedById: "user-2",
        noteMarkdown: "new note",
        updatedBy: {
          id: "user-2",
          email: "manager@example.com",
          firstName: "Manager",
          lastName: "User",
          avatarUrl: null,
        },
      }),
    );

    const row = await service.upsertThread(
      "org-1",
      { id: "user-2", permissions: [] },
      AnalysisSubjectType.item,
      "item-1",
      "new note",
    );

    expect(prismaMock.analysisThread.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.analysisThread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: {
        updatedById: "user-2",
        noteMarkdown: "new note",
      },
      include: expect.any(Object),
    });
    expect(row?.noteMarkdown).toBe("new note");
  });

  it("reuses an existing thread when first comment creation loses a unique race", async () => {
    prismaMock.itemMeta.findFirst.mockResolvedValue({ id: "item-1" });
    prismaMock.analysisThread.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "thread-1" });
    prismaMock.analysisThread.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    prismaMock.analysisThread.update.mockResolvedValue({ id: "thread-1" });
    prismaMock.analysisComment.create.mockResolvedValue({
      id: "comment-1",
      createdById: "user-2",
      bodyMarkdown: "first comment",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      createdBy: {
        id: "user-2",
        email: "user@example.com",
        firstName: "User",
        lastName: "Two",
        avatarUrl: null,
      },
    });

    const row = await service.createComment(
      "org-1",
      { id: "user-2", permissions: [] },
      AnalysisSubjectType.item,
      "item-1",
      "first comment",
    );

    expect(prismaMock.analysisThread.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.analysisThread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { updatedById: "user-2" },
    });
    expect(prismaMock.analysisComment.create).toHaveBeenCalledWith({
      data: {
        orgId: "org-1",
        threadId: "thread-1",
        createdById: "user-2",
        bodyMarkdown: "first comment",
      },
      include: expect.any(Object),
    });
    expect(row.bodyMarkdown).toBe("first comment");
  });
});
