module.exports = {

"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/version.js [app-ssr] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "version": ()=>version
});
var version = "3.14.0"; //# sourceMappingURL=version.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/react/context/ApolloContext.js [app-ssr] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "getApolloContext": ()=>getApolloContext,
    "resetApolloContext": ()=>resetApolloContext
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/rehackt@0.1.0_@types+react@19.2.7_react@19.2.3/node_modules/rehackt/index.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-ssr] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-ssr] (ecmascript) <locals>");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
// To make sure Apollo Client doesn't create more than one React context
// (which can lead to problems like having an Apollo Client instance added
// in one context, then attempting to retrieve it from another different
// context), a single Apollo context is created and tracked in global state.
var contextKey = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["canUseSymbol"] ? Symbol.for("__APOLLO_CONTEXT__") : "__APOLLO_CONTEXT__";
function getApolloContext() {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])("createContext" in __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__, 69);
    var context = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__.createContext[contextKey];
    if (!context) {
        Object.defineProperty(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__.createContext, contextKey, {
            value: context = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__.createContext({}),
            enumerable: false,
            writable: false,
            configurable: true
        });
        context.displayName = "ApolloContext";
    }
    return context;
}
var resetApolloContext = function() {
    if (globalThis.__DEV__ !== false) {
        globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(70);
    }
    return getApolloContext();
}; //# sourceMappingURL=ApolloContext.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/react/context/ApolloProvider.js [app-ssr] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "ApolloProvider": ()=>ApolloProvider
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-ssr] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-ssr] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/rehackt@0.1.0_@types+react@19.2.7_react@19.2.3/node_modules/rehackt/index.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$react$2f$context$2f$ApolloContext$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/react/context/ApolloContext.js [app-ssr] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
var ApolloProvider = function(_a) {
    var client = _a.client, children = _a.children;
    var ApolloContext = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$react$2f$context$2f$ApolloContext$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["getApolloContext"])();
    var parentContext = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__.useContext(ApolloContext);
    var context = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__.useMemo(function() {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__assign"])({}, parentContext), {
            client: client || parentContext.client
        });
    }, [
        parentContext,
        client
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(context.client, 71);
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$rehackt$40$0$2e$1$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_react$40$19$2e$2$2e$3$2f$node_modules$2f$rehackt$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__.createElement(ApolloContext.Provider, {
        value: context
    }, children);
}; //# sourceMappingURL=ApolloProvider.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/errors/index.js [app-ssr] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "ApolloError": ()=>ApolloError,
    "PROTOCOL_ERRORS_SYMBOL": ()=>PROTOCOL_ERRORS_SYMBOL,
    "graphQLResultHasProtocolErrors": ()=>graphQLResultHasProtocolErrors,
    "isApolloError": ()=>isApolloError
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-ssr] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/objects.js [app-ssr] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
var PROTOCOL_ERRORS_SYMBOL = Symbol();
function graphQLResultHasProtocolErrors(result) {
    if (result.extensions) {
        return Array.isArray(result.extensions[PROTOCOL_ERRORS_SYMBOL]);
    }
    return false;
}
function isApolloError(err) {
    return err.hasOwnProperty("graphQLErrors");
}
// Sets the error message on this error according to the
// the GraphQL and network errors that are present.
// If the error message has already been set through the
// constructor or otherwise, this function is a nop.
var generateErrorMessage = function(err) {
    var errors = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__spreadArray"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__spreadArray"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__spreadArray"])([], err.graphQLErrors, true), err.clientErrors, true), err.protocolErrors, true);
    if (err.networkError) errors.push(err.networkError);
    return errors// The rest of the code sometimes unsafely types non-Error objects as GraphQLErrors
    .map(function(err) {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["isNonNullObject"])(err) && err.message || "Error message not found.";
    }).join("\n");
};
var ApolloError = function(_super) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__extends"])(ApolloError, _super);
    // Constructs an instance of ApolloError given serialized GraphQL errors,
    // client errors, protocol errors or network errors.
    // Note that one of these has to be a valid
    // value or the constructed error will be meaningless.
    function ApolloError(_a) {
        var graphQLErrors = _a.graphQLErrors, protocolErrors = _a.protocolErrors, clientErrors = _a.clientErrors, networkError = _a.networkError, errorMessage = _a.errorMessage, extraInfo = _a.extraInfo;
        var _this = _super.call(this, errorMessage) || this;
        _this.name = "ApolloError";
        _this.graphQLErrors = graphQLErrors || [];
        _this.protocolErrors = protocolErrors || [];
        _this.clientErrors = clientErrors || [];
        _this.networkError = networkError || null;
        _this.message = errorMessage || generateErrorMessage(_this);
        _this.extraInfo = extraInfo;
        _this.cause = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__spreadArray"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__spreadArray"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["__spreadArray"])([
            networkError
        ], graphQLErrors || [], true), protocolErrors || [], true), clientErrors || [], true).find(function(e) {
            return !!e;
        }) || null;
        // We're not using `Object.setPrototypeOf` here as it isn't fully
        // supported on Android (see issue #3236).
        _this.__proto__ = ApolloError.prototype;
        return _this;
    }
    return ApolloError;
}(Error);
;
 //# sourceMappingURL=index.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/utils.js [app-ssr] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "MapImpl": ()=>MapImpl,
    "SetImpl": ()=>SetImpl,
    "disableWarningsSlot": ()=>disableWarningsSlot,
    "warnOnImproperCacheImplementation": ()=>warnOnImproperCacheImplementation
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-ssr] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$context$40$0$2e$7$2e$4$2f$node_modules$2f40$wry$2f$context$2f$lib$2f$slot$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+context@0.7.4/node_modules/@wry/context/lib/slot.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-ssr] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-ssr] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-ssr] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
var MapImpl = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["canUseWeakMap"] ? WeakMap : Map;
var SetImpl = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["canUseWeakSet"] ? WeakSet : Set;
var disableWarningsSlot = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$context$40$0$2e$7$2e$4$2f$node_modules$2f40$wry$2f$context$2f$lib$2f$slot$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Slot"]();
var issuedWarning = false;
function warnOnImproperCacheImplementation() {
    if (!issuedWarning) {
        issuedWarning = true;
        globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(64);
    }
} //# sourceMappingURL=utils.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/maskDefinition.js [app-ssr] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "maskDefinition": ()=>maskDefinition
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/graphql@16.12.0/node_modules/graphql/language/kinds.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/directives.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$maybeDeepFreeze$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/maybeDeepFreeze.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/storeUtils.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/utils.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-ssr] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-ssr] (ecmascript) <locals>");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
function maskDefinition(data, selectionSet, context) {
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["disableWarningsSlot"].withValue(true, function() {
        var masked = maskSelectionSet(data, selectionSet, context, false);
        if (Object.isFrozen(data)) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$maybeDeepFreeze$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["maybeDeepFreeze"])(masked);
        }
        return masked;
    });
}
function getMutableTarget(data, mutableTargets) {
    if (mutableTargets.has(data)) {
        return mutableTargets.get(data);
    }
    var mutableTarget = Array.isArray(data) ? [] : Object.create(null);
    mutableTargets.set(data, mutableTarget);
    return mutableTarget;
}
function maskSelectionSet(data, selectionSet, context, migration, path) {
    var _a;
    var knownChanged = context.knownChanged;
    var memo = getMutableTarget(data, context.mutableTargets);
    if (Array.isArray(data)) {
        for(var _i = 0, _b = Array.from(data.entries()); _i < _b.length; _i++){
            var _c = _b[_i], index = _c[0], item = _c[1];
            if (item === null) {
                memo[index] = null;
                continue;
            }
            var masked = maskSelectionSet(item, selectionSet, context, migration, globalThis.__DEV__ !== false ? "".concat(path || "", "[").concat(index, "]") : void 0);
            if (knownChanged.has(masked)) {
                knownChanged.add(memo);
            }
            memo[index] = masked;
        }
        return knownChanged.has(memo) ? memo : data;
    }
    for(var _d = 0, _e = selectionSet.selections; _d < _e.length; _d++){
        var selection = _e[_d];
        var value = void 0;
        // we later want to add acessor warnings to the final result
        // so we need a new object to add the accessor warning to
        if (migration) {
            knownChanged.add(memo);
        }
        if (selection.kind === __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Kind"].FIELD) {
            var keyName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["resultKeyNameFromField"])(selection);
            var childSelectionSet = selection.selectionSet;
            value = memo[keyName] || data[keyName];
            if (value === void 0) {
                continue;
            }
            if (childSelectionSet && value !== null) {
                var masked = maskSelectionSet(data[keyName], childSelectionSet, context, migration, globalThis.__DEV__ !== false ? "".concat(path || "", ".").concat(keyName) : void 0);
                if (knownChanged.has(masked)) {
                    value = masked;
                }
            }
            if (!(globalThis.__DEV__ !== false)) {
                memo[keyName] = value;
            }
            if (globalThis.__DEV__ !== false) {
                if (migration && keyName !== "__typename" && // either the field is not present in the memo object
                // or it has a `get` descriptor, not a `value` descriptor
                // => it is a warning accessor and we can overwrite it
                // with another accessor
                !((_a = Object.getOwnPropertyDescriptor(memo, keyName)) === null || _a === void 0 ? void 0 : _a.value)) {
                    Object.defineProperty(memo, keyName, getAccessorWarningDescriptor(keyName, value, path || "", context.operationName, context.operationType));
                } else {
                    delete memo[keyName];
                    memo[keyName] = value;
                }
            }
        }
        if (selection.kind === __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Kind"].INLINE_FRAGMENT && (!selection.typeCondition || context.cache.fragmentMatches(selection, data.__typename))) {
            value = maskSelectionSet(data, selection.selectionSet, context, migration, path);
        }
        if (selection.kind === __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Kind"].FRAGMENT_SPREAD) {
            var fragmentName = selection.name.value;
            var fragment = context.fragmentMap[fragmentName] || (context.fragmentMap[fragmentName] = context.cache.lookupFragment(fragmentName));
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(fragment, 59, fragmentName);
            var mode = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["getFragmentMaskMode"])(selection);
            if (mode !== "mask") {
                value = maskSelectionSet(data, fragment.selectionSet, context, mode === "migrate", path);
            }
        }
        if (knownChanged.has(value)) {
            knownChanged.add(memo);
        }
    }
    if ("__typename" in data && !("__typename" in memo)) {
        memo.__typename = data.__typename;
    }
    // This check prevents cases where masked fields may accidentally be
    // returned as part of this object when the fragment also selects
    // additional fields from the same child selection.
    if (Object.keys(memo).length !== Object.keys(data).length) {
        knownChanged.add(memo);
    }
    return knownChanged.has(memo) ? memo : data;
}
function getAccessorWarningDescriptor(fieldName, value, path, operationName, operationType) {
    var getValue = function() {
        if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["disableWarningsSlot"].getValue()) {
            return value;
        }
        globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(60, operationName ? "".concat(operationType, " '").concat(operationName, "'") : "anonymous ".concat(operationType), "".concat(path, ".").concat(fieldName).replace(/^\./, ""));
        getValue = function() {
            return value;
        };
        return value;
    };
    return {
        get: function() {
            return getValue();
        },
        set: function(newValue) {
            getValue = function() {
                return newValue;
            };
        },
        enumerable: true,
        configurable: true
    };
} //# sourceMappingURL=maskDefinition.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/maskFragment.js [app-ssr] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "maskFragment": ()=>maskFragment
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/graphql@16.12.0/node_modules/graphql/language/kinds.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/utils.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-ssr] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-ssr] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+equality@0.5.7/node_modules/@wry/equality/lib/index.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$maskDefinition$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/maskDefinition.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/fragments.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/getFromAST.js [app-ssr] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
;
function maskFragment(data, document, cache, fragmentName) {
    if (!cache.fragmentMatches) {
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["warnOnImproperCacheImplementation"])();
        }
        return data;
    }
    var fragments = document.definitions.filter(function(node) {
        return node.kind === __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Kind"].FRAGMENT_DEFINITION;
    });
    if (typeof fragmentName === "undefined") {
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(fragments.length === 1, 61, fragments.length);
        fragmentName = fragments[0].name.value;
    }
    var fragment = fragments.find(function(fragment) {
        return fragment.name.value === fragmentName;
    });
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(!!fragment, 62, fragmentName);
    if (data == null) {
        // Maintain the original `null` or `undefined` value
        return data;
    }
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["default"])(data, {})) {
        // Return early and skip the masking algorithm if we don't have any data
        // yet. This can happen when cache.diff returns an empty object which is
        // used from watchFragment.
        return data;
    }
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$maskDefinition$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["maskDefinition"])(data, fragment.selectionSet, {
        operationType: "fragment",
        operationName: fragment.name.value,
        fragmentMap: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["createFragmentMap"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["getFragmentDefinitions"])(document)),
        cache: cache,
        mutableTargets: new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["MapImpl"](),
        knownChanged: new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["SetImpl"]()
    });
} //# sourceMappingURL=maskFragment.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/maskOperation.js [app-ssr] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "maskOperation": ()=>maskOperation
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-ssr] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-ssr] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/fragments.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/getFromAST.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$maskDefinition$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/maskDefinition.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/utils.js [app-ssr] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
function maskOperation(data, document, cache) {
    var _a;
    if (!cache.fragmentMatches) {
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["warnOnImproperCacheImplementation"])();
        }
        return data;
    }
    var definition = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["getOperationDefinition"])(document);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(definition, 63);
    if (data == null) {
        // Maintain the original `null` or `undefined` value
        return data;
    }
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$maskDefinition$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["maskDefinition"])(data, definition.selectionSet, {
        operationType: definition.operation,
        operationName: (_a = definition.name) === null || _a === void 0 ? void 0 : _a.value,
        fragmentMap: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["createFragmentMap"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["getFragmentDefinitions"])(document)),
        cache: cache,
        mutableTargets: new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["MapImpl"](),
        knownChanged: new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["SetImpl"]()
    });
} //# sourceMappingURL=maskOperation.js.map

})()),

};

//# sourceMappingURL=bddf7_%40apollo_client_d99d87._.js.map