import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { sign } from "jsonwebtoken";
import request from "supertest";

import { AppModule } from "../src/app.module";
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
import { NotificationsGateway } from "../src/modules/notifications/notifications.gateway";
import { ExceptionEventsService } from "../src/modules/observability/exception-events.service";
import { PIPELINE_DLQ_QUEUE, PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS } from "../src/modules/queue/queue.constants";
import { QueueGateway } from "../src/modules/queue/queue.gateway";
import { QueueProcessor } from "../src/modules/queue/queue.processor";

const sampleUser: AuthenticatedUser = {
  id: "user-e2e-1",
  email: "admin@example.com",
  firstName: "Admin",
  lastName: "User",
  orgId: "org-e2e-1",
  roleIds: ["role-1"],
  permissions: ["items.read"]
};

const createJwt = (user: AuthenticatedUser) => {
  const secret = process.env.JWT_SECRET ?? "test-jwt-secret-0123456789abcdef";
  return sign({ sub: user.id, orgId: user.orgId }, secret, {
    issuer: "modular-monolith",
    audience: "modular-monolith-clients",
    expiresIn: "1h"
  });
};

describe("App E2E", () => {
  let app: INestApplication;
  const exceptionEventsMock = {
    record: jest.fn()
  };
  const rateLimiterMock = {
    consume: jest.fn().mockResolvedValue(true)
  };
  const authServiceMock = {
    login: jest
      .fn()
      .mockResolvedValue({ accessToken: "token", refreshToken: "refresh", user: {} }),
    getUserProfile: jest.fn().mockResolvedValue(sampleUser)
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(PrismaService)
      .useValue({
        $queryRaw: jest.fn().mockResolvedValue(1)
      })
      .overrideProvider(AuthService)
      .useValue(authServiceMock)
      .overrideProvider(RateLimiterService)
      .useValue(rateLimiterMock)
      .overrideProvider(ExceptionEventsService)
      .useValue(exceptionEventsMock)
      .overrideProvider(MONGO_CONNECTION)
      .useValue({})
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
      .overrideProvider(PIPELINE_QUEUE)
      .useValue({
        add: jest.fn(),
        getJobCounts: jest.fn().mockResolvedValue({
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0
        }),
        getJob: jest.fn().mockResolvedValue(null),
        close: jest.fn()
      })
      .overrideProvider(PIPELINE_DLQ_QUEUE)
      .useValue({
        add: jest.fn(),
        close: jest.fn()
      })
      .overrideProvider(PIPELINE_QUEUE_EVENTS)
      .useValue({
        on: jest.fn(),
        off: jest.fn(),
        close: jest.fn()
      })
      .overrideProvider(QueueProcessor)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(QueueGateway)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(NotificationsGateway)
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
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimiterMock.consume.mockResolvedValue(true);
    authServiceMock.getUserProfile.mockResolvedValue(sampleUser);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns health", async () => {
    const res = await request(app.getHttpServer()).get("/api/healthz/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("allows login", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "admin@example.com", password: "Change_me123!" });
    expect(res.status).toBe(200);
  });

  it("ingests client exception events with JWT auth and overrides forged org/user", async () => {
    const token = createJwt(sampleUser);

    const res = await request(app.getHttpServer())
      .post("/api/observability/exception-events/client")
      .set("authorization", `Bearer ${token}`)
      .set("x-trace-id", "trace-e2e-1")
      .send({
        kind: "http",
        message: "Auth service unavailable",
        path: "/api/organizations/switch",
        method: "post",
        operation: "organization-switch",
        operationName: "web-api-organization-switch",
        errorName: "AbortError",
        orgId: "forged-org",
        userId: "forged-user"
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(exceptionEventsMock.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "http",
        traceId: "trace-e2e-1",
        message: "Auth service unavailable",
        path: "/api/organizations/switch",
        method: "POST",
        operation: "organization-switch",
        operationName: "web-api-organization-switch",
        errorName: "AbortError",
        orgId: sampleUser.orgId,
        userId: sampleUser.id,
        stack: undefined
      })
    );
  });

  it("returns 429 when client exception ingest is rate limited", async () => {
    const token = createJwt(sampleUser);
    rateLimiterMock.consume.mockResolvedValueOnce(false);

    const res = await request(app.getHttpServer())
      .post("/api/observability/exception-events/client")
      .set("authorization", `Bearer ${token}`)
      .send({
        kind: "http",
        message: "rate-limited"
      });

    expect(res.status).toBe(429);
  });
});
