import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

const get = vi.fn();
const post = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { accessToken: "test-token" },
    status: "authenticated",
  }),
}));

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => ({ get, post }),
}));

describe("SecuritySettingsPage", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({
      data: {
        enabled: true,
        recoveryCodesRemaining: 3,
      },
    });
    post.mockResolvedValue({ data: {} });
  });

  it("opens a modal instead of window.prompt and calls the rotate API on confirm", async () => {
    const user = userEvent.setup();
    const { default: SecuritySettingsPage } = await import("./page");

    renderWithProviders(
      <AntApp>
        <SecuritySettingsPage />
      </AntApp>,
    );

    const rotateButton = await screen.findByRole("button", {
      name: "Rotate recovery codes",
    });
    await user.click(rotateButton);

    const input = await screen.findByPlaceholderText("Authenticator code");
    await user.type(input, "123456");

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("auth/mfa/recovery/rotate", {
        code: "123456",
      });
    });
  });
});
