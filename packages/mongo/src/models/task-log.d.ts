import { Schema, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";
declare const TaskLogSchema: Schema<any, Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}, {
    [x: string]: NativeDate;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    queue: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    queue: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    queue: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>;
export type TaskLog = InferSchemaType<typeof TaskLogSchema>;
export declare const TaskLogModel: Model<{
    [x: string]: NativeDate;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    queue: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    queue: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}, {}, {}> & {
    [x: string]: NativeDate;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    queue: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, any>;
export type TaskLogDocument = HydratedDocument<TaskLog>;
export {};
//# sourceMappingURL=task-log.d.ts.map