import type { AuthenticatedUser } from "../../modules/auth/auth.service";

import { AdminErrorsController } from "./admin-errors.controller";

describe("AdminErrorsController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    email: "demo@example.com",
    orgId: "org-1",
    roleIds: ["role-1"],
    permissions: ["settings.manage"],
    firstName: "Demo",
    lastName: "User",
  };

  const exceptionEvents = {
    list: jest.fn().mockResolvedValue({ total: 0, items: [] }),
    stats: jest.fn().mockResolvedValue({ total: 0, byKind: [], byDay: [] }),
  };

  let controller: AdminErrorsController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new AdminErrorsController(exceptionEvents as any);
  });

  it("passes list filters including operationName and messageContains", async () => {
    await controller.list(
      user,
      "20",
      "0",
      "graphql",
      " newsEventBrief ",
      " invalid JSON ",
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.999Z",
    );

    expect(exceptionEvents.list).toHaveBeenCalledWith({
      limit: 20,
      offset: 0,
      orgId: "org-1",
      kind: "graphql",
      operationName: "newsEventBrief",
      messageContains: "invalid JSON",
      start: "2026-02-01T00:00:00.000Z",
      end: "2026-02-28T23:59:59.999Z",
    });
  });

  it("passes stats filters including operationName and messageContains", async () => {
    await controller.stats(
      user,
      "graphql",
      "newsEventBrief",
      "invalid JSON for news event brief",
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.999Z",
    );

    expect(exceptionEvents.stats).toHaveBeenCalledWith({
      orgId: "org-1",
      kind: "graphql",
      operationName: "newsEventBrief",
      messageContains: "invalid JSON for news event brief",
      start: "2026-02-01T00:00:00.000Z",
      end: "2026-02-28T23:59:59.999Z",
    });
  });
});
