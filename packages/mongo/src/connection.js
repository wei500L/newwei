"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.disconnectMongo = exports.connectMongo = void 0;
const utils_1 = require("@modular/utils");
const mongoose_1 = __importDefault(require("mongoose"));
let connectionPromise = null;
const connectMongo = async (uri) => {
    if (!connectionPromise) {
        const env = (0, utils_1.loadAndValidateEnv)(utils_1.baseEnvSchema);
        const mongoUri = uri ?? env.MONGO_URI;
        connectionPromise = mongoose_1.default.connect(mongoUri, {
            serverSelectionTimeoutMS: 5000
        });
    }
    return connectionPromise;
};
exports.connectMongo = connectMongo;
const disconnectMongo = async () => {
    if (connectionPromise) {
        await mongoose_1.default.disconnect();
        connectionPromise = null;
    }
};
exports.disconnectMongo = disconnectMongo;
//# sourceMappingURL=connection.js.map