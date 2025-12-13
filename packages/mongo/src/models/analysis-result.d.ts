import { Schema } from "mongoose";
export declare const AnalysisResultModel: import("mongoose").Model<any, {}, {}, {}, any, any> | import("mongoose").Model<{
    [x: string]: NativeDate;
    status: "pending" | "completed" | "failed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    input?: any;
    output?: any;
    summary?: string | null | undefined;
    triggeredById?: string | null | undefined;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    status: "pending" | "completed" | "failed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    input?: any;
    output?: any;
    summary?: string | null | undefined;
    triggeredById?: string | null | undefined;
}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}> & {
    [x: string]: NativeDate;
    status: "pending" | "completed" | "failed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    input?: any;
    output?: any;
    summary?: string | null | undefined;
    triggeredById?: string | null | undefined;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, Schema<any, import("mongoose").Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}, {
    [x: string]: NativeDate;
    status: "pending" | "completed" | "failed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    input?: any;
    output?: any;
    summary?: string | null | undefined;
    triggeredById?: string | null | undefined;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "completed" | "failed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    input?: any;
    output?: any;
    summary?: string | null | undefined;
    triggeredById?: string | null | undefined;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "completed" | "failed" | "running";
    type: "correlation" | "anomaly";
    orgId: string;
    error?: string | null | undefined;
    model?: string | null | undefined;
    input?: any;
    output?: any;
    summary?: string | null | undefined;
    triggeredById?: string | null | undefined;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>>;
export type AnalysisResultDocument = typeof AnalysisResultModel extends infer T ? T extends {
    prototype: infer P;
} ? P : never : never;
//# sourceMappingURL=analysis-result.d.ts.map