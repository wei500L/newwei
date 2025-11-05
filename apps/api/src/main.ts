import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import { ConfigService } from "@nestjs/config";
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston";
import { AppModule } from "./app.module";
import { createLogger } from "@modular/utils";
import pkg from "../package.json" assert { type: "json" };

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
      httpLogger.info({
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
  app.enableCors({
    credentials: true,
    origin: true
  });

  const config = app.get(ConfigService);
  const port = config.get<number>("PORT", 4000);

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
