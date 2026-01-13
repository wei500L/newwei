"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExceptionEventModel = void 0;
const mongoose_1 = require("mongoose");
const ExceptionEventSchema = new mongoose_1.Schema({
    id: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    userId: { type: String, index: true },
    kind: { type: String, enum: ["http", "graphql", "unknown"], required: true },
    traceId: { type: String, index: true },
    timestamp: { type: Date, required: true, index: true },
    statusCode: Number,
    message: { type: String, required: true },
    path: String,
    method: String,
    operation: String,
    operationName: String,
    errorName: String,
    stack: String
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
});
ExceptionEventSchema.index({ orgId: 1, timestamp: -1 });
ExceptionEventSchema.index({ kind: 1, timestamp: -1 });
exports.ExceptionEventModel = mongoose_1.models.ExceptionEvent ||
    (0, mongoose_1.model)("ExceptionEvent", ExceptionEventSchema);
//# sourceMappingURL=exception-event.js.map