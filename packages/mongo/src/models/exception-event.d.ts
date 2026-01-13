import { Schema, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";
declare const ExceptionEventSchema: Schema<any, Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}, {
    [x: string]: NativeDate;
    message: string;
    id: string;
    kind: "unknown" | "http" | "graphql";
    timestamp: NativeDate;
    traceId?: string | null | undefined;
    path?: string | null | undefined;
    orgId?: string | null | undefined;
    userId?: string | null | undefined;
    method?: string | null | undefined;
    stack?: string | null | undefined;
    statusCode?: number | null | undefined;
    operation?: string | null | undefined;
    operationName?: string | null | undefined;
    errorName?: string | null | undefined;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    message: string;
    id: string;
    kind: "unknown" | "http" | "graphql";
    timestamp: NativeDate;
    traceId?: string | null | undefined;
    path?: string | null | undefined;
    orgId?: string | null | undefined;
    userId?: string | null | undefined;
    method?: string | null | undefined;
    stack?: string | null | undefined;
    statusCode?: number | null | undefined;
    operation?: string | null | undefined;
    operationName?: string | null | undefined;
    errorName?: string | null | undefined;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    message: string;
    id: string;
    kind: "unknown" | "http" | "graphql";
    timestamp: NativeDate;
    traceId?: string | null | undefined;
    path?: string | null | undefined;
    orgId?: string | null | undefined;
    userId?: string | null | undefined;
    method?: string | null | undefined;
    stack?: string | null | undefined;
    statusCode?: number | null | undefined;
    operation?: string | null | undefined;
    operationName?: string | null | undefined;
    errorName?: string | null | undefined;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>;
export type ExceptionEvent = InferSchemaType<typeof ExceptionEventSchema>;
export declare const ExceptionEventModel: Model<{
    [x: string]: NativeDate;
    message: string;
    id: string;
    kind: "unknown" | "http" | "graphql";
    timestamp: NativeDate;
    traceId?: string | null | undefined;
    path?: string | null | undefined;
    orgId?: string | null | undefined;
    userId?: string | null | undefined;
    method?: string | null | undefined;
    stack?: string | null | undefined;
    statusCode?: number | null | undefined;
    operation?: string | null | undefined;
    operationName?: string | null | undefined;
    errorName?: string | null | undefined;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    message: string;
    id: string;
    kind: "unknown" | "http" | "graphql";
    timestamp: NativeDate;
    traceId?: string | null | undefined;
    path?: string | null | undefined;
    orgId?: string | null | undefined;
    userId?: string | null | undefined;
    method?: string | null | undefined;
    stack?: string | null | undefined;
    statusCode?: number | null | undefined;
    operation?: string | null | undefined;
    operationName?: string | null | undefined;
    errorName?: string | null | undefined;
}, {}, {}> & {
    [x: string]: NativeDate;
    message: string;
    id: string;
    kind: "unknown" | "http" | "graphql";
    timestamp: NativeDate;
    traceId?: string | null | undefined;
    path?: string | null | undefined;
    orgId?: string | null | undefined;
    userId?: string | null | undefined;
    method?: string | null | undefined;
    stack?: string | null | undefined;
    statusCode?: number | null | undefined;
    operation?: string | null | undefined;
    operationName?: string | null | undefined;
    errorName?: string | null | undefined;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, any>;
export type ExceptionEventDocument = HydratedDocument<ExceptionEvent>;
export {};
//# sourceMappingURL=exception-event.d.ts.map