(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push(["static/chunks/bddf7_@apollo_client_link_16b3a0._.js", {

"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/validateOperation.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "validateOperation": ()=>validateOperation
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function validateOperation(operation) {
    var OPERATION_FIELDS = [
        "query",
        "operationName",
        "variables",
        "extensions",
        "context"
    ];
    for(var _i = 0, _a = Object.keys(operation); _i < _a.length; _i++){
        var key = _a[_i];
        if (OPERATION_FIELDS.indexOf(key) < 0) {
            throw (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["newInvariantError"])(58, key);
        }
    }
    return operation;
} //# sourceMappingURL=validateOperation.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/createOperation.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "createOperation": ()=>createOperation
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function createOperation(starting, operation) {
    var context = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, starting);
    var setContext = function(next) {
        if (typeof next === "function") {
            context = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, context), next(context));
        } else {
            context = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, context), next);
        }
    };
    var getContext = function() {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, context);
    };
    Object.defineProperty(operation, "setContext", {
        enumerable: false,
        value: setContext
    });
    Object.defineProperty(operation, "getContext", {
        enumerable: false,
        value: getContext
    });
    return operation;
} //# sourceMappingURL=createOperation.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/transformOperation.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "transformOperation": ()=>transformOperation
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/getFromAST.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function transformOperation(operation) {
    var transformedOperation = {
        variables: operation.variables || {},
        extensions: operation.extensions || {},
        operationName: operation.operationName,
        query: operation.query
    };
    // Best guess at an operation name
    if (!transformedOperation.operationName) {
        transformedOperation.operationName = typeof transformedOperation.query !== "string" ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getOperationName"])(transformedOperation.query) || undefined : "";
    }
    return transformedOperation;
} //# sourceMappingURL=transformOperation.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/ApolloLink.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "ApolloLink": ()=>ApolloLink
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/zen-observable-ts@1.2.5/node_modules/zen-observable-ts/module.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$validateOperation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/validateOperation.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$createOperation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/createOperation.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$transformOperation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/transformOperation.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/deprecation/index.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
function passthrough(op, forward) {
    return forward ? forward(op) : __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
}
function toLink(handler) {
    return typeof handler === "function" ? new ApolloLink(handler) : handler;
}
function isTerminating(link) {
    return link.request.length <= 1;
}
var ApolloLink = function() {
    function ApolloLink(request) {
        if (request) this.request = request;
    }
    ApolloLink.empty = function() {
        return new ApolloLink(function() {
            return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
        });
    };
    ApolloLink.from = function(links) {
        if (links.length === 0) return ApolloLink.empty();
        return links.map(toLink).reduce(function(x, y) {
            return x.concat(y);
        });
    };
    ApolloLink.split = function(test, left, right) {
        var leftLink = toLink(left);
        var rightLink = toLink(right || new ApolloLink(passthrough));
        var ret;
        if (isTerminating(leftLink) && isTerminating(rightLink)) {
            ret = new ApolloLink(function(operation) {
                return test(operation) ? leftLink.request(operation) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of() : rightLink.request(operation) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
            });
        } else {
            ret = new ApolloLink(function(operation, forward) {
                return test(operation) ? leftLink.request(operation, forward) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of() : rightLink.request(operation, forward) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
            });
        }
        return Object.assign(ret, {
            left: leftLink,
            right: rightLink
        });
    };
    ApolloLink.execute = function(link, operation) {
        return link.request((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$createOperation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createOperation"])(operation.context, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$transformOperation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["transformOperation"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$validateOperation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["validateOperation"])(operation)))) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
    };
    ApolloLink.concat = function(first, second) {
        var firstLink = toLink(first);
        if (isTerminating(firstLink)) {
            globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(47, firstLink);
            return firstLink;
        }
        var nextLink = toLink(second);
        var ret;
        if (isTerminating(nextLink)) {
            ret = new ApolloLink(function(operation) {
                return firstLink.request(operation, function(op) {
                    return nextLink.request(op) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
                }) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
            });
        } else {
            ret = new ApolloLink(function(operation, forward) {
                return firstLink.request(operation, function(op) {
                    return nextLink.request(op, forward) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
                }) || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"].of();
            });
        }
        return Object.assign(ret, {
            left: firstLink,
            right: nextLink
        });
    };
    ApolloLink.prototype.split = function(test, left, right) {
        return this.concat(ApolloLink.split(test, left, right || new ApolloLink(passthrough)));
    };
    ApolloLink.prototype.concat = function(next) {
        return ApolloLink.concat(this, next);
    };
    ApolloLink.prototype.request = function(operation, forward) {
        throw (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["newInvariantError"])(48);
    };
    /**
     * @deprecated `onError` will be removed with Apollo Client 4.0. Please
     * discontinue using this method.
     */ ApolloLink.prototype.onError = function(error, observer) {
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnDeprecated"])("onError", function() {
                globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(49);
            });
        }
        if (observer && observer.error) {
            observer.error(error);
            // Returning false indicates that observer.error does not need to be
            // called again, since it was already called (on the previous line).
            // Calling observer.error again would not cause any real problems,
            // since only the first call matters, but custom onError functions
            // might have other reasons for wanting to prevent the default
            // behavior by returning false.
            return false;
        }
        // Throw errors will be passed to observer.error.
        throw error;
    };
    /**
     * @deprecated `setOnError` will be removed with Apollo Client 4.0. Please
     * discontinue using this method.
     */ ApolloLink.prototype.setOnError = function(fn) {
        if (globalThis.__DEV__ !== false) {
            globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(50);
        }
        this.onError = fn;
        return this;
    };
    return ApolloLink;
}();
;
 //# sourceMappingURL=ApolloLink.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/serializeFetchParameter.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "serializeFetchParameter": ()=>serializeFetchParameter
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
"__TURBOPACK__ecmascript__hoisting__location__";
;
var serializeFetchParameter = function(p, label) {
    var serialized;
    try {
        serialized = JSON.stringify(p);
    } catch (e) {
        var parseError = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["newInvariantError"])(54, label, e.message);
        parseError.parseError = e;
        throw parseError;
    }
    return serialized;
}; //# sourceMappingURL=serializeFetchParameter.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/selectURI.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "selectURI": ()=>selectURI
});
var selectURI = function(operation, fallbackURI) {
    var context = operation.getContext();
    var contextURI = context.uri;
    if (contextURI) {
        return contextURI;
    } else if (typeof fallbackURI === "function") {
        return fallbackURI(operation);
    } else {
        return fallbackURI || "/graphql";
    }
}; //# sourceMappingURL=selectURI.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/iterators/async.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

/**
 * Original source:
 * https://github.com/kmalakoff/response-iterator/blob/master/src/iterators/async.ts
 */ __turbopack_esm__({
    "default": ()=>asyncIterator
});
function asyncIterator(source) {
    var _a;
    var iterator = source[Symbol.asyncIterator]();
    return _a = {
        next: function() {
            return iterator.next();
        }
    }, _a[Symbol.asyncIterator] = function() {
        return this;
    }, _a;
} //# sourceMappingURL=async.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/iterators/nodeStream.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

/**
 * Original source:
 * https://github.com/kmalakoff/response-iterator/blob/master/src/iterators/nodeStream.ts
 */ __turbopack_esm__({
    "default": ()=>nodeStreamIterator
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function nodeStreamIterator(stream) {
    var cleanup = null;
    var error = null;
    var done = false;
    var data = [];
    var waiting = [];
    function onData(chunk) {
        if (error) return;
        if (waiting.length) {
            var shiftedArr = waiting.shift();
            if (Array.isArray(shiftedArr) && shiftedArr[0]) {
                return shiftedArr[0]({
                    value: chunk,
                    done: false
                });
            }
        }
        data.push(chunk);
    }
    function onError(err) {
        error = err;
        var all = waiting.slice();
        all.forEach(function(pair) {
            pair[1](err);
        });
        !cleanup || cleanup();
    }
    function onEnd() {
        done = true;
        var all = waiting.slice();
        all.forEach(function(pair) {
            pair[0]({
                value: undefined,
                done: true
            });
        });
        !cleanup || cleanup();
    }
    cleanup = function() {
        cleanup = null;
        stream.removeListener("data", onData);
        stream.removeListener("error", onError);
        stream.removeListener("end", onEnd);
        stream.removeListener("finish", onEnd);
        stream.removeListener("close", onEnd);
    };
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("end", onEnd);
    stream.on("finish", onEnd);
    stream.on("close", onEnd);
    function getNext() {
        return new Promise(function(resolve, reject) {
            if (error) return reject(error);
            if (data.length) return resolve({
                value: data.shift(),
                done: false
            });
            if (done) return resolve({
                value: undefined,
                done: true
            });
            waiting.push([
                resolve,
                reject
            ]);
        });
    }
    var iterator = {
        next: function() {
            return getNext();
        }
    };
    if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseAsyncIteratorSymbol"]) {
        iterator[Symbol.asyncIterator] = function() {
            return this;
        };
    }
    return iterator;
} //# sourceMappingURL=nodeStream.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/iterators/promise.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

/**
 * Original source:
 * https://github.com/kmalakoff/response-iterator/blob/master/src/iterators/promise.ts
 */ __turbopack_esm__({
    "default": ()=>promiseIterator
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function promiseIterator(promise) {
    var resolved = false;
    var iterator = {
        next: function() {
            if (resolved) return Promise.resolve({
                value: undefined,
                done: true
            });
            resolved = true;
            return new Promise(function(resolve, reject) {
                promise.then(function(value) {
                    resolve({
                        value: value,
                        done: false
                    });
                }).catch(reject);
            });
        }
    };
    if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseAsyncIteratorSymbol"]) {
        iterator[Symbol.asyncIterator] = function() {
            return this;
        };
    }
    return iterator;
} //# sourceMappingURL=promise.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/iterators/reader.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

/**
 * Original source:
 * https://github.com/kmalakoff/response-iterator/blob/master/src/iterators/reader.ts
 */ __turbopack_esm__({
    "default": ()=>readerIterator
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function readerIterator(reader) {
    var iterator = {
        next: function() {
            return reader.read();
        }
    };
    if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseAsyncIteratorSymbol"]) {
        iterator[Symbol.asyncIterator] = function() {
            return this;
        };
    }
    return iterator;
} //# sourceMappingURL=reader.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/responseIterator.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

/**
 * Original source:
 * https://github.com/kmalakoff/response-iterator/blob/master/src/index.ts
 */ __turbopack_esm__({
    "responseIterator": ()=>responseIterator
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$async$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/iterators/async.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$nodeStream$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/iterators/nodeStream.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$promise$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/iterators/promise.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$reader$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/iterators/reader.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
function isNodeResponse(value) {
    return !!value.body;
}
function isReadableStream(value) {
    return !!value.getReader;
}
function isAsyncIterableIterator(value) {
    return !!(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseAsyncIteratorSymbol"] && value[Symbol.asyncIterator]);
}
function isStreamableBlob(value) {
    return !!value.stream;
}
function isBlob(value) {
    return !!value.arrayBuffer;
}
function isNodeReadableStream(value) {
    return !!value.pipe;
}
function responseIterator(response) {
    var body = response;
    if (isNodeResponse(response)) body = response.body;
    if (isAsyncIterableIterator(body)) return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$async$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"])(body);
    if (isReadableStream(body)) return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$reader$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"])(body.getReader());
    // this errors without casting to ReadableStream<T>
    // because Blob.stream() returns a NodeJS ReadableStream
    if (isStreamableBlob(body)) {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$reader$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"])(body.stream().getReader());
    }
    if (isBlob(body)) return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$promise$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"])(body.arrayBuffer());
    if (isNodeReadableStream(body)) return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$iterators$2f$nodeStream$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"])(body);
    throw new Error("Unknown body type for responseIterator. Please pass a streamable response.");
} //# sourceMappingURL=responseIterator.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/throwServerError.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

/**
 * @deprecated `throwServerError` will be removed in Apollo Client 4.0. This is
 * safe to use in Apollo Client 3.x.
 *
 * **Recommended now**
 *
 * No action needed
 *
 * **When migrating**
 *
 * `ServerError` is a subclass of `Error`. To throw a server error, use
 * `throw new ServerError(...)` instead.
 *
 * ```ts
 * throw new ServerError("error message", { response, result });
 * ```
 */ __turbopack_esm__({
    "throwServerError": ()=>throwServerError
});
var throwServerError = function(response, result, message) {
    var error = new Error(message);
    error.name = "ServerError";
    error.response = response;
    error.statusCode = response.status;
    error.result = result;
    throw error;
}; //# sourceMappingURL=throwServerError.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/parseAndCheckHttpResponse.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "handleError": ()=>handleError,
    "parseAndCheckHttpResponse": ()=>parseAndCheckHttpResponse,
    "parseHeaders": ()=>parseHeaders,
    "parseJsonBody": ()=>parseJsonBody,
    "readMultipartBody": ()=>readMultipartBody
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$responseIterator$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/responseIterator.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$throwServerError$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/throwServerError.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$errors$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/errors/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$incrementalResult$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/incrementalResult.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
var hasOwnProperty = Object.prototype.hasOwnProperty;
function readMultipartBody(response, nextValue) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__awaiter"])(this, void 0, void 0, function() {
        var decoder, contentType, delimiter, boundaryVal, boundary, buffer, iterator, running, _a, value, done, chunk, searchFrom, bi, message, i, headers, contentType_1, body, result, next;
        var _b, _c;
        var _d;
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__generator"])(this, function(_e) {
            switch(_e.label){
                case 0:
                    if (TextDecoder === undefined) {
                        throw new Error("TextDecoder must be defined in the environment: please import a polyfill.");
                    }
                    decoder = new TextDecoder("utf-8");
                    contentType = (_d = response.headers) === null || _d === void 0 ? void 0 : _d.get("content-type");
                    delimiter = "boundary=";
                    boundaryVal = (contentType === null || contentType === void 0 ? void 0 : contentType.includes(delimiter)) ? contentType === null || contentType === void 0 ? void 0 : contentType.substring((contentType === null || contentType === void 0 ? void 0 : contentType.indexOf(delimiter)) + delimiter.length).replace(/['"]/g, "").replace(/\;(.*)/gm, "").trim() : "-";
                    boundary = "\r\n--".concat(boundaryVal);
                    buffer = "";
                    iterator = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$responseIterator$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["responseIterator"])(response);
                    running = true;
                    _e.label = 1;
                case 1:
                    if (!running) return [
                        3 /*break*/ ,
                        3
                    ];
                    return [
                        4 /*yield*/ ,
                        iterator.next()
                    ];
                case 2:
                    _a = _e.sent(), value = _a.value, done = _a.done;
                    chunk = typeof value === "string" ? value : decoder.decode(value);
                    searchFrom = buffer.length - boundary.length + 1;
                    running = !done;
                    buffer += chunk;
                    bi = buffer.indexOf(boundary, searchFrom);
                    while(bi > -1){
                        message = void 0;
                        _b = [
                            buffer.slice(0, bi),
                            buffer.slice(bi + boundary.length)
                        ], message = _b[0], buffer = _b[1];
                        i = message.indexOf("\r\n\r\n");
                        headers = parseHeaders(message.slice(0, i));
                        contentType_1 = headers["content-type"];
                        if (contentType_1 && contentType_1.toLowerCase().indexOf("application/json") === -1) {
                            throw new Error("Unsupported patch content type: application/json is required.");
                        }
                        body = message.slice(i);
                        if (body) {
                            result = parseJsonBody(response, body);
                            if (Object.keys(result).length > 1 || "data" in result || "incremental" in result || "errors" in result || "payload" in result) {
                                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$incrementalResult$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isApolloPayloadResult"])(result)) {
                                    next = {};
                                    if ("payload" in result) {
                                        if (Object.keys(result).length === 1 && result.payload === null) {
                                            return [
                                                2 /*return*/ 
                                            ];
                                        }
                                        next = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, result.payload);
                                    }
                                    if ("errors" in result) {
                                        next = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, next), {
                                            extensions: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, "extensions" in next ? next.extensions : null), (_c = {}, _c[__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$errors$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["PROTOCOL_ERRORS_SYMBOL"]] = result.errors, _c))
                                        });
                                    }
                                    nextValue(next);
                                } else {
                                    // for the last chunk with only `hasNext: false`
                                    // we don't need to call observer.next as there is no data/errors
                                    nextValue(result);
                                }
                            } else if (// If the chunk contains only a "hasNext: false", we can call
                            // observer.complete() immediately.
                            Object.keys(result).length === 1 && "hasNext" in result && !result.hasNext) {
                                return [
                                    2 /*return*/ 
                                ];
                            }
                        }
                        bi = buffer.indexOf(boundary);
                    }
                    return [
                        3 /*break*/ ,
                        1
                    ];
                case 3:
                    return [
                        2 /*return*/ 
                    ];
            }
        });
    });
}
function parseHeaders(headerText) {
    var headersInit = {};
    headerText.split("\n").forEach(function(line) {
        var i = line.indexOf(":");
        if (i > -1) {
            // normalize headers to lowercase
            var name_1 = line.slice(0, i).trim().toLowerCase();
            var value = line.slice(i + 1).trim();
            headersInit[name_1] = value;
        }
    });
    return headersInit;
}
function parseJsonBody(response, bodyText) {
    if (response.status >= 300) {
        // Network error
        var getResult = function() {
            try {
                return JSON.parse(bodyText);
            } catch (err) {
                return bodyText;
            }
        };
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$throwServerError$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["throwServerError"])(response, getResult(), "Response not successful: Received status code ".concat(response.status));
    }
    try {
        return JSON.parse(bodyText);
    } catch (err) {
        var parseError = err;
        parseError.name = "ServerParseError";
        parseError.response = response;
        parseError.statusCode = response.status;
        parseError.bodyText = bodyText;
        throw parseError;
    }
}
function handleError(err, observer) {
    // if it is a network error, BUT there is graphql result info fire
    // the next observer before calling error this gives apollo-client
    // (and react-apollo) the `graphqlErrors` and `networkErrors` to
    // pass to UI this should only happen if we *also* have data as
    // part of the response key per the spec
    if (err.result && err.result.errors && err.result.data) {
        // if we don't call next, the UI can only show networkError
        // because AC didn't get any graphqlErrors this is graphql
        // execution result info (i.e errors and possibly data) this is
        // because there is no formal spec how errors should translate to
        // http status codes. So an auth error (401) could have both data
        // from a public field, errors from a private field, and a status
        // of 401
        // {
        //  user { // this will have errors
        //    firstName
        //  }
        //  products { // this is public so will have data
        //    cost
        //  }
        // }
        //
        // the result of above *could* look like this:
        // {
        //   data: { products: [{ cost: "$10" }] },
        //   errors: [{
        //      message: 'your session has timed out',
        //      path: []
        //   }]
        // }
        // status code of above would be a 401
        // in the UI you want to show data where you can, errors as data where you can
        // and use correct http status codes
        observer.next(err.result);
    }
    observer.error(err);
}
function parseAndCheckHttpResponse(operations) {
    return function(response) {
        return response.text().then(function(bodyText) {
            return parseJsonBody(response, bodyText);
        }).then(function(result) {
            if (!Array.isArray(result) && !hasOwnProperty.call(result, "data") && !hasOwnProperty.call(result, "errors")) {
                // Data error
                (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$throwServerError$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["throwServerError"])(response, result, "Server response was missing for query '".concat(Array.isArray(operations) ? operations.map(function(op) {
                    return op.operationName;
                }) : operations.operationName, "'."));
            }
            return result;
        });
    };
} //# sourceMappingURL=parseAndCheckHttpResponse.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/checkFetcher.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "checkFetcher": ()=>checkFetcher
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
"__TURBOPACK__ecmascript__hoisting__location__";
;
var checkFetcher = function(fetcher) {
    if (!fetcher && typeof fetch === "undefined") {
        throw (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["newInvariantError"])(51);
    }
}; //# sourceMappingURL=checkFetcher.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/selectHttpOptionsAndBody.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "defaultPrinter": ()=>defaultPrinter,
    "fallbackHttpConfig": ()=>fallbackHttpConfig,
    "selectHttpOptionsAndBody": ()=>selectHttpOptionsAndBody,
    "selectHttpOptionsAndBodyInternal": ()=>selectHttpOptionsAndBodyInternal
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$print$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/print.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
var defaultHttpOptions = {
    includeQuery: true,
    includeExtensions: false,
    preserveHeaderCase: false
};
var defaultHeaders = {
    // headers are case insensitive (https://stackoverflow.com/a/5259004)
    accept: "*/*",
    // The content-type header describes the type of the body of the request, and
    // so it typically only is sent with requests that actually have bodies. One
    // could imagine that Apollo Client would remove this header when constructing
    // a GET request (which has no body), but we historically have not done that.
    // This means that browsers will preflight all Apollo Client requests (even
    // GET requests). Apollo Server's CSRF prevention feature (introduced in
    // AS3.7) takes advantage of this fact and does not block requests with this
    // header. If you want to drop this header from GET requests, then you should
    // probably replace it with a `apollo-require-preflight` header, or servers
    // with CSRF prevention enabled might block your GET request. See
    // https://www.apollographql.com/docs/apollo-server/security/cors/#preventing-cross-site-request-forgery-csrf
    // for more details.
    "content-type": "application/json"
};
var defaultOptions = {
    method: "POST"
};
var fallbackHttpConfig = {
    http: defaultHttpOptions,
    headers: defaultHeaders,
    options: defaultOptions
};
var defaultPrinter = function(ast, printer) {
    return printer(ast);
};
function selectHttpOptionsAndBody(operation, fallbackConfig) {
    var configs = [];
    for(var _i = 2; _i < arguments.length; _i++){
        configs[_i - 2] = arguments[_i];
    }
    configs.unshift(fallbackConfig);
    return selectHttpOptionsAndBodyInternal.apply(void 0, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__spreadArray"])([
        operation,
        defaultPrinter
    ], configs, false));
}
function selectHttpOptionsAndBodyInternal(operation, printer) {
    var configs = [];
    for(var _i = 2; _i < arguments.length; _i++){
        configs[_i - 2] = arguments[_i];
    }
    var options = {};
    var http = {};
    configs.forEach(function(config) {
        options = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), config.options), {
            headers: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options.headers), config.headers)
        });
        if (config.credentials) {
            options.credentials = config.credentials;
        }
        http = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, http), config.http);
    });
    if (options.headers) {
        options.headers = removeDuplicateHeaders(options.headers, http.preserveHeaderCase);
    }
    //The body depends on the http options
    var operationName = operation.operationName, extensions = operation.extensions, variables = operation.variables, query = operation.query;
    var body = {
        operationName: operationName,
        variables: variables
    };
    if (http.includeExtensions) body.extensions = extensions;
    // not sending the query (i.e persisted queries)
    if (http.includeQuery) body.query = printer(query, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$print$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["print"]);
    return {
        options: options,
        body: body
    };
}
// Remove potential duplicate header names, preserving last (by insertion order).
// This is done to prevent unintentionally duplicating a header instead of
// overwriting it (See #8447 and #8449).
function removeDuplicateHeaders(headers, preserveHeaderCase) {
    // If we're not preserving the case, just remove duplicates w/ normalization.
    if (!preserveHeaderCase) {
        var normalizedHeaders_1 = {};
        Object.keys(Object(headers)).forEach(function(name) {
            normalizedHeaders_1[name.toLowerCase()] = headers[name];
        });
        return normalizedHeaders_1;
    }
    // If we are preserving the case, remove duplicates w/ normalization,
    // preserving the original name.
    // This allows for non-http-spec-compliant servers that expect intentionally
    // capitalized header names (See #6741).
    var headerData = {};
    Object.keys(Object(headers)).forEach(function(name) {
        headerData[name.toLowerCase()] = {
            originalName: name,
            value: headers[name]
        };
    });
    var normalizedHeaders = {};
    Object.keys(headerData).forEach(function(name) {
        normalizedHeaders[headerData[name].originalName] = headerData[name].value;
    });
    return normalizedHeaders;
} //# sourceMappingURL=selectHttpOptionsAndBody.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/rewriteURIForGET.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "rewriteURIForGET": ()=>rewriteURIForGET
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$serializeFetchParameter$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/serializeFetchParameter.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function rewriteURIForGET(chosenURI, body) {
    // Implement the standard HTTP GET serialization, plus 'extensions'. Note
    // the extra level of JSON serialization!
    var queryParams = [];
    var addQueryParam = function(key, value) {
        queryParams.push("".concat(key, "=").concat(encodeURIComponent(value)));
    };
    if ("query" in body) {
        addQueryParam("query", body.query);
    }
    if (body.operationName) {
        addQueryParam("operationName", body.operationName);
    }
    if (body.variables) {
        var serializedVariables = void 0;
        try {
            serializedVariables = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$serializeFetchParameter$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["serializeFetchParameter"])(body.variables, "Variables map");
        } catch (parseError) {
            return {
                parseError: parseError
            };
        }
        addQueryParam("variables", serializedVariables);
    }
    if (body.extensions) {
        var serializedExtensions = void 0;
        try {
            serializedExtensions = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$serializeFetchParameter$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["serializeFetchParameter"])(body.extensions, "Extensions map");
        } catch (parseError) {
            return {
                parseError: parseError
            };
        }
        addQueryParam("extensions", serializedExtensions);
    }
    // Reconstruct the URI with added query params.
    // XXX This assumes that the URI is well-formed and that it doesn't
    //     already contain any of these query params. We could instead use the
    //     URL API and take a polyfill (whatwg-url@6) for older browsers that
    //     don't support URLSearchParams. Note that some browsers (and
    //     versions of whatwg-url) support URL but not URLSearchParams!
    var fragment = "", preFragment = chosenURI;
    var fragmentStart = chosenURI.indexOf("#");
    if (fragmentStart !== -1) {
        fragment = chosenURI.substr(fragmentStart);
        preFragment = chosenURI.substr(0, fragmentStart);
    }
    var queryParamsPrefix = preFragment.indexOf("?") === -1 ? "?" : "&";
    var newURI = preFragment + queryParamsPrefix + queryParams.join("&") + fragment;
    return {
        newURI: newURI
    };
} //# sourceMappingURL=rewriteURIForGET.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/fromError.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "fromError": ()=>fromError
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/zen-observable-ts@1.2.5/node_modules/zen-observable-ts/module.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function fromError(errorValue) {
    return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"](function(observer) {
        observer.error(errorValue);
    });
} //# sourceMappingURL=fromError.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/filterOperationVariables.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "filterOperationVariables": ()=>filterOperationVariables
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$visitor$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/graphql@16.12.0/node_modules/graphql/language/visitor.mjs [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
function filterOperationVariables(variables, query) {
    var result = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, variables);
    var unusedNames = new Set(Object.keys(variables));
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$visitor$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["visit"])(query, {
        Variable: function(node, _key, parent) {
            // A variable type definition at the top level of a query is not
            // enough to silence server-side errors about the variable being
            // unused, so variable definitions do not count as usage.
            // https://spec.graphql.org/draft/#sec-All-Variables-Used
            if (parent && parent.kind !== "VariableDefinition") {
                unusedNames.delete(node.name.value);
            }
        }
    });
    unusedNames.forEach(function(name) {
        delete result[name];
    });
    return result;
} //# sourceMappingURL=filterOperationVariables.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/createHttpLink.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "createHttpLink": ()=>createHttpLink
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/ApolloLink.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/zen-observable-ts@1.2.5/node_modules/zen-observable-ts/module.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/directives.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$serializeFetchParameter$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/serializeFetchParameter.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$selectURI$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/selectURI.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$parseAndCheckHttpResponse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/parseAndCheckHttpResponse.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$checkFetcher$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/checkFetcher.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$selectHttpOptionsAndBody$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/selectHttpOptionsAndBody.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$rewriteURIForGET$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/rewriteURIForGET.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$fromError$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/fromError.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$filterOperationVariables$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/filterOperationVariables.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$maybe$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/maybe.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/getFromAST.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$transform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/transform.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
;
;
;
;
;
;
;
var backupFetch = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$maybe$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["maybe"])(function() {
    return fetch;
});
var createHttpLink = function(linkOptions) {
    if (linkOptions === void 0) {
        linkOptions = {};
    }
    var _a = linkOptions.uri, uri = _a === void 0 ? "/graphql" : _a, // use default global fetch if nothing passed in
    preferredFetch = linkOptions.fetch, _b = linkOptions.print, print = _b === void 0 ? __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$selectHttpOptionsAndBody$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["defaultPrinter"] : _b, includeExtensions = linkOptions.includeExtensions, preserveHeaderCase = linkOptions.preserveHeaderCase, useGETForQueries = linkOptions.useGETForQueries, _c = linkOptions.includeUnusedVariables, includeUnusedVariables = _c === void 0 ? false : _c, requestOptions = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__rest"])(linkOptions, [
        "uri",
        "fetch",
        "print",
        "includeExtensions",
        "preserveHeaderCase",
        "useGETForQueries",
        "includeUnusedVariables"
    ]);
    if (globalThis.__DEV__ !== false) {
        // Make sure at least one of preferredFetch, window.fetch, or backupFetch is
        // defined, so requests won't fail at runtime.
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$checkFetcher$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["checkFetcher"])(preferredFetch || backupFetch);
    }
    var linkConfig = {
        http: {
            includeExtensions: includeExtensions,
            preserveHeaderCase: preserveHeaderCase
        },
        options: requestOptions.fetchOptions,
        credentials: requestOptions.credentials,
        headers: requestOptions.headers
    };
    return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloLink"](function(operation) {
        var chosenURI = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$selectURI$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["selectURI"])(operation, uri);
        var context = operation.getContext();
        // `apollographql-client-*` headers are automatically set if a
        // `clientAwareness` object is found in the context. These headers are
        // set first, followed by the rest of the headers pulled from
        // `context.headers`. If desired, `apollographql-client-*` headers set by
        // the `clientAwareness` object can be overridden by
        // `apollographql-client-*` headers set in `context.headers`.
        var clientAwarenessHeaders = {};
        if (context.clientAwareness) {
            var _a = context.clientAwareness, name_1 = _a.name, version = _a.version;
            if (name_1) {
                clientAwarenessHeaders["apollographql-client-name"] = name_1;
            }
            if (version) {
                clientAwarenessHeaders["apollographql-client-version"] = version;
            }
        }
        var contextHeaders = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, clientAwarenessHeaders), context.headers);
        var contextConfig = {
            http: context.http,
            options: context.fetchOptions,
            credentials: context.credentials,
            headers: contextHeaders
        };
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["hasDirectives"])([
            "client"
        ], operation.query)) {
            if (globalThis.__DEV__ !== false) {
                globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(52);
            }
            var transformedQuery = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$transform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["removeClientSetsFromDocument"])(operation.query);
            if (!transformedQuery) {
                return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$fromError$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fromError"])(new Error("HttpLink: Trying to send a client-only query to the server. To send to the server, ensure a non-client field is added to the query or set the `transformOptions.removeClientFields` option to `true`."));
            }
            operation.query = transformedQuery;
        }
        //uses fallback, link, and then context to build options
        var _b = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$selectHttpOptionsAndBody$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["selectHttpOptionsAndBodyInternal"])(operation, print, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$selectHttpOptionsAndBody$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fallbackHttpConfig"], linkConfig, contextConfig), options = _b.options, body = _b.body;
        if (body.variables && !includeUnusedVariables) {
            body.variables = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$filterOperationVariables$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["filterOperationVariables"])(body.variables, operation.query);
        }
        var controller;
        if (!options.signal && typeof AbortController !== "undefined") {
            controller = new AbortController();
            options.signal = controller.signal;
        }
        // If requested, set method to GET if there are no mutations.
        var definitionIsMutation = function(d) {
            return d.kind === "OperationDefinition" && d.operation === "mutation";
        };
        var definitionIsSubscription = function(d) {
            return d.kind === "OperationDefinition" && d.operation === "subscription";
        };
        var isSubscription = definitionIsSubscription((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getMainDefinition"])(operation.query));
        // does not match custom directives beginning with @defer
        var hasDefer = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["hasDirectives"])([
            "defer"
        ], operation.query);
        if (useGETForQueries && !operation.query.definitions.some(definitionIsMutation)) {
            options.method = "GET";
        }
        if (hasDefer || isSubscription) {
            options.headers = options.headers || {};
            var acceptHeader = "multipart/mixed;";
            // Omit defer-specific headers if the user attempts to defer a selection
            // set on a subscription and log a warning.
            if (isSubscription && hasDefer) {
                globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(53);
            }
            if (isSubscription) {
                acceptHeader += "boundary=graphql;subscriptionSpec=1.0,application/json";
            } else if (hasDefer) {
                acceptHeader += "deferSpec=20220824,application/json";
            }
            options.headers.accept = acceptHeader;
        }
        if (options.method === "GET") {
            var _c = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$rewriteURIForGET$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["rewriteURIForGET"])(chosenURI, body), newURI = _c.newURI, parseError = _c.parseError;
            if (parseError) {
                return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$fromError$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fromError"])(parseError);
            }
            chosenURI = newURI;
        } else {
            try {
                options.body = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$serializeFetchParameter$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["serializeFetchParameter"])(body, "Payload");
            } catch (parseError) {
                return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$utils$2f$fromError$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["fromError"])(parseError);
            }
        }
        return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"](function(observer) {
            // Prefer linkOptions.fetch (preferredFetch) if provided, and otherwise
            // fall back to the *current* global window.fetch function (see issue
            // #7832), or (if all else fails) the backupFetch function we saved when
            // this module was first evaluated. This last option protects against the
            // removal of window.fetch, which is unlikely but not impossible.
            var currentFetch = preferredFetch || (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$maybe$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["maybe"])(function() {
                return fetch;
            }) || backupFetch;
            var observerNext = observer.next.bind(observer);
            currentFetch(chosenURI, options).then(function(response) {
                var _a;
                operation.setContext({
                    response: response
                });
                var ctype = (_a = response.headers) === null || _a === void 0 ? void 0 : _a.get("content-type");
                if (ctype !== null && /^multipart\/mixed/i.test(ctype)) {
                    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$parseAndCheckHttpResponse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["readMultipartBody"])(response, observerNext);
                } else {
                    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$parseAndCheckHttpResponse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["parseAndCheckHttpResponse"])(operation)(response).then(observerNext);
                }
            }).then(function() {
                controller = undefined;
                observer.complete();
            }).catch(function(err) {
                controller = undefined;
                (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$parseAndCheckHttpResponse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["handleError"])(err, observer);
            });
            return function() {
                // XXX support canceling this request
                // https://developers.google.com/web/updates/2017/09/abortable-fetch
                if (controller) controller.abort();
            };
        });
    });
}; //# sourceMappingURL=createHttpLink.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/HttpLink.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "HttpLink": ()=>HttpLink
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/ApolloLink.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$createHttpLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/http/createHttpLink.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
var HttpLink = function(_super) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__extends"])(HttpLink, _super);
    function HttpLink(options) {
        if (options === void 0) {
            options = {};
        }
        var _this = _super.call(this, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$http$2f$createHttpLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createHttpLink"])(options).request) || this;
        _this.options = options;
        return _this;
    }
    return HttpLink;
}(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloLink"]);
;
 //# sourceMappingURL=HttpLink.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/execute.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "execute": ()=>execute
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/ApolloLink.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
var execute = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloLink"].execute; //# sourceMappingURL=execute.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/split.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "split": ()=>split
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/ApolloLink.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
var split = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloLink"].split; //# sourceMappingURL=split.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/context/index.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "setContext": ()=>setContext
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/ApolloLink.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/zen-observable-ts@1.2.5/node_modules/zen-observable-ts/module.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
function setContext(setter) {
    return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloLink"](function(operation, forward) {
        var request = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__rest"])(operation, []);
        return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"](function(observer) {
            var handle;
            var closed = false;
            Promise.resolve(request).then(function(req) {
                return setter(req, operation.getContext());
            }).then(operation.setContext).then(function() {
                // if the observer is already closed, no need to subscribe.
                if (closed) return;
                handle = forward(operation).subscribe({
                    next: observer.next.bind(observer),
                    error: observer.error.bind(observer),
                    complete: observer.complete.bind(observer)
                });
            }).catch(observer.error.bind(observer));
            return function() {
                closed = true;
                if (handle) handle.unsubscribe();
            };
        });
    });
} //# sourceMappingURL=index.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/error/index.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "ErrorLink": ()=>ErrorLink,
    "onError": ()=>onError
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$errors$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/errors/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/zen-observable-ts@1.2.5/node_modules/zen-observable-ts/module.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/ApolloLink.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
function onError(errorHandler) {
    return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloLink"](function(operation, forward) {
        return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"](function(observer) {
            var sub;
            var retriedSub;
            var retriedResult;
            try {
                sub = forward(operation).subscribe({
                    next: function(result) {
                        if (result.errors) {
                            retriedResult = errorHandler({
                                graphQLErrors: result.errors,
                                response: result,
                                operation: operation,
                                forward: forward
                            });
                        } else if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$errors$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["graphQLResultHasProtocolErrors"])(result)) {
                            retriedResult = errorHandler({
                                protocolErrors: result.extensions[__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$errors$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["PROTOCOL_ERRORS_SYMBOL"]],
                                response: result,
                                operation: operation,
                                forward: forward
                            });
                        }
                        if (retriedResult) {
                            retriedSub = retriedResult.subscribe({
                                next: observer.next.bind(observer),
                                error: observer.error.bind(observer),
                                complete: observer.complete.bind(observer)
                            });
                            return;
                        }
                        observer.next(result);
                    },
                    error: function(networkError) {
                        retriedResult = errorHandler({
                            operation: operation,
                            networkError: networkError,
                            //Network errors can return GraphQL errors on for example a 403
                            graphQLErrors: networkError && networkError.result && networkError.result.errors || void 0,
                            forward: forward
                        });
                        if (retriedResult) {
                            retriedSub = retriedResult.subscribe({
                                next: observer.next.bind(observer),
                                error: observer.error.bind(observer),
                                complete: observer.complete.bind(observer)
                            });
                            return;
                        }
                        observer.error(networkError);
                    },
                    complete: function() {
                        // disable the previous sub from calling complete on observable
                        // if retry is in flight.
                        if (!retriedResult) {
                            observer.complete.bind(observer)();
                        }
                    }
                });
            } catch (e) {
                errorHandler({
                    networkError: e,
                    operation: operation,
                    forward: forward
                });
                observer.error(e);
            }
            return function() {
                if (sub) sub.unsubscribe();
                if (retriedSub) sub.unsubscribe();
            };
        });
    });
}
var ErrorLink = function(_super) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__extends"])(ErrorLink, _super);
    function ErrorLink(errorHandler) {
        var _this = _super.call(this) || this;
        _this.link = onError(errorHandler);
        return _this;
    }
    ErrorLink.prototype.request = function(operation, forward) {
        return this.link.request(operation, forward);
    };
    return ErrorLink;
}(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloLink"]);
;
 //# sourceMappingURL=index.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/subscriptions/index.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

// This file is adapted from the graphql-ws npm package:
// https://github.com/enisdenjo/graphql-ws
//
// Most of the file comes from that package's README; some other parts (such as
// isLikeCloseEvent) come from its source.
//
// Here's the license of the original code:
//
// The MIT License (MIT)
//
// Copyright (c) 2020-2021 Denis Badurina
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
__turbopack_esm__({
    "GraphQLWsLink": ()=>GraphQLWsLink
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$print$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/print.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/core/ApolloLink.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/objects.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/zen-observable-ts@1.2.5/node_modules/zen-observable-ts/module.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$errors$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/errors/index.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
// https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/close_event
function isLikeCloseEvent(val) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(val) && "code" in val && "reason" in val;
}
// https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/error_event
function isLikeErrorEvent(err) {
    var _a;
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(err) && ((_a = err.target) === null || _a === void 0 ? void 0 : _a.readyState) === WebSocket.CLOSED;
}
var GraphQLWsLink = function(_super) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__extends"])(GraphQLWsLink, _super);
    function GraphQLWsLink(client) {
        var _this = _super.call(this) || this;
        _this.client = client;
        return _this;
    }
    GraphQLWsLink.prototype.request = function(operation) {
        var _this = this;
        return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"](function(observer) {
            return _this.client.subscribe((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, operation), {
                query: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$print$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["print"])(operation.query)
            }), {
                next: observer.next.bind(observer),
                complete: observer.complete.bind(observer),
                error: function(err) {
                    if (err instanceof Error) {
                        return observer.error(err);
                    }
                    var likeClose = isLikeCloseEvent(err);
                    if (likeClose || isLikeErrorEvent(err)) {
                        return observer.error(// reason will be available on clean closes
                        new Error("Socket closed".concat(likeClose ? " with event ".concat(err.code) : "").concat(likeClose ? " ".concat(err.reason) : "")));
                    }
                    return observer.error(new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$errors$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloError"]({
                        graphQLErrors: Array.isArray(err) ? err : [
                            err
                        ]
                    }));
                }
            });
        });
    };
    return GraphQLWsLink;
}(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$link$2f$core$2f$ApolloLink$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloLink"]);
;
 //# sourceMappingURL=index.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/link/utils/fromPromise.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "fromPromise": ()=>fromPromise
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/zen-observable-ts@1.2.5/node_modules/zen-observable-ts/module.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function fromPromise(promise) {
    return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"](function(observer) {
        promise.then(function(value) {
            observer.next(value);
            observer.complete();
        }).catch(observer.error.bind(observer));
    });
} //# sourceMappingURL=fromPromise.js.map

})()),
}]);

//# sourceMappingURL=bddf7_%40apollo_client_link_16b3a0._.js.map