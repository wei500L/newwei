import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

const signIn = vi.fn();
const push = vi.fn();
const post = vi.fn();

vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => signIn(...args),
  useSession: () => ({ data: null, status: "unauthenticated" }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => ({
    post: (...args: unknown[]) => post(...args),
  }),
  syncApiSessionCache: vi.fn(async () => null),
}));

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: vi.fn(),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    signIn.mockReset();
    push.mockReset();
    post.mockReset();
  });

  it("renders password and verification-code tabs", async () => {
    const { default: LoginPage } = await import("./page");
    renderWithProviders(<LoginPage />);

    expect(
      screen.getByRole("heading", { name: "Welcome back" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Password" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Verification code" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("does not call the login API when required fields are empty", async () => {
    const user = userEvent.setup();
    const { default: LoginPage } = await import("./page");
    renderWithProviders(<LoginPage />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(post).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("signs in through the handoff provider after a successful password login", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({
      data: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 900,
        user: { id: "user-1", email: "admin@example.com" },
        organizations: [{ id: "org-1", slug: "acme" }],
      },
    });
    signIn.mockResolvedValue({});

    const { default: LoginPage } = await import("./page");
    renderWithProviders(<LoginPage />);

    await user.type(
      screen.getByPlaceholderText("Enter your email"),
      "admin@example.com",
    );
    await user.type(
      screen.getByPlaceholderText("Enter your password"),
      "password1",
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("auth/login", {
        email: "admin@example.com",
        password: "password1",
      });
    });
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith(
        "handoff",
        expect.objectContaining({
          accessToken: "access-token",
          redirect: false,
        }),
      );
    });
  });
});
