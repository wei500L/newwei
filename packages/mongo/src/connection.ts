import { baseEnvSchema, loadAndValidateEnv } from "@modular/utils";
import mongoose from "mongoose";

let connectionPromise: Promise<typeof mongoose> | null = null;

export const connectMongo = async (uri?: string) => {
  if (!connectionPromise) {
    const env = loadAndValidateEnv(baseEnvSchema);
    const mongoUri = uri ?? env.MONGO_URI;

    connectionPromise = mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000
    });
  }

  return connectionPromise;
};

export const disconnectMongo = async () => {
  if (connectionPromise) {
    await mongoose.disconnect();
    connectionPromise = null;
  }
};

export type MongoConnection = typeof mongoose;
