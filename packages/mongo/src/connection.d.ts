import mongoose from "mongoose";
export declare const connectMongo: (uri?: string) => Promise<typeof mongoose>;
export declare const disconnectMongo: () => Promise<void>;
export type MongoConnection = typeof mongoose;
//# sourceMappingURL=connection.d.ts.map