import { Schema } from "mongoose";
export declare const AkshareResponseModel: import("mongoose").Model<any, {}, {}, {}, any, any> | import("mongoose").Model<{
    [x: string]: NativeDate;
    method: string;
    payload: any;
    dataItemId: string;
    endpoint: string;
    requestParams: any;
    fetchedAt: NativeDate;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    method: string;
    payload: any;
    dataItemId: string;
    endpoint: string;
    requestParams: any;
    fetchedAt: NativeDate;
}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}> & {
    [x: string]: NativeDate;
    method: string;
    payload: any;
    dataItemId: string;
    endpoint: string;
    requestParams: any;
    fetchedAt: NativeDate;
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
    method: string;
    payload: any;
    dataItemId: string;
    endpoint: string;
    requestParams: any;
    fetchedAt: NativeDate;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    method: string;
    payload: any;
    dataItemId: string;
    endpoint: string;
    requestParams: any;
    fetchedAt: NativeDate;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    method: string;
    payload: any;
    dataItemId: string;
    endpoint: string;
    requestParams: any;
    fetchedAt: NativeDate;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>>;
export type AkshareResponseDocument = typeof AkshareResponseModel extends infer T ? T extends {
    prototype: infer P;
} ? P : never : never;
//# sourceMappingURL=akshare-response.d.ts.map