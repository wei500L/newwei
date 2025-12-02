import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston";
import { AppModule } from "./app.module";
import { createLogger } from "@modular/utils";
import pkg from "../package.json" assert { type: "json" };
import { EnvService } from "./modules/config/config.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true
  });

  const winstonLogger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(winstonLogger);

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidUnknownValues: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );

  const httpLogger = createLogger({ name: "http" });
  app.use((req, res, next) => {
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
  const corsOrigin =
    env.graphqlConfig.corsOrigin?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? true;
  app.enableCors({
    credentials: true,
    origin: corsOrigin
  });

  const port = env.port;

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

  await app.listen(port);
  winstonLogger.log(`API server started on port ${port}`);
}

bootstrap().catch((error) => {
  const logger = createLogger({ name: "bootstrap" });
  logger.error({ err: error }, "Failed to bootstrap API");
  process.exit(1);
});
