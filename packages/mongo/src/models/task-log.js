"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskLogModel = void 0;
const mongoose_1 = require("mongoose");
const TaskLogSchema = new mongoose_1.Schema({
    queue: { type: String, required: true },
    jobId: { type: String, required: true },
    orgId: { type: String, index: true, required: true },
    stage: { type: String, required: true },
    status: { type: String, enum: ["pending", "processing", "completed", "failed"], required: true },
    message: { type: String },
    data: mongoose_1.Schema.Types.Mixed,
    error: mongoose_1.Schema.Types.Mixed
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
});
TaskLogSchema.index({ queue: 1, jobId: 1, stage: 1 });
TaskLogSchema.index({ orgId: 1, createdAt: -1 });
exports.TaskLogModel = mongoose_1.models.TaskLog || (0, mongoose_1.model)("TaskLog", TaskLogSchema);
//# sourceMappingURL=task-log.js.map