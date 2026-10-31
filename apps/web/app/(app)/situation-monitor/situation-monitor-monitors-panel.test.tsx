import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import { App as AntdApp } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n, renderWithProviders } from "@/test/render";

import { SituationMonitorMonitorsPanel } from "./situation-monitor-monitors-panel";
import type {
  SituationMonitorPreviewResponse,
  StoredSituationMonitor,
} from "./types/situation-monitor-monitors";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { accessToken: "test-token", user: { id: "user-1" } },
  }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => apiMock,
}));

interface RecordedRequest {
  url: string;
  body: unknown;
}

const recorded = {
  posts: [] as RecordedRequest[],
  patches: [] as RecordedRequest[],
};

const EXISTING_MONITOR: StoredSituationMonitor = {
  id: "monitor-1",
  kind: "manual",
  name: "Existing monitor",
  enabled: true,
  color: "#123456",
  rawKeywords: ["existing"],
  approvedTopics: ["topic-a"],
  approvedEntities: [],
  approvedSources: [],
  approvedGeos: [],
  approvedLexicalTerms: ["existing"],
  rejectedSuggestions: { topics: [], entities: [], lexicalTerms: [] },
  location: {
    name: "Old Town",
    lat: 10.5,
    lng: 20.25,
    countryCodeAlpha2: "DE",
    bounds: { minLat: 10, maxLat: 11, minLng: 20, maxLng: 21 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

function buildPreview(
  name: string,
  rawKeywords: string[],
  locationResolution: SituationMonitorPreviewResponse["locationResolution"],
): SituationMonitorPreviewResponse {
  return {
    name,
    rawKeywords,
    locationResolution,
    suggestedTopics: [],
    suggestedEntities: [],
    suggestedLexicalTerms: [],
    modelInfo: {},
  };
}

function mockMonitors(monitors: StoredSituationMonitor[]): void {
  apiMock.get.mockResolvedValue({ data: monitors });
}

function mockPreviewPost(preview: SituationMonitorPreviewResponse): void {
  apiMock.post.mockImplementation(async (url: string, body: unknown) => {
    recorded.posts.push({ url, body });
    if (url === "situation-monitor/monitors/preview") {
      return { data: preview };
    }
    if (url === "situation-monitor/monitors") {
      return { data: { id: "monitor-created" } };
    }
    throw new Error(`Unexpected POST: ${url}`);
  });
}

function mockPreviewAndPatch(preview: SituationMonitorPreviewResponse): void {
  apiMock.post.mockImplementation(async (url: string, body: unknown) => {
    recorded.posts.push({ url, body });
    if (url === "situation-monitor/monitors/preview") {
      return { data: preview };
    }
    throw new Error(`Unexpected POST: ${url}`);
  });
  apiMock.patch.mockImplementation(async (url: string, body: unknown) => {
    recorded.patches.push({ url, body });
    return { data: {} };
  });
}

function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });

  renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <AntdApp>
        <SituationMonitorMonitorsPanel matches={[]} />
      </AntdApp>
    </QueryClientProvider>,
  );
}

async function openCreateModal(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /Add monitor/ }));
  await screen.findByLabelText("Name");
}

async function openEditModal(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
  await screen.findByLabelText("Name");
}

function fillField(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function addKeyword(value: string): void {
  // Open the Select, type the keyword, then confirm it as a tag with Enter.
  const input = screen.getByLabelText("Keywords");
  fireEvent.mouseDown(input);
  fireEvent.change(input, { target: { value: `${value},` } });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 13, which: 13 });
}

function postsTo(url: string): RecordedRequest[] {
  return recorded.posts.filter((request) => request.url === url);
}

function patchesTo(url: string): RecordedRequest[] {
  return recorded.patches.filter((request) => request.url === url);
}

function bodyOf(request: RecordedRequest): Record<string, unknown> {
  return request.body as Record<string, unknown>;
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.patch.mockReset();
  apiMock.delete.mockReset();
  recorded.posts.length = 0;
  recorded.patches.length = 0;
  apiMock.get.mockResolvedValue({ data: [] });
});

describe("SituationMonitorMonitorsPanel 地点解析与保存契约", () => {
  it("新建：预览解析地点后创建，location 使用预览结果且不提交 bounds", async () => {
    mockMonitors([]);
    const preview = buildPreview("Taipei", ["taiwan"], {
      name: "Taipei",
      lat: 25.0478,
      lng: 121.5319,
      countryCodeAlpha2: "TW",
      bounds: { minLat: 24.9, maxLat: 25.2, minLng: 121.4, maxLng: 121.7 },
    });
    mockPreviewPost(preview);

    renderPanel();
    await openCreateModal();

    fillField("Name", "Taiwan watch");
    addKeyword("taiwan");
    fillField("Location (optional)", "Taipei 101");

    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));

    await waitFor(() => {
      expect(postsTo("situation-monitor/monitors/preview")).toHaveLength(1);
    });
    const previewPayload = bodyOf(
      postsTo("situation-monitor/monitors/preview")[0]!,
    );
    expect(previewPayload).toEqual(
      expect.objectContaining({
        name: "Taiwan watch",
        rawKeywords: ["taiwan"],
        location: { name: "Taipei 101" },
      }),
    );

    expect(await screen.findByText("Location resolved.")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Location (optional)")).toHaveValue(
        "Taipei",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postsTo("situation-monitor/monitors")).toHaveLength(1);
    });
    const createPayload = bodyOf(postsTo("situation-monitor/monitors")[0]!);
    const resolved = preview.locationResolution!;
    expect(createPayload.name).toBe("Taiwan watch");
    expect(createPayload.location).toEqual({
      name: resolved.name,
      lat: resolved.lat,
      lng: resolved.lng,
      countryCodeAlpha2: resolved.countryCodeAlpha2,
    });
    expect(createPayload.location).not.toHaveProperty("bounds");

    expect(await screen.findByText("Monitor created.")).toBeInTheDocument();
  });

  it("编辑：修改地点并重新预览后保存，PATCH location 与新预览一致", async () => {
    mockMonitors([EXISTING_MONITOR]);
    const preview = buildPreview("Existing monitor", ["existing"], {
      name: "New Town",
      lat: 48.8566,
      lng: 2.3522,
      countryCodeAlpha2: "FR",
      bounds: { minLat: 48.8, maxLat: 48.9, minLng: 2.2, maxLng: 2.5 },
    });
    mockPreviewAndPatch(preview);

    renderPanel();
    await openEditModal();

    expect(screen.getByLabelText("Name")).toHaveValue("Existing monitor");
    fillField("Location (optional)", "New Town");

    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));

    await waitFor(() => {
      expect(postsTo("situation-monitor/monitors/preview")).toHaveLength(1);
    });
    expect(await screen.findByText("Location resolved.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(patchesTo("situation-monitor/monitors/monitor-1")).toHaveLength(1);
    });
    const patchPayload = bodyOf(
      patchesTo("situation-monitor/monitors/monitor-1")[0]!,
    );
    const resolved = preview.locationResolution!;
    expect(patchPayload.location).toEqual({
      name: resolved.name,
      lat: resolved.lat,
      lng: resolved.lng,
      countryCodeAlpha2: resolved.countryCodeAlpha2,
    });
    expect(patchPayload.location).not.toHaveProperty("bounds");

    expect(await screen.findByText("Monitor updated.")).toBeInTheDocument();
  });

  it("无命中：预览返回 null 时创建仅提交地点名，不伪造坐标或国家", async () => {
    mockMonitors([]);
    const preview = buildPreview("Atlantis watch", ["lost city"], null);
    mockPreviewPost(preview);

    renderPanel();
    await openCreateModal();

    fillField("Name", "Atlantis watch");
    addKeyword("lost city");
    fillField("Location (optional)", "Atlantis");

    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));

    await waitFor(() => {
      expect(postsTo("situation-monitor/monitors/preview")).toHaveLength(1);
    });
    expect(screen.queryByText("Location resolved.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postsTo("situation-monitor/monitors")).toHaveLength(1);
    });
    const createPayload = bodyOf(postsTo("situation-monitor/monitors")[0]!);
    expect(createPayload.location).toEqual({ name: "Atlantis" });
    expect(createPayload.location).not.toHaveProperty("lat");
    expect(createPayload.location).not.toHaveProperty("lng");
    expect(createPayload.location).not.toHaveProperty("countryCodeAlpha2");
  });
});
