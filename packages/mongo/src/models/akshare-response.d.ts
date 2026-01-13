import { Schema, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";
declare const AkshareResponseSchema: Schema<any, Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}, {
    [x: string]: NativeDate;
    payload: any;
    dataItemId: string;
    endpoint: string;
    method: string;
    requestParams: any;
    fetchedAt: NativeDate;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    payload: any;
    dataItemId: string;
    endpoint: string;
    method: string;
    requestParams: any;
    fetchedAt: NativeDate;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    payload: any;
    dataItemId: string;
    endpoint: string;
    method: string;
    requestParams: any;
    fetchedAt: NativeDate;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>;
export type AkshareResponse = InferSchemaType<typeof AkshareResponseSchema>;
export declare const AkshareResponseModel: Model<{
    [x: string]: NativeDate;
    payload: any;
    dataItemId: string;
    endpoint: string;
    method: string;
    requestParams: any;
    fetchedAt: NativeDate;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    payload: any;
    dataItemId: string;
    endpoint: string;
    method: string;
    requestParams: any;
    fetchedAt: NativeDate;
}, {}, {}> & {
    [x: string]: NativeDate;
    payload: any;
    dataItemId: string;
    endpoint: string;
    method: string;
    requestParams: any;
    fetchedAt: NativeDate;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, any>;
export type AkshareResponseDocument = HydratedDocument<AkshareResponse>;
export {};
//# sourceMappingURL=akshare-response.d.ts.map