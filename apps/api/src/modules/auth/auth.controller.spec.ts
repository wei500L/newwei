import { ForbiddenException } from "@nestjs/common";

import { ALLOW_AUTHENTICATED_KEY } from "../../common/decorators/allow-authenticated.decorator";
import { PERMISSIONS_KEY } from "../../common/decorators/permissions.decorator";

import type { AuthenticatedUser } from "./auth.service";
import { AuthController } from "./auth.controller";

describe("AuthController", () => {
  const authService = {} as any;
  const storageService = {} as any;
  const passwordResetService = {} as any;
  const inviteService = {} as any;
  const registrationApplications = {
    listOrgJoinApplications: jest.fn(),
    listPlatformApplications: jest.fn(),
  } as any;
  const mfaService = {} as any;
  const machineTokenService = {} as any;
  const oidcAuthService = {} as any;
  const platformAccess = {
    isPlatformAdmin: jest.fn(),
  } as any;
  const env = {} as any;
  const userDataExport = {
    exportUserData: jest.fn(),
  } as any;

  let controller: AuthController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new AuthController(
      authService,
      storageService,
      passwordResetService,
      inviteService,
      registrationApplications,
      mfaService,
      machineTokenService,
      oidcAuthService,
      platformAccess,
      env,
      userDataExport,
    );
  });

  it("uses authenticated access instead of users.write metadata for registration applications", () => {
    expect(
      Reflect.getMetadata(
        ALLOW_AUTHENTICATED_KEY,
        AuthController.prototype.listRegistrationApplications,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        AuthController.prototype.listRegistrationApplications,
      ),
    ).toBeUndefined();
  });

  it("allows authenticated users to export their own data", () => {
    expect(
      Reflect.getMetadata(
        ALLOW_AUTHENTICATED_KEY,
        AuthController.prototype.exportUserData,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        AuthController.prototype.exportUserData,
      ),
    ).toBeUndefined();
  });

  it("returns platform applications for platform admins without org write permission", async () => {
    const user: AuthenticatedUser = {
      id: "user-1",
      email: "platform@example.com",
      orgId: "org-1",
      roleIds: [],
      permissions: [],
      firstName: "Platform",
      lastName: "Admin",
    };
    platformAccess.isPlatformAdmin.mockResolvedValue(true);
    registrationApplications.listPlatformApplications.mockResolvedValue([
      { id: "application-1" },
    ]);

    const result = await controller.listRegistrationApplications(user);

    expect(
      registrationApplications.listOrgJoinApplications,
    ).not.toHaveBeenCalled();
    expect(
      registrationApplications.listPlatformApplications,
    ).toHaveBeenCalledWith("user-1");
    expect(result).toEqual({
      orgApplications: [],
      platformApplications: [{ id: "application-1" }],
    });
  });

  it("rejects users who lack both org write access and platform admin access", async () => {
    const user: AuthenticatedUser = {
      id: "user-2",
      email: "member@example.com",
      orgId: "org-1",
      roleIds: [],
      permissions: [],
      firstName: "Member",
      lastName: "User",
    };
    platformAccess.isPlatformAdmin.mockResolvedValue(false);

    await expect(controller.listRegistrationApplications(user)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
