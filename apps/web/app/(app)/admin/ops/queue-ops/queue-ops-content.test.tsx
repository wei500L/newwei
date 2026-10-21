import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  QUEUE_OPS_DLQ_QUEUE_NAME,
  QUEUE_OPS_ENDPOINTS,
  QUEUE_OPS_JOBS_PAGE_SIZE,
  type QueueOpsDlqReplayResult,
  type QueueOpsJobDetail,
  type QueueOpsJobSummary,
  type QueueOpsQueue,
} from "@/lib/queue-ops";
import { renderWithProviders } from "@/test/render";

import type { QueueOpsConfirmOptions } from "./queue-ops-confirm";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({
  status: "authenticated" as string,
  permissions: [] as string[],
  globalRoles: [] as string[],
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: sessionState.status,
    data: {
      accessToken: "token",
      permissions: sessionState.permissions,
      user: {
        id: "user-1",
        permissions: sessionState.permissions,
        globalRoles: sessionState.globalRoles,
      },
    },
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) =>
    createElement("a", { href }, children),
}));

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => ({
    get: (...args: unknown[]) => apiMock.get(...args),
    post: (...args: unknown[]) => apiMock.post(...args),
    put: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: vi.fn(),
}));

const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("./queue-ops-confirm", () => ({
  confirmQueueOpsAction: (options: QueueOpsConfirmOptions) =>
    confirmMock(options),
}));

const QUEUE_ALPHA: QueueOpsQueue = {
  name: "itemPipeline",
  counts: {
    waiting: 3,
    active: 1,
    delayed: 0,
    completed: 10,
    failed: 2,
    paused: 0,
  },
  paused: false,
  concurrency: 5,
  isDLQ: false,
};

const QUEUE_DLQ: QueueOpsQueue = {
  name: QUEUE_OPS_DLQ_QUEUE_NAME,
  counts: {
    waiting: 4,
    active: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
    paused: 0,
  },
  paused: true,
  concurrency: null,
  isDLQ: true,
};

const PENDING_JOB: QueueOpsJobSummary = {
  id: "job-pending",
  name: "pipeline-pending",
  timestamp: 1_710_000_000_000,
  processedOn: null,
  finishedOn: null,
  attemptsMade: 0,
  failedReason: "",
  dataPreview: '{"sourceId":"s0"}',
};

const FAILED_JOB: QueueOpsJobSummary = {
  id: "job-failed",
  name: "pipeline-failed",
  timestamp: 1_710_000_100_000,
  processedOn: 1_710_000_110_000,
  finishedOn: 1_710_000_120_000,
  attemptsMade: 3,
  failedReason: "boom",
  dataPreview: '{"sourceId":"s1"}',
};

const ACTIVE_JOB: QueueOpsJobSummary = {
  id: "job-active",
  name: "pipeline-active",
  timestamp: 1_710_000_200_000,
  processedOn: 1_710_000_210_000,
  finishedOn: null,
  attemptsMade: 1,
  failedReason: "",
  dataPreview: '{"sourceId":"s2"}',
};

const DELAYED_JOB: QueueOpsJobSummary = {
  id: "job-delayed",
  name: "pipeline-delayed",
  timestamp: 1_710_000_400_000,
  processedOn: null,
  finishedOn: null,
  attemptsMade: 0,
  failedReason: "",
  dataPreview: '{"sourceId":"s3"}',
};

const DLQ_JOB: QueueOpsJobSummary = {
  id: "dlq-1",
  name: "pipeline-dlq",
  timestamp: 1_710_000_300_000,
  processedOn: null,
  finishedOn: null,
  attemptsMade: 5,
  failedReason: "dlq-failure",
  dataPreview: '{"sourceId":"s9"}',
};

const FAILED_JOB_DETAIL: QueueOpsJobDetail = {
  ...FAILED_JOB,
  data: { sourceId: "s1", payload: { nested: true } },
  opts: { attempts: 3 },
  returnvalue: null,
  stacktrace: ["Error: boom", "    at handler (/app/handler.ts:1:1)"],
  logs: ["log line 1", "log line 2"],
  dataTruncated: true,
  orgId: "org-1",
};

const ACTIVE_JOB_DETAIL: QueueOpsJobDetail = {
  ...ACTIVE_JOB,
  data: { sourceId: "s2" },
  opts: { attempts: 1 },
  returnvalue: null,
  stacktrace: [],
  logs: [],
  dataTruncated: false,
  orgId: null,
};

const DELAYED_JOB_DETAIL: QueueOpsJobDetail = {
  ...DELAYED_JOB,
  data: { sourceId: "s3" },
  opts: { delay: 60_000 },
  returnvalue: null,
  stacktrace: [],
  logs: [],
  dataTruncated: false,
  orgId: "org-3",
};

const DLQ_JOB_DETAIL: QueueOpsJobDetail = {
  ...DLQ_JOB,
  data: { sourceId: "s9" },
  opts: { attempts: 5 },
  returnvalue: null,
  stacktrace: ["Error: dlq-failure"],
  logs: [],
  dataTruncated: false,
  orgId: "org-2",
};

const DLQ_REPLAY_OK: QueueOpsDlqReplayResult = {
  dlqJobId: "dlq-1",
  originalJobId: "job-original",
  originalQueue: "itemPipeline",
  orgId: "org-2",
  newJobId: "job-new",
  replayed: true,
  dlqRemoved: true,
  warning: null,
};

const DLQ_REPLAY_RESIDUAL: QueueOpsDlqReplayResult = {
  ...DLQ_REPLAY_OK,
  dlqRemoved: false,
  warning: "残留",
};

interface ApiMockOptions {
  queues?: QueueOpsQueue[];
  queuesError?: unknown;
  jobsNextCursor?: string | null;
  dlqReplayResults?: QueueOpsDlqReplayResult[];
}

function installApiMock(options: ApiMockOptions = {}): void {
  apiMock.get.mockReset();
  apiMock.post.mockReset();

  apiMock.get.mockImplementation((url: unknown, config?: unknown) => {
    const params =
      (config as { params?: Record<string, unknown> } | undefined)?.params ?? {};
    if (url === QUEUE_OPS_ENDPOINTS.queues) {
      if (options.queuesError) {
        return Promise.reject(options.queuesError);
      }
      return Promise.resolve({
        data: { queues: options.queues ?? [QUEUE_ALPHA, QUEUE_DLQ] },
      });
    }
    if (url === QUEUE_OPS_ENDPOINTS.jobs) {
      const queue = typeof params.queue === "string" ? params.queue : "";
      const state =
        typeof params.state === "string" ? params.state : "waiting";
      if (params.cursor) {
        return Promise.resolve({
          data: { queue, state, jobs: [PENDING_JOB], nextCursor: null },
        });
      }
      if (queue === QUEUE_OPS_DLQ_QUEUE_NAME) {
        return Promise.resolve({
          data: { queue, state, jobs: [DLQ_JOB], nextCursor: null },
        });
      }
      const jobs =
        state === "failed"
          ? [FAILED_JOB]
          : state === "active"
            ? [ACTIVE_JOB]
            : state === "delayed"
              ? [DELAYED_JOB]
              : [PENDING_JOB];
      return Promise.resolve({
        data: { queue, state, jobs, nextCursor: options.jobsNextCursor ?? null },
      });
    }
    if (url === QUEUE_OPS_ENDPOINTS.jobDetail) {
      const jobId = typeof params.jobId === "string" ? params.jobId : "";
      const job =
        jobId === ACTIVE_JOB.id
          ? ACTIVE_JOB_DETAIL
          : jobId === DELAYED_JOB.id
            ? DELAYED_JOB_DETAIL
            : jobId === DLQ_JOB.id
              ? DLQ_JOB_DETAIL
              : FAILED_JOB_DETAIL;
      return Promise.resolve({ data: { job } });
    }
    return Promise.resolve({ data: {} });
  });

  apiMock.post.mockImplementation((url: unknown) => {
    if (url === QUEUE_OPS_ENDPOINTS.dlqReplay) {
      return Promise.resolve({
        data: { results: options.dlqReplayResults ?? [DLQ_REPLAY_OK] },
      });
    }
    if (url === QUEUE_OPS_ENDPOINTS.retryFailed) {
      return Promise.resolve({
        data: { queue: "itemPipeline", matched: 2, retried: 2 },
      });
    }
    return Promise.resolve({ data: {} });
  });
}

const confirmCalls: QueueOpsConfirmOptions[] = [];

async function triggerLastConfirm(): Promise<void> {
  const call = confirmCalls[confirmCalls.length - 1];
  expect(call).toBeDefined();
  await act(async () => {
    await call?.onConfirm();
  });
}

async function renderQueueOpsPage(): Promise<void> {
  const { QueueOpsContent } = await import("./queue-ops-content");
  renderWithProviders(<QueueOpsContent />);
}

async function selectFirstQueue(): Promise<void> {
  const buttons = await screen.findAllByRole("button", { name: "View jobs" });
  fireEvent.click(buttons[0]!);
  await screen.findByRole("tab", { name: "Waiting" });
}

async function switchJobState(label: string): Promise<void> {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

/** 从 Modal 内的元素向上找到 antd 弹窗容器，避免依赖 rc-dialog 的 role 落点。 */
function requireClosestModal(element: Element | null): HTMLElement {
  const modal = element?.closest(".ant-modal");
  if (!(modal instanceof HTMLElement)) {
    throw new Error("Modal container not found");
  }
  return modal;
}

async function openJobDetail(jobId: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: jobId }));
  const dataBlock = await screen.findByTestId("queue-ops-job-data");
  return requireClosestModal(dataBlock);
}

async function openCleanDialog(): Promise<HTMLElement> {
  const cleanButtons = await screen.findAllByRole("button", { name: "Clean" });
  fireEvent.click(cleanButtons[0]!);
  const title = await screen.findByText("Clean queue itemPipeline");
  return requireClosestModal(title);
}

beforeEach(() => {
  sessionState.status = "authenticated";
  sessionState.permissions = ["queue.manage"];
  sessionState.globalRoles = ["platform_admin"];
  confirmCalls.length = 0;
  installApiMock();
  confirmMock.mockReset();
  confirmMock.mockImplementation((options: QueueOpsConfirmOptions) => {
    confirmCalls.push(options);
  });
});

describe("ops console queue ops entry", () => {
  it("shows the entry for platform admins with queue.manage", async () => {
    const { OpsContent } = await import("@/app/(app)/admin/ops/ops-content");
    renderWithProviders(<OpsContent />);

    const link = await screen.findByRole("link", { name: "Queue Operations" });
    expect(link).toHaveAttribute("href", "/admin/ops/queue-ops");
  });

  it("hides the entry without platform_admin", async () => {
    sessionState.permissions = ["crawl.read", "queue.manage"];
    sessionState.globalRoles = [];
    const { OpsContent } = await import("@/app/(app)/admin/ops/ops-content");
    renderWithProviders(<OpsContent />);

    expect(
      await screen.findByRole("link", { name: "Crawl Tasks" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Queue Operations" }),
    ).not.toBeInTheDocument();
  });

  it("hides the entry when queue.manage is missing", async () => {
    sessionState.permissions = ["crawl.read"];
    sessionState.globalRoles = ["platform_admin"];
    const { OpsContent } = await import("@/app/(app)/admin/ops/ops-content");
    renderWithProviders(<OpsContent />);

    await screen.findByRole("link", { name: "Crawl Tasks" });
    expect(
      screen.queryByRole("link", { name: "Queue Operations" }),
    ).not.toBeInTheDocument();
  });
});

describe("QueueOpsContent permission gate", () => {
  it("shows the admin-only hint when platform_admin is missing", async () => {
    sessionState.globalRoles = [];
    await renderQueueOpsPage();

    expect(await screen.findByText("Admin only")).toBeInTheDocument();
    expect(screen.getByText("Admin only description")).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("shows the admin-only hint when queue.manage is missing", async () => {
    sessionState.permissions = ["crawl.read"];
    await renderQueueOpsPage();

    expect(await screen.findByText("Admin only")).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});

describe("QueueOpsContent queues and jobs", () => {
  it("renders the queue list with counters and pause state", async () => {
    await renderQueueOpsPage();

    expect(
      await screen.findByRole("button", { name: "itemPipeline" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: QUEUE_OPS_DLQ_QUEUE_NAME }),
    ).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith(QUEUE_OPS_ENDPOINTS.queues);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByText("DLQ")).toBeInTheDocument();
  });

  it("loads the next job page with the cursor", async () => {
    installApiMock({ jobsNextCursor: "cursor-1" });
    await renderQueueOpsPage();
    await selectFirstQueue();

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(QUEUE_OPS_ENDPOINTS.jobs, {
        params: {
          queue: "itemPipeline",
          state: "waiting",
          cursor: "cursor-1",
          limit: QUEUE_OPS_JOBS_PAGE_SIZE,
        },
      }),
    );
  });

  it("re-fetches the job list when the state changes", async () => {
    await renderQueueOpsPage();
    await selectFirstQueue();

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(QUEUE_OPS_ENDPOINTS.jobs, {
        params: {
          queue: "itemPipeline",
          state: "waiting",
          limit: QUEUE_OPS_JOBS_PAGE_SIZE,
        },
      }),
    );
    expect(
      await screen.findByRole("button", { name: "job-pending" }),
    ).toBeInTheDocument();

    await switchJobState("Failed");

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(QUEUE_OPS_ENDPOINTS.jobs, {
        params: {
          queue: "itemPipeline",
          state: "failed",
          limit: QUEUE_OPS_JOBS_PAGE_SIZE,
        },
      }),
    );
    expect(
      await screen.findByRole("button", { name: "job-failed" }),
    ).toBeInTheDocument();
  });

  it("renders the formatted job data and the truncation hint", async () => {
    await renderQueueOpsPage();
    await selectFirstQueue();
    await switchJobState("Failed");

    await openJobDetail("job-failed");

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        QUEUE_OPS_ENDPOINTS.jobDetail,
        { params: { queue: "itemPipeline", jobId: "job-failed" } },
      ),
    );
    const dataBlock = await screen.findByTestId("queue-ops-job-data");
    expect(dataBlock.textContent).toContain('"sourceId": "s1"');
    expect(
      screen.getByText("Job data is large and has been truncated."),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("queue-ops-job-stacktrace").textContent,
    ).toContain("Error: boom");
  });
});

describe("QueueOpsContent dangerous actions", () => {
  it("pauses a queue only after confirmation", async () => {
    await renderQueueOpsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));

    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]?.title).toBe("Pause queue itemPipeline?");
    expect(apiMock.post).not.toHaveBeenCalled();

    await triggerLastConfirm();

    expect(apiMock.post).toHaveBeenCalledWith(
      QUEUE_OPS_ENDPOINTS.pauseQueue,
      { queue: "itemPipeline" },
    );
  });

  it("resumes a paused queue only after confirmation", async () => {
    await renderQueueOpsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(confirmCalls[0]?.title).toBe("Resume queue itemPipelineDlq?");

    await triggerLastConfirm();

    expect(apiMock.post).toHaveBeenCalledWith(
      QUEUE_OPS_ENDPOINTS.resumeQueue,
      { queue: QUEUE_OPS_DLQ_QUEUE_NAME },
    );
  });

  it("cleans a queue through the clean modal", async () => {
    await renderQueueOpsPage();

    const dialog = await openCleanDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clean" }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        QUEUE_OPS_ENDPOINTS.cleanQueue,
        { queue: "itemPipeline", state: "completed", grace: 0, limit: 100 },
      ),
    );
  });

  it("batch retries failed jobs only after confirmation", async () => {
    await renderQueueOpsPage();
    await selectFirstQueue();
    await switchJobState("Failed");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Retry failed jobs (up to 100)",
      }),
    );
    expect(confirmCalls[0]?.title).toBe("Retry failed jobs?");
    expect(apiMock.post).not.toHaveBeenCalled();

    await triggerLastConfirm();

    expect(apiMock.post).toHaveBeenCalledWith(
      QUEUE_OPS_ENDPOINTS.retryFailed,
      { queue: "itemPipeline", limit: 100 },
    );
  });

  it("retries a failed job from the detail modal", async () => {
    await renderQueueOpsPage();
    await selectFirstQueue();
    await switchJobState("Failed");

    const dialog = await openJobDetail("job-failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

    expect(confirmCalls[0]?.title).toBe("Retry job job-failed?");
    await triggerLastConfirm();

    expect(apiMock.post).toHaveBeenCalledWith(QUEUE_OPS_ENDPOINTS.retryJob, {
      queue: "itemPipeline",
      jobId: "job-failed",
    });
  });

  it("deletes a failed job from the detail modal", async () => {
    await renderQueueOpsPage();
    await selectFirstQueue();
    await switchJobState("Failed");

    const dialog = await openJobDetail("job-failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(confirmCalls[0]?.title).toBe("Delete job job-failed?");
    await triggerLastConfirm();

    expect(apiMock.post).toHaveBeenCalledWith(QUEUE_OPS_ENDPOINTS.deleteJob, {
      queue: "itemPipeline",
      jobId: "job-failed",
    });
  });

  it("promotes a delayed job from the detail modal", async () => {
    await renderQueueOpsPage();
    await selectFirstQueue();
    await switchJobState("Delayed");

    const dialog = await openJobDetail("job-delayed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Promote" }));

    expect(confirmCalls[0]?.title).toBe("Promote job job-delayed?");
    await triggerLastConfirm();

    expect(apiMock.post).toHaveBeenCalledWith(
      QUEUE_OPS_ENDPOINTS.promoteJob,
      { queue: "itemPipeline", jobId: "job-delayed" },
    );
  });

  it("disables delete for active jobs and explains why", async () => {
    await renderQueueOpsPage();
    await selectFirstQueue();
    await switchJobState("Active");

    const dialog = await openJobDetail("job-active");

    expect(
      within(dialog).getByRole("button", { name: "Delete" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(
        "Active jobs cannot be deleted; wait for the job to finish.",
      ),
    ).toBeInTheDocument();
  });
});

describe("QueueOpsContent DLQ", () => {
  it("replays a dead letter after confirmation", async () => {
    await renderQueueOpsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));

    expect(confirmCalls[0]?.title).toBe("Replay this dead letter?");
    await triggerLastConfirm();

    expect(apiMock.post).toHaveBeenCalledWith(QUEUE_OPS_ENDPOINTS.dlqReplay, {
      jobId: "dlq-1",
    });
  });

  it("warns when the DLQ entry remains after a successful replay", async () => {
    installApiMock({ dlqReplayResults: [DLQ_REPLAY_RESIDUAL] });
    await renderQueueOpsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    await triggerLastConfirm();

    expect(
      await screen.findByText(
        "Replay succeeded but the DLQ entry remains; replaying again will not enqueue a duplicate",
      ),
    ).toBeInTheDocument();
  });

  it("batch replays selected dead letters", async () => {
    await renderQueueOpsPage();
    await screen.findByRole("button", { name: "dlq-1" });

    const dlqRow = (await screen.findAllByRole("row")).find((row) =>
      within(row).queryByRole("button", { name: "dlq-1" }),
    );
    if (!dlqRow) {
      throw new Error("DLQ job row not found");
    }
    fireEvent.click(within(dlqRow).getByRole("checkbox"));

    const replaySelected = screen.getByRole("button", {
      name: "Replay selected",
    });
    await waitFor(() => expect(replaySelected).toBeEnabled());
    fireEvent.click(replaySelected);

    expect(confirmCalls[0]?.title).toBe("Replay selected dead letters?");
    await triggerLastConfirm();

    expect(apiMock.post).toHaveBeenCalledWith(QUEUE_OPS_ENDPOINTS.dlqReplay, {
      jobIds: ["dlq-1"],
    });
  });
});

describe("QueueOpsContent legacy and permission errors", () => {
  it("shows the api-go legacy hint on 404 without crashing", async () => {
    installApiMock({ queuesError: { response: { status: 404 } } });
    await renderQueueOpsPage();

    expect(
      await screen.findByText(
        "Queue operations require api-go API_GO_QUEUE_OPS_MODE=go. Enable it and refresh this page.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Queue Operations")).toBeInTheDocument();
  });

  it("shows the permission hint on 403", async () => {
    installApiMock({ queuesError: { response: { status: 403 } } });
    await renderQueueOpsPage();

    expect(
      await screen.findByText("Queue operations permission required"),
    ).toBeInTheDocument();
  });
});
