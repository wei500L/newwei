import { describe, expect, it, vi } from "vitest";

import { navigateDrawerItem } from "@/app/(app)/components/top-nav-drawer-navigation";

describe("drawer navigation", () => {
  it("pushes the next route before closing the drawer", () => {
    const steps: string[] = [];

    navigateDrawerItem("/dashboard", {
      push: (path) => {
        steps.push(`push:${path}`);
      },
      closeDrawer: () => {
        steps.push("close");
      },
    });

    expect(steps).toEqual(["push:/dashboard", "close"]);
  });

  it("still closes the drawer when no route is available", () => {
    const push = vi.fn();
    const closeDrawer = vi.fn();

    navigateDrawerItem(undefined, { push, closeDrawer });

    expect(push).not.toHaveBeenCalled();
    expect(closeDrawer).toHaveBeenCalledTimes(1);
  });
});
