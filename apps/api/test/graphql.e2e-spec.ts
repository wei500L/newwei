import type { INestApplication} from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { GqlAuthGuard } from "../src/common/guards/gql-auth.guard";
import { JwtAuthGuard } from "../src/common/guards/jwt-auth.guard";
import { GraphqlRateLimitGuard } from "../src/graphql/guards/graphql-rate-limit.guard";
import { AuthService } from "../src/modules/auth/auth.service";
import type { AuthenticatedUser } from "../src/modules/auth/auth.service";
import { RateLimiterService } from "../src/modules/cache/rate-limiter.service";
import { PrismaService } from "../src/modules/config/prisma.service";
import { DashboardService } from "../src/modules/dashboard/dashboard.service";
import { ItemsService } from "../src/modules/items/items.service";
import { QueueEventPublisher } from "../src/modules/queue/queue-event.publisher";
import { RbacService } from "../src/modules/rbac/rbac.service";
import { OrgService } from "../src/modules/org/org.service";

const sampleUser: AuthenticatedUser = {
  id: "user-1",
  email: "admin@example.com",
  firstName: "Admin",
  lastName: "User",
  orgId: "org-1",
  roleIds: ["role-1"],
  permissions: ["items.read", "items.write", "users.read", "queue.manage"]
};

const sampleItems = [
  {
    id: "item-1",
    name: "Example Item",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    orgId: "org-1",
    externalId: "item-1",
    mongoRef: "raw-1"
  }
];

describe("GraphQL API", () => {
  let app: INestApplication;
  const prismaMock = {
    itemMeta: {
      findMany: jest.fn().mockImplementation(({ take }: { take?: number }) =>
        typeof take === "number" ? sampleItems.slice(0, take) : sampleItems
      ),
      count: jest.fn().mockResolvedValue(sampleItems.length),
      findFirst: jest.fn().mockImplementation(({ where }: any) =>
        sampleItems.find((item) => item.id === where.id)
      )
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: sampleUser.id,
          email: sampleUser.email,
          firstName: sampleUser.firstName,
          lastName: sampleUser.lastName,
          createdAt: new Date(),
          memberships: [
            {
              orgId: sampleUser.orgId,
              roleId: "role-1",
              role: {
                permissions: [
                  {
                    permission: { id: "perm", name: "users.read", description: null }
                  }
                ]
              }
            }
          ]
        }
      ])
    },
    auditLog: {
      create: jest.fn()
    },
    $transaction: jest.fn(async (cb: any) => cb(prismaMock))
  } as unknown as PrismaService;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.MYSQL_HOST = "localhost";
    process.env.MYSQL_PORT = "3306";
    process.env.MYSQL_USER = "root";
    process.env.MYSQL_PASSWORD = "secret";
    process.env.MYSQL_DB = "app";
    process.env.MONGO_URI = "mongodb://localhost:27017";
    process.env.REDIS_HOST = "localhost";
    process.env.REDIS_PORT = "6379";
    process.env.NEXTAUTH_SECRET = "test-next";
    process.env.API_BASE_URL = "http://localhost:4000";
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_EXPIRES_IN = "15m";
    process.env.JWT_REFRESH_EXPIRES_IN = "7d";
    process.env.GRAPHQL_PLAYGROUND = "true";
    process.env.GRAPHQL_INTROSPECTION = "true";

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(AuthService)
      .useValue({
        getUserProfile: jest.fn().mockResolvedValue(sampleUser)
      })
      .overrideProvider(ItemsService)
      .useValue({
        create: jest.fn().mockResolvedValue({
          ...sampleItems[0],
          status: "active"
        }),
        update: jest.fn().mockResolvedValue(sampleItems[0]),
        get: jest.fn().mockResolvedValue({
          itemMeta: sampleItems[0],
          raw: null,
          processed: null
        })
      })
      .overrideProvider(RateLimiterService)
      .useValue({
        consume: jest.fn().mockResolvedValue(true)
      })
      .overrideProvider(QueueEventPublisher)
      .useValue({
        asyncIterator: () =>
          (async function* () {
            yield {
              queueEvents: {
                event: "COMPLETED",
                jobId: "job-1",
                data: { foo: "bar" },
                timestamp: new Date().toISOString()
              }
            };
          })(),
        publish: jest.fn()
      })
      .overrideProvider(DashboardService)
      .useValue({
        stats: jest.fn().mockResolvedValue({
          queue: { waiting: 0, active: 0, completed: 1, failed: 0, delayed: 0 },
          processedCount: 1,
          itemCount: 1
        })
      })
      .overrideProvider(RbacService)
      .useValue({
        listRoles: jest.fn().mockResolvedValue([]),
        listPermissions: jest.fn().mockResolvedValue([]),
        listMembers: jest.fn().mockResolvedValue([])
      })
      .overrideProvider(OrgService)
      .useValue({
        listOrganizationsForUser: jest.fn().mockResolvedValue([
          {
            id: "org-1",
            name: "Acme Corp",
            slug: "acme",
            description: "Seed org",
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ]),
        createOrg: jest.fn().mockResolvedValue({
          id: "org-2",
          name: "Beta Org",
          slug: "beta",
          description: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        }),
        updateOrg: jest.fn().mockResolvedValue({
          id: "org-1",
          name: "Acme Corp Updated",
          slug: "acme",
          description: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        }),
        setOrgActive: jest.fn().mockResolvedValue({
          id: "org-1",
          name: "Acme Corp",
          slug: "acme",
          description: null,
          isActive: false,
          createdAt: new Date(),
          updatedAt: new Date()
        })
      })
      .overrideProvider(GraphqlRateLimitGuard)
      .useValue({
        canActivate: () => true
      })
      .overrideProvider(JwtAuthGuard)
      .useValue({
        canActivate: () => true
      })
      .overrideProvider(GqlAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const ctx = GqlExecutionContext.create(context);
          const request = ctx.getContext().req;
          const authHeader = request?.headers?.authorization as string | undefined;
          if (!authHeader) {
            throw new UnauthorizedException();
          }
          const permissionsHeader = request?.headers?.["x-test-permissions"] as string | undefined;
          const permissions = permissionsHeader
            ? permissionsHeader.split(",").map((value) => value.trim())
            : sampleUser.permissions;
          request.user = {
            ...sampleUser,
            permissions
          };
          return true;
        }
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects unauthenticated me query", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: "query { me { id email } }" })
      .expect(200);

    expect(response.body.errors?.[0]?.extensions?.code ?? response.body.errors?.[0]?.extensions?.response?.statusCode).toBe(
      "UNAUTHENTICATED"
    );
  });

  it("returns me and items for authorised user", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", "Bearer test")
      .set("x-test-permissions", sampleUser.permissions.join(","))
      .send({ query: "query { me { id email } items(first: 10) { edges { node { id title status } } pageInfo { hasNextPage } } }" })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.me.id).toBe(sampleUser.id);
    expect(response.body.data.items.edges).toHaveLength(1);
  });

  it("returns forbidden when permission missing", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", "Bearer test")
      .set("x-test-permissions", "items.read")
      .send({
        query: "mutation { createItem(input: { title: \"New\", externalId: \"new\", payload: \"{}\" }) { id } }"
      })
      .expect(200);

    const error = response.body.errors?.[0];
    expect(error).toBeDefined();
    expect(error.extensions?.code ?? error.extensions?.response?.statusCode).toBe("FORBIDDEN");
  });

  it("returns organizations for authenticated user", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", "Bearer test")
      .send({ query: "query { myOrganizations { id name slug isActive } }" })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.myOrganizations).toHaveLength(1);
    expect(response.body.data.myOrganizations[0].id).toBe("org-1");
  });

  it("creates orgs when org.write is present", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", "Bearer test")
      .set("x-test-permissions", "org.write")
      .send({
        query:
          "mutation { createOrg(input: { name: \"Beta\", slug: \"beta\" }) { id name slug isActive } }"
      })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.createOrg.id).toBe("org-2");
  });
});
