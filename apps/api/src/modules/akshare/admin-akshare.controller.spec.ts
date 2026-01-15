import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import { of, throwError } from "rxjs";

import { AdminAkshareController } from "./admin-akshare.controller";

describe("AdminAkshareController", () => {
  const createController = (options: { adminToken?: string } = {}) => {
    const httpMock = {
      get: jest.fn(),
      post: jest.fn()
    };

    const envMock = {
      akshareConfig: {
        baseUrl: "http://localhost:8000/"
      },
      akshareAdminToken: options.adminToken ?? null
    };

    const prismaMock = {
      auditLog: {
        create: jest.fn().mockResolvedValue({})
      }
    };

    const controller = new AdminAkshareController(
      httpMock as any,
      envMock as any,
      prismaMock as any
    );

    return { controller, httpMock, envMock, prismaMock };
  };

  const createMockUser = () => ({
    id: "user-1",
    email: "test@example.com",
    orgId: "org-1",
    firstName: "Test",
    lastName: "User",
    permissions: ["settings.manage"],
    roleIds: ["role-1"]
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("version", () => {
    it("returns akshareVersion and pythonVersion from gateway response", async () => {
      const { controller, httpMock } = createController();
      const versionResponse = {
        akshareVersion: "1.14.0",
        pythonVersion: "3.11.5"
      };

      httpMock.get.mockReturnValue(of({ data: versionResponse }));

      const result = await controller.version();

      expect(result).toEqual(versionResponse);
      expect(httpMock.get).toHaveBeenCalledWith(
        "http://localhost:8000/version",
        { timeout: 10_000 }
      );
    });

    it("returns fallback values when gateway returns 404", async () => {
      const { controller, httpMock } = createController();
      const axiosError = {
        response: { status: 404 }
      };

      httpMock.get.mockReturnValue(throwError(() => axiosError));

      const result = await controller.version();

      expect(result).toEqual({
        akshareVersion: "unknown",
        pythonVersion: "unknown"
      });
    });

    it("throws HttpException when gateway returns other errors", async () => {
      const { controller, httpMock } = createController();
      const axiosError = {
        response: {
          status: 500,
          data: { message: "Internal server error" }
        }
      };

      httpMock.get.mockReturnValue(throwError(() => axiosError));

      await expect(controller.version()).rejects.toThrow(HttpException);
      await expect(controller.version()).rejects.toMatchObject({
        status: 500
      });
    });

    it("re-throws original error when no axios response status", async () => {
      const { controller, httpMock } = createController();
      const networkError = new Error("Network error");

      httpMock.get.mockReturnValue(throwError(() => networkError));

      await expect(controller.version()).rejects.toThrow("Network error");
    });
  });

  describe("status", () => {
    it("returns disabled status when adminToken is not configured", async () => {
      const { controller } = createController({ adminToken: undefined });

      const result = await controller.status();

      expect(result).toEqual({
        inProgress: false,
        stage: "idle",
        requestId: null,
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
        restartScheduledAt: null,
        beforeVersion: null,
        afterVersion: null,
        error: null,
        pipStdout: null,
        pipStderr: null,
        upgradeEnabled: false,
        disabledReason: "AKSHARE_ADMIN_TOKEN is not configured; akshare gateway upgrade status is disabled"
      });
    });

    it("returns upgrade status from gateway when token is configured", async () => {
      const { controller, httpMock } = createController({ adminToken: "secret-token" });
      const statusResponse = {
        inProgress: true,
        stage: "running",
        requestId: "req-123",
        requestedAt: "2024-01-01T00:00:00Z",
        startedAt: "2024-01-01T00:00:01Z",
        finishedAt: null,
        restartScheduledAt: null,
        beforeVersion: "1.13.0",
        afterVersion: null,
        error: null,
        pipStdout: "Installing...",
        pipStderr: null
      };

      httpMock.get.mockReturnValue(of({ data: statusResponse }));

      const result = await controller.status();

      expect(result).toEqual(statusResponse);
      expect(httpMock.get).toHaveBeenCalledWith(
        "http://localhost:8000/admin/status",
        {
          headers: { "x-akshare-admin-token": "secret-token" },
          timeout: 10_000
        }
      );
    });

    it("returns disabled status with rebuild message when gateway returns 404", async () => {
      const { controller, httpMock } = createController({ adminToken: "secret-token" });
      const axiosError = {
        response: { status: 404 }
      };

      httpMock.get.mockReturnValue(throwError(() => axiosError));

      const result = await controller.status();

      expect(result).toEqual({
        inProgress: false,
        stage: "idle",
        requestId: null,
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
        restartScheduledAt: null,
        beforeVersion: null,
        afterVersion: null,
        error: null,
        pipStdout: null,
        pipStderr: null,
        upgradeEnabled: false,
        disabledReason: "Akshare gateway does not expose admin endpoints; rebuild the gateway image to enable upgrades"
      });
    });

    it("throws HttpException when gateway returns other errors", async () => {
      const { controller, httpMock } = createController({ adminToken: "secret-token" });
      const axiosError = {
        response: {
          status: 503,
          data: "Service unavailable"
        }
      };

      httpMock.get.mockReturnValue(throwError(() => axiosError));

      await expect(controller.status()).rejects.toThrow(HttpException);
      await expect(controller.status()).rejects.toMatchObject({
        status: 503
      });
    });

    it("verifies x-akshare-admin-token header is sent", async () => {
      const { controller, httpMock } = createController({ adminToken: "my-secret-token" });
      const statusResponse = {
        inProgress: false,
        stage: "idle",
        requestId: null,
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
        restartScheduledAt: null,
        beforeVersion: null,
        afterVersion: null,
        error: null,
        pipStdout: null,
        pipStderr: null
      };

      httpMock.get.mockReturnValue(of({ data: statusResponse }));

      await controller.status();

      expect(httpMock.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { "x-akshare-admin-token": "my-secret-token" }
        })
      );
    });
  });

  describe("upgrade", () => {
    it("throws ServiceUnavailableException when adminToken is not configured", async () => {
      const { controller } = createController({ adminToken: undefined });
      const user = createMockUser();

      await expect(controller.upgrade(user as any)).rejects.toThrow(ServiceUnavailableException);
      await expect(controller.upgrade(user as any)).rejects.toThrow(
        "AKSHARE_ADMIN_TOKEN is not configured; akshare gateway upgrade is disabled"
      );
    });

    it("returns upgrade accepted response with requestId and beforeVersion", async () => {
      const { controller, httpMock } = createController({ adminToken: "secret-token" });
      const user = createMockUser();

      const versionResponse = {
        akshareVersion: "1.13.0",
        pythonVersion: "3.11.5"
      };
      const upgradeResponse = {
        status: "accepted",
        requestId: "upgrade-req-456",
        beforeVersion: "1.13.0"
      };

      httpMock.get.mockReturnValue(of({ data: versionResponse }));
      httpMock.post.mockReturnValue(of({ data: upgradeResponse }));

      const result = await controller.upgrade(user as any);

      expect(result).toEqual(upgradeResponse);
    });

    it("fetches current version before upgrade request", async () => {
      const { controller, httpMock } = createController({ adminToken: "secret-token" });
      const user = createMockUser();

      const versionResponse = {
        akshareVersion: "1.13.0",
        pythonVersion: "3.11.5"
      };
      const upgradeResponse = {
        status: "accepted",
        requestId: "upgrade-req-789",
        beforeVersion: "1.13.0"
      };

      httpMock.get.mockReturnValue(of({ data: versionResponse }));
      httpMock.post.mockReturnValue(of({ data: upgradeResponse }));

      await controller.upgrade(user as any);

      expect(httpMock.get).toHaveBeenCalledWith(
        "http://localhost:8000/version",
        { timeout: 10_000 }
      );
      // Verify both get (version) and post (upgrade) were called
      expect(httpMock.get).toHaveBeenCalledTimes(1);
      expect(httpMock.post).toHaveBeenCalledTimes(1);
    });

    it("handles version fetch failure gracefully and uses unknown", async () => {
      const { controller, httpMock } = createController({ adminToken: "secret-token" });
      const user = createMockUser();

      const upgradeResponse = {
        status: "accepted",
        requestId: "upgrade-req-abc",
        beforeVersion: "unknown"
      };

      httpMock.get.mockReturnValue(throwError(() => new Error("Version fetch failed")));
      httpMock.post.mockReturnValue(of({ data: upgradeResponse }));

      const result = await controller.upgrade(user as any);

      expect(result).toEqual(upgradeResponse);
      expect(httpMock.post).toHaveBeenCalled();
    });

    it("verifies x-akshare-admin-token header is sent on upgrade request", async () => {
      const { controller, httpMock } = createController({ adminToken: "upgrade-secret" });
      const user = createMockUser();

      const versionResponse = {
        akshareVersion: "1.13.0",
        pythonVersion: "3.11.5"
      };
      const upgradeResponse = {
        status: "accepted",
        requestId: "upgrade-req-def",
        beforeVersion: "1.13.0"
      };

      httpMock.get.mockReturnValue(of({ data: versionResponse }));
      httpMock.post.mockReturnValue(of({ data: upgradeResponse }));

      await controller.upgrade(user as any);

      expect(httpMock.post).toHaveBeenCalledWith(
        "http://localhost:8000/admin/upgrade",
        {},
        expect.objectContaining({
          headers: { "x-akshare-admin-token": "upgrade-secret" },
          timeout: 15_000
        })
      );
    });

    it("throws HttpException when upgrade request fails", async () => {
      const { controller, httpMock } = createController({ adminToken: "secret-token" });
      const user = createMockUser();

      const versionResponse = {
        akshareVersion: "1.13.0",
        pythonVersion: "3.11.5"
      };
      const axiosError = {
        response: {
          status: 409,
          data: { message: "Upgrade already in progress" }
        }
      };

      httpMock.get.mockReturnValue(of({ data: versionResponse }));
      httpMock.post.mockReturnValue(throwError(() => axiosError));

      await expect(controller.upgrade(user as any)).rejects.toThrow(HttpException);
      await expect(controller.upgrade(user as any)).rejects.toMatchObject({
        status: 409
      });
    });
  });

  describe("error handling", () => {
    it("throws HttpException with gateway response status and data", async () => {
      const { controller, httpMock } = createController();
      const axiosError = {
        response: {
          status: 502,
          data: { error: "Bad gateway", details: "Connection refused" }
        }
      };

      httpMock.get.mockReturnValue(throwError(() => axiosError));

      try {
        await controller.version();
        fail("Expected HttpException to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(502);
        expect((error as HttpException).getResponse()).toEqual({
          error: "Bad gateway",
          details: "Connection refused"
        });
      }
    });

    it("throws HttpException with default message when no data", async () => {
      const { controller, httpMock } = createController();
      const axiosError = {
        response: {
          status: 500,
          data: null
        }
      };

      httpMock.get.mockReturnValue(throwError(() => axiosError));

      try {
        await controller.version();
        fail("Expected HttpException to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(500);
        expect((error as HttpException).getResponse()).toBe("Akshare gateway request failed");
      }
    });

    it("re-throws original error when no axios response status", async () => {
      const { controller, httpMock } = createController();
      const originalError = new Error("ECONNREFUSED");

      httpMock.get.mockReturnValue(throwError(() => originalError));

      await expect(controller.version()).rejects.toThrow(originalError);
    });

    it("handles undefined error gracefully", async () => {
      const { controller, httpMock } = createController();

      httpMock.get.mockReturnValue(throwError(() => undefined));

      await expect(controller.version()).rejects.toBeUndefined();
    });
  });

  describe("gateway URL handling", () => {
    it("strips trailing slash from baseUrl", async () => {
      const httpMock = {
        get: jest.fn(),
        post: jest.fn()
      };

      const envMock = {
        akshareConfig: {
          baseUrl: "http://localhost:8000/"
        },
        akshareAdminToken: null
      };

      const prismaMock = {
        auditLog: {
          create: jest.fn().mockResolvedValue({})
        }
      };

      const controller = new AdminAkshareController(
        httpMock as any,
        envMock as any,
        prismaMock as any
      );

      const versionResponse = {
        akshareVersion: "1.14.0",
        pythonVersion: "3.11.5"
      };

      httpMock.get.mockReturnValue(of({ data: versionResponse }));

      await controller.version();

      expect(httpMock.get).toHaveBeenCalledWith(
        "http://localhost:8000/version",
        expect.any(Object)
      );
    });
  });
});
