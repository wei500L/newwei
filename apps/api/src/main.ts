import "reflect-metadata";
import { createLogger } from "@modular/utils";
import { ValidationPipe , RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import { json, urlencoded, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston";
import { createRequire } from "node:module";

import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./common/websocket/redis-io.adapter";
import { EnvService } from "./modules/config/config.service";

const nodeRequire = createRequire(__filename);
const pkg = nodeRequire("../package.json") as { version?: string };

async function bootstrap() {
  const bootstrapLogger = createLogger({ name: "bootstrap" });
  bootstrapLogger.info({ node: process.version }, "Bootstrapping API");

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true
  });

  const winstonLogger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(winstonLogger);

  bootstrapLogger.info("Nest application created");

  app.setGlobalPrefix("api", {
    exclude: [
      { path: "admin/queues", method: RequestMethod.ALL },
      { path: "admin/queues/(.*)", method: RequestMethod.ALL }
    ]
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidUnknownValues: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );

  const httpLogger = createLogger({ name: "http" });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on("finish", () => {
      const traceId =
        (res.getHeader("x-trace-id") as string | undefined) ||
        (req as { traceId?: string }).traceId;
      httpLogger.info({
        traceId,
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - started
      });
    });
    next();
  });

  app.use(helmet());
  app.use(cookieParser());
  app.use(json({ limit: "10mb" }));
  app.use(urlencoded({ extended: true }));
  const env = app.get(EnvService);

  if (env.webSocketRedisAdapter.enabled) {
    const redisIoAdapter = new RedisIoAdapter(app, env);
    const connectTimeoutMs = readEnvInt("WS_REDIS_ADAPTER_CONNECT_TIMEOUT_MS", 10_000);

    bootstrapLogger.info(
      {
        host: env.redisConfig.host,
        port: env.redisConfig.port,
        db: env.redisConfig.db,
        connectTimeoutMs
      },
      "Connecting Socket.IO Redis adapter"
    );

    await withTimeout(
      redisIoAdapter.connectToRedis(),
      connectTimeoutMs,
      `Socket.IO Redis adapter connect timeout after ${connectTimeoutMs}ms`
    );
    app.useWebSocketAdapter(redisIoAdapter);
    bootstrapLogger.info("Socket.IO Redis adapter enabled");
  }

  const corsOrigin =
    env.graphqlConfig.corsOrigin?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? true;
  app.enableCors({
    credentials: true,
    origin: corsOrigin
  });

  const port = env.port;

  bootstrapLogger.info({ port }, "Building Swagger document");
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Modular Monolith API")
    .setDescription("Administrative API surface")
    .setVersion(pkg.version ?? "0.0.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" })
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, document, {
    jsonDocumentUrl: "docs/json"
  });

  bootstrapLogger.info({ port }, "Starting HTTP server");
  await app.listen(port);
  winstonLogger.log(`API server started on port ${port}`);
}

bootstrap().catch((error) => {
  const logger = createLogger({ name: "bootstrap" });
  logger.error({ err: error }, "Failed to bootstrap API");
  process.exit(1);
});

function readEnvInt(key: string, fallback: number) {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
