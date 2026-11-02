import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { QualityContent } from "./quality-content";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      accessToken: "token",
      permissions: ["settings.manage"],
      user: { id: "user-1", permissions: ["settings.manage"] },
    },
  }),
}));

vi.mock("socket.io-client", () => {
  const socket = {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  return { io: vi.fn(() => socket) };
});

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => ({
    get: (...args: unknown[]) => apiMock.get(...args),
    post: (...args: unknown[]) => apiMock.post(...args),
  }),
}));

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: vi.fn(),
}));

const REVIEW_ITEM = {
  id: "review-1",
  evidenceId: null,
  processedItemId: null,
  itemMetaId: null,
  sourceId: null,
  sourceType: null,
  articleUrl: null,
  articleTitle: "Sample article",
  articleSummary: null,
  predictedCategoryPath: "/world",
  predictedLegacyCategory: null,
  predictedConfidence: 0.82,
  predictedMethod: "llm",
  candidatePaths: [],
  status: "pending",
  correctedCategoryPath: null,
  note: null,
  quickTags: [],
  reviewerId: null,
  reviewedAt: null,
};

beforeEach(() => {
  apiMock.get.mockImplementation((url: string) => {
    if (url === "admin/quality/overview") {
      return Promise.resolve({
        data: {
          pipeline: null,
          newsSources: null,
          taskLogs: { items: [], summary: null },
          generatedAt: new Date().toISOString(),
        },
      });
    }
    if (url === "admin/quality/classification/summary") {
      return Promise.resolve({ data: null });
    }
    if (url === "admin/quality/classification/reviews/queue") {
      return Promise.resolve({ data: [REVIEW_ITEM] });
    }
    return Promise.resolve({ data: null });
  });
  apiMock.post.mockResolvedValue({ data: {} });
});

describe("QualityContent classification review", () => {
  it("opens an in-page modal to correct a single review and submits the corrected path", async () => {
    renderWithProviders(<QualityContent />);

    fireEvent.click(await screen.findByRole("tab", { name: "Classification" }));

    const correctButton = await screen.findByRole("button", {
      name: "Correct",
    });
    fireEvent.click(correctButton);

    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "/world/politics" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "admin/quality/classification/reviews/review-1/decision",
        { status: "corrected", correctedCategoryPath: "/world/politics" },
      );
    });
  }, 20000);
});
