import request from "supertest";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/modules/config/prisma.service";
import { AuthService } from "../src/modules/auth/auth.service";
import { MONGO_CONNECTION } from "../src/modules/config/mongo.provider";
import { PIPELINE_QUEUE, PIPELINE_QUEUE_EVENTS } from "../src/modules/queue/queue.module";
import { QueueProcessor } from "../src/modules/queue/queue.processor";

describe("App E2E", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(PrismaService)
      .useValue({
        $queryRaw: jest.fn().mockResolvedValue(1)
      })
      .overrideProvider(AuthService)
      .useValue({
        login: jest.fn().mockResolvedValue({ accessToken: "token", refreshToken: "refresh", user: {} })
      })
      .overrideProvider(MONGO_CONNECTION)
      .useValue({})
      .overrideProvider(PIPELINE_QUEUE)
      .useValue({
        add: jest.fn(),
        getJobCounts: jest.fn().mockResolvedValue({
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0
        })
      })
      .overrideProvider(PIPELINE_QUEUE_EVENTS)
      .useValue({})
      .overrideProvider(QueueProcessor)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() });

    app = await moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns health", async () => {
    const res = await request(app.getHttpServer()).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBeTruthy();
  });

  it("allows login", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "admin@example.com", password: "Change_me123!" });
    expect(res.status).toBe(201);
  });
});
