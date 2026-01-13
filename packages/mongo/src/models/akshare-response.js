"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AkshareResponseModel = void 0;
const mongoose_1 = require("mongoose");
const AkshareResponseSchema = new mongoose_1.Schema({
    dataItemId: { type: String, required: true, index: true },
    endpoint: { type: String, required: true },
    method: { type: String, required: true },
    requestParams: { type: mongoose_1.Schema.Types.Mixed, default: {} },
    payload: { type: mongoose_1.Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, required: true, default: () => new Date() }
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
});
AkshareResponseSchema.index({ dataItemId: 1, fetchedAt: -1 });
exports.AkshareResponseModel = mongoose_1.models.AkshareResponse ||
    (0, mongoose_1.model)("AkshareResponse", AkshareResponseSchema);
//# sourceMappingURL=akshare-response.js.map