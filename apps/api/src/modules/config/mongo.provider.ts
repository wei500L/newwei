import type { MongoConnection } from "@modular/mongo";
import { connectMongo } from "@modular/mongo";
import type { Provider } from "@nestjs/common";

import { EnvService } from "./config.service";

export const MONGO_CONNECTION = Symbol("MONGO_CONNECTION");

export const MongoProvider: Provider = {
  provide: MONGO_CONNECTION,
  inject: [EnvService],
  useFactory: async (env: EnvService): Promise<MongoConnection> => {
    const connection = await connectMongo(undefined, env.mongoConfig);
    return connection;
  },
};

export const mongoProviders = [MongoProvider];
