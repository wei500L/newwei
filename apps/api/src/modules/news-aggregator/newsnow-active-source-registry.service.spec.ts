import { NewsnowActiveSourceRegistryService } from "./newsnow-active-source-registry.service";

describe("NewsnowActiveSourceRegistryService", () => {
  let service: NewsnowActiveSourceRegistryService;

  beforeEach(() => {
    service = new NewsnowActiveSourceRegistryService();
  });

  it("returns unique org ids for sockets watching a source", () => {
    service.setActiveSources({
      socketId: "socket-1",
      orgId: "org-1",
      sourceIds: ["weibo", "hackernews"],
    });
    service.setActiveSources({
      socketId: "socket-2",
      orgId: "org-1",
      sourceIds: ["weibo"],
    });
    service.setActiveSources({
      socketId: "socket-3",
      orgId: "org-2",
      sourceIds: ["hackernews", "weibo"],
    });

    expect(service.getOrgIdsForSource("weibo")).toEqual(["org-1", "org-2"]);
  });

  it("excludes removed sockets from source org lookups", () => {
    service.setActiveSources({
      socketId: "socket-1",
      orgId: "org-1",
      sourceIds: ["weibo"],
    });
    service.removeSocket("socket-1");

    expect(service.getOrgIdsForSource("weibo")).toEqual([]);
  });

  it("returns no org ids for blank source ids", () => {
    service.setActiveSources({
      socketId: "socket-1",
      orgId: "org-1",
      sourceIds: ["weibo"],
    });

    expect(service.getOrgIdsForSource(" ")).toEqual([]);
  });
});
