import { UsersResolver } from "./user.resolver";
import { PrismaService } from "../../modules/config/prisma.service";
import { AuthService, AuthenticatedUser } from "../../modules/auth/auth.service";

const sampleUser: AuthenticatedUser = {
  id: "user-1",
  email: "admin@example.com",
  firstName: "Admin",
  lastName: "User",
  orgId: "org-1",
  roleIds: ["role-1"],
  permissions: ["users.read"]
};

describe("UsersResolver", () => {
  const prisma = {
    user: {
      findMany: jest.fn()
    }
  } as unknown as PrismaService;

  const authService = {
    getUserProfile: jest.fn().mockResolvedValue(sampleUser)
  } as unknown as AuthService;

  const resolver = new UsersResolver(prisma, authService as AuthService);

  it("maps me query to authenticated user", async () => {
    const result = await resolver.me({ user: sampleUser } as any);
    expect(result).toMatchObject({ id: sampleUser.id, email: sampleUser.email, permissions: sampleUser.permissions });
  });
});
