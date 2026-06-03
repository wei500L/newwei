import { baseEnvSchema, loadAndValidateEnv } from "@modular/utils";
import mongoose from "mongoose";

let connectionPromise: Promise<typeof mongoose> | null = null;

export interface MongoConnectionOptions {
  maxPoolSize?: number;
  minPoolSize?: number;
  autoIndex?: boolean;
  bufferCommands?: boolean;
}

function readEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readEnvBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export const connectMongo = async (
  uri?: string,
  options?: MongoConnectionOptions,
) => {
  if (!connectionPromise) {
    const env = loadAndValidateEnv(baseEnvSchema.pick({ MONGO_URI: true }));
    const mongoUri = uri ?? env.MONGO_URI;
    const defaultAutoIndex = process.env.NODE_ENV !== "production";

    connectionPromise = mongoose.connect(mongoUri, {
      maxPoolSize:
        options?.maxPoolSize ?? readEnvInt("MONGO_MAX_POOL_SIZE", 20),
      minPoolSize: options?.minPoolSize ?? readEnvInt("MONGO_MIN_POOL_SIZE", 0),
      autoIndex:
        options?.autoIndex ??
        readEnvBoolean("MONGO_AUTO_INDEX", defaultAutoIndex),
      bufferCommands:
        options?.bufferCommands ??
        readEnvBoolean("MONGO_BUFFER_COMMANDS", false),
      serverSelectionTimeoutMS: 5000,
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
