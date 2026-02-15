import {
  PERMISSIONS_KEY,
  PermissionsMode,
  type PermissionsRequirement
} from "../../../common/decorators/permissions.decorator";
import { Crawl4aiQueueController } from "../crawl4ai-queue.controller";

describe("Crawl4aiQueueController permissions", () => {
  const getPermissionsFor = (
    methodName: "getQueueStats" | "pauseQueue" | "resumeQueue" | "updateQueueConcurrency"
  ): PermissionsRequirement =>
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      Crawl4aiQueueController.prototype[methodName]
    ) as PermissionsRequirement;

  it("requires crawl.read to fetch queue stats", () => {
    expect(getPermissionsFor("getQueueStats")).toEqual({
      permissions: ["crawl.read"],
      mode: PermissionsMode.Any
    });
  });

  it("requires settings.manage for queue mutation endpoints", () => {
    expect(getPermissionsFor("pauseQueue")).toEqual({
      permissions: ["settings.manage"],
      mode: PermissionsMode.Any
    });
    expect(getPermissionsFor("resumeQueue")).toEqual({
      permissions: ["settings.manage"],
      mode: PermissionsMode.Any
    });
    expect(getPermissionsFor("updateQueueConcurrency")).toEqual({
      permissions: ["settings.manage"],
      mode: PermissionsMode.Any
    });
  });
});
