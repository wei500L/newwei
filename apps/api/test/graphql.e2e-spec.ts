import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { sign } from "jsonwebtoken";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { GraphqlRateLimitGuard } from "../src/graphql/guards/graphql-rate-limit.guard";
import { AKSHARE_QUEUE, AKSHARE_QUEUE_EVENTS } from "../src/modules/akshare/akshare.constants";
import { AkshareQueueProcessor } from "../src/modules/akshare/akshare.processor";
import { ALERTS_QUEUE, ALERTS_QUEUE_EVENTS } from "../src/modules/alerts/alerts.constants";
import { AlertsProcessor } from "../src/modules/alerts/alerts.processor";
import { ANALYSIS_QUEUE, ANALYSIS_QUEUE_EVENTS } from "../src/modules/analysis/analysis.constants";
import { AnalysisProcessor } from "../src/modules/analysis/analysis.processor";
import { ASSISTANT_QUEUE, ASSISTANT_QUEUE_EVENTS } from "../src/modules/assistant/assistant.constants";
import { AssistantProcessor } from "../src/modules/assistant/assistant.processor";
import { AuthService } from "../src/modules/auth/auth.service";
import type { AuthenticatedUser } from "../src/modules/auth/auth.service";
import { RateLimiterService } from "../src/modules/cache/rate-limiter.service";
import { MONGO_CONNECTION } from "../src/modules/config/mongo.provider";
import { PrismaService } from "../src/modules/config/prisma.service";
import { CRAWL_QUEUE, CRAWL_QUEUE_EVENTS } from "../src/modules/crawl/crawl.constants";
import { CrawlQueueProcessor } from "../src/modules/crawl/crawl.processor";
import { DashboardService } from "../src/modules/dashboard/dashboard.service";
import { ItemsService } from "../src/modules/items/items.service";
import { NotificationsGateway } from "../src/modules/notifications/notifications.gateway";
import { OrgService } from "../src/modules/org/org.service";
import { QueueEventPublisher } from "../src/modules/queue/queue-event.publisher";
import { PIPELINE_DLQ_QUEUE, PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS } from "../src/modules/queue/queue.constants";
import { QueueGateway } from "../src/modules/queue/queue.gateway";
import { QueueProcessor } from "../src/modules/queue/queue.processor";
import { RbacService } from "../src/modules/rbac/rbac.service";

const sampleUser: AuthenticatedUser = {
  id: "user-1",
  email: "admin@example.com",
  firstName: "Admin",
  lastName: "User",
  orgId: "org-1",
  roleIds: ["role-1"],
  permissions: ["items.read", "items.write", "users.read", "queue.manage"]
};

const readOnlyUser: AuthenticatedUser = {
  ...sampleUser,
  id: "user-2",
  permissions: ["items.read"]
};

const orgWriterUser: AuthenticatedUser = {
  ...sampleUser,
  id: "user-3",
  permissions: ["org.write"]
};

const usersById: Record<string, AuthenticatedUser> = {
  [sampleUser.id]: sampleUser,
  [readOnlyUser.id]: readOnlyUser,
  [orgWriterUser.id]: orgWriterUser
};

function createJwt(user: AuthenticatedUser) {
  const secret = process.env.JWT_SECRET ?? "test-secret-123456";
  return sign({ sub: user.id, orgId: user.orgId }, secret, {
    issuer: "modular-monolith",
    audience: "modular-monolith-clients",
    expiresIn: "1h"
  });
}

const tokens = {
  fullAccess: createJwt(sampleUser),
  readOnly: createJwt(readOnlyUser),
  orgWriter: createJwt(orgWriterUser)
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
    process.env.JWT_SECRET = "test-secret-123456";
    process.env.MYSQL_HOST = "localhost";
    process.env.MYSQL_PORT = "3306";
    process.env.MYSQL_USER = "root";
    process.env.MYSQL_PASSWORD = "secret";
    process.env.MYSQL_DB = "app";
    process.env.MONGO_URI = "mongodb://localhost:27017";
    process.env.REDIS_HOST = "127.0.0.1";
    process.env.REDIS_PORT = "6379";
    process.env.NEXTAUTH_SECRET = "test-nextauth-123456";
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
        getUserProfile: jest.fn().mockImplementation(async (userId: string) => usersById[userId] ?? sampleUser)
      })
      .overrideProvider(MONGO_CONNECTION)
      .useValue({})
      .overrideProvider(PIPELINE_QUEUE)
      .useValue({ add: jest.fn(), getJobCounts: jest.fn(), getJob: jest.fn(), close: jest.fn() })
      .overrideProvider(PIPELINE_DLQ_QUEUE)
      .useValue({ add: jest.fn(), close: jest.fn() })
      .overrideProvider(PIPELINE_QUEUE_EVENTS)
      .useValue({ on: jest.fn(), off: jest.fn(), close: jest.fn() })
      .overrideProvider(ANALYSIS_QUEUE)
      .useValue({ add: jest.fn(), close: jest.fn() })
      .overrideProvider(ANALYSIS_QUEUE_EVENTS)
      .useValue({ on: jest.fn(), off: jest.fn(), close: jest.fn() })
      .overrideProvider(ASSISTANT_QUEUE)
      .useValue({ add: jest.fn(), close: jest.fn() })
      .overrideProvider(ASSISTANT_QUEUE_EVENTS)
      .useValue({ on: jest.fn(), off: jest.fn(), close: jest.fn() })
      .overrideProvider(ALERTS_QUEUE)
      .useValue({ add: jest.fn(), close: jest.fn() })
      .overrideProvider(ALERTS_QUEUE_EVENTS)
      .useValue({ on: jest.fn(), off: jest.fn(), close: jest.fn() })
      .overrideProvider(CRAWL_QUEUE)
      .useValue({ add: jest.fn(), close: jest.fn() })
      .overrideProvider(CRAWL_QUEUE_EVENTS)
      .useValue({ on: jest.fn(), off: jest.fn(), close: jest.fn() })
      .overrideProvider(AKSHARE_QUEUE)
      .useValue({
        add: jest.fn(),
        close: jest.fn(),
        getRepeatableJobs: jest.fn().mockResolvedValue([]),
        removeRepeatableByKey: jest.fn(),
        drain: jest.fn()
      })
      .overrideProvider(AKSHARE_QUEUE_EVENTS)
      .useValue({ on: jest.fn(), off: jest.fn(), close: jest.fn() })
      .overrideProvider(ItemsService)
      .useValue({
        listWithCursor: jest.fn().mockResolvedValue({
          items: sampleItems,
          hasNextPage: false,
          totalCount: sampleItems.length
        }),
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
        publish: jest.fn(),
        registerListener: jest.fn(() => () => undefined)
      })
      .overrideProvider(QueueGateway)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(NotificationsGateway)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(QueueProcessor)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(AlertsProcessor)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(AnalysisProcessor)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(AssistantProcessor)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(CrawlQueueProcessor)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(AkshareQueueProcessor)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
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
      .expect(401);

    expect(response.body.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("returns me and items for authorised user", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", `Bearer ${tokens.fullAccess}`)
      .send({ query: "query { me { id email } items(first: 10) { edges { node { id title status } } pageInfo { hasNextPage } } }" })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.me.id).toBe(sampleUser.id);
    expect(response.body.data.items.edges).toHaveLength(1);
  });

  it("returns forbidden when permission missing", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", `Bearer ${tokens.readOnly}`)
      .send({
        query: "mutation { createItem(input: { title: \"New\", externalId: \"new\", payload: \"{}\" }) { id } }"
      })
      .expect(403);

    const error = response.body.errors?.[0];
    expect(error).toBeDefined();
    expect(error.extensions?.code ?? error.extensions?.response?.statusCode).toBe("FORBIDDEN");
  });

  it("returns organizations for authenticated user", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", `Bearer ${tokens.fullAccess}`)
      .send({ query: "query { myOrganizations { id name slug isActive } }" })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.myOrganizations).toHaveLength(1);
    expect(response.body.data.myOrganizations[0].id).toBe("org-1");
  });

  it("rejects overly complex items query", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", `Bearer ${tokens.fullAccess}`)
      .send({
        query:
          "query { items(first: 500) { edges { cursor node { id title status meta { id name status } raw { id payload } processed { id result } } } pageInfo { hasNextPage endCursor } totalCount } }"
      })
      .expect(500);

    const error = response.body.errors?.[0];
    expect(error).toBeDefined();
    expect(error.extensions?.code).toBe("QUERY_TOO_COMPLEX");
  });

  it("creates orgs when org.write is present", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", `Bearer ${tokens.orgWriter}`)
      .send({
        query:
          "mutation { createOrg(input: { name: \"Beta\", slug: \"beta\" }) { id name slug isActive } }"
      })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.createOrg.id).toBe("org-2");
  });
});
