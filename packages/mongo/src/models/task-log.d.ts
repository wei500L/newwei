import { Schema } from "mongoose";
export declare const TaskLogModel: import("mongoose").Model<any, {}, {}, {}, any, any> | import("mongoose").Model<{
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    queue: string;
    orgId: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    queue: string;
    orgId: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}> & {
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    queue: string;
    orgId: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
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
    status: "pending" | "processing" | "completed" | "failed";
    queue: string;
    orgId: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    queue: string;
    orgId: string;
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
    status: "pending" | "processing" | "completed" | "failed";
    queue: string;
    orgId: string;
    jobId: string;
    stage: string;
    error?: any;
    message?: string | null | undefined;
    data?: any;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>>;
export type TaskLogDocument = typeof TaskLogModel extends infer T ? T extends {
    prototype: infer P;
} ? P : never : never;
//# sourceMappingURL=task-log.d.ts.map