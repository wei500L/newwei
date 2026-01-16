import 'reflect-metadata';

import { createLogger } from '@modular/utils';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { EnvService } from './modules/config/config.service';

const bootstrap = async () => {
  const logger = createLogger({ name: 'vector' });
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const env = app.get(EnvService);
  const port = env.port;
  await app.listen(port);
  logger.info({ port }, 'Vector service started');
};

void bootstrap();
