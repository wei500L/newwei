import { Provider } from "@nestjs/common";
import { connectMongo, disconnectMongo, MongoConnection } from "@modular/mongo";

export const MONGO_CONNECTION = Symbol("MONGO_CONNECTION");

export const MongoProvider: Provider = {
  provide: MONGO_CONNECTION,
  useFactory: async (): Promise<MongoConnection> => {
    const connection = await connectMongo();
    return connection;
  }
};

export const mongoProviders = [MongoProvider];

export const createMongoCloseHook = async () => {
  await disconnectMongo();
};
