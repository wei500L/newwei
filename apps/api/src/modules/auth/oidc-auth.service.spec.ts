import { OidcAuthService } from "./oidc-auth.service";

describe("OidcAuthService", () => {
  it("builds the OIDC redirect URI from the API base URL", () => {
    const service = new OidcAuthService(
      {} as any,
      {} as any,
      {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === "API_BASE_URL") {
            return "https://api.example.com";
          }
          return undefined;
        }),
      } as any,
      {} as any,
      {} as any,
    );

    expect((service as any).getCallbackUrl()).toBe(
      "https://api.example.com/api/auth/oidc/callback",
    );
  });
});
