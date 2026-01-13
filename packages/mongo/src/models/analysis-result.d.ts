import { Schema, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";
declare const AnalysisResultSchema: Schema<any, Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}, {
    [x: string]: NativeDate;
    status: "pending" | "failed" | "completed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    summary?: string | null | undefined;
    input?: any;
    output?: any;
    triggeredById?: string | null | undefined;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "failed" | "completed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    summary?: string | null | undefined;
    input?: any;
    output?: any;
    triggeredById?: string | null | undefined;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "failed" | "completed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    summary?: string | null | undefined;
    input?: any;
    output?: any;
    triggeredById?: string | null | undefined;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>;
export type AnalysisResult = InferSchemaType<typeof AnalysisResultSchema>;
export declare const AnalysisResultModel: Model<{
    [x: string]: NativeDate;
    status: "pending" | "failed" | "completed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    summary?: string | null | undefined;
    input?: any;
    output?: any;
    triggeredById?: string | null | undefined;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    status: "pending" | "failed" | "completed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    summary?: string | null | undefined;
    input?: any;
    output?: any;
    triggeredById?: string | null | undefined;
}, {}, {}> & {
    [x: string]: NativeDate;
    status: "pending" | "failed" | "completed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    summary?: string | null | undefined;
    input?: any;
    output?: any;
    triggeredById?: string | null | undefined;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, any>;
export type AnalysisResultDocument = HydratedDocument<AnalysisResult>;
export {};
//# sourceMappingURL=analysis-result.d.ts.map