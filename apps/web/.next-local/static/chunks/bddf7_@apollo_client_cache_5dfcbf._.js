(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push(["static/chunks/bddf7_@apollo_client_cache_5dfcbf._.js", {

"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/reactiveVars.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "cacheSlot": ()=>cacheSlot,
    "forgetCache": ()=>forgetCache,
    "makeVar": ()=>makeVar,
    "recallCache": ()=>recallCache
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$dep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/dep.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$context$40$0$2e$7$2e$4$2f$node_modules$2f40$wry$2f$context$2f$lib$2f$slot$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+context@0.7.4/node_modules/@wry/context/lib/slot.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
var cacheSlot = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$context$40$0$2e$7$2e$4$2f$node_modules$2f40$wry$2f$context$2f$lib$2f$slot$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Slot"]();
var cacheInfoMap = new WeakMap();
function getCacheInfo(cache) {
    var info = cacheInfoMap.get(cache);
    if (!info) {
        cacheInfoMap.set(cache, info = {
            vars: new Set(),
            dep: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$dep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["dep"])()
        });
    }
    return info;
}
function forgetCache(cache) {
    getCacheInfo(cache).vars.forEach(function(rv) {
        return rv.forgetCache(cache);
    });
}
function recallCache(cache) {
    getCacheInfo(cache).vars.forEach(function(rv) {
        return rv.attachCache(cache);
    });
}
function makeVar(value) {
    var caches = new Set();
    var listeners = new Set();
    var rv = function(newValue) {
        if (arguments.length > 0) {
            if (value !== newValue) {
                value = newValue;
                caches.forEach(function(cache) {
                    // Invalidate any fields with custom read functions that
                    // consumed this variable, so query results involving those
                    // fields will be recomputed the next time we read them.
                    getCacheInfo(cache).dep.dirty(rv);
                    // Broadcast changes to any caches that have previously read
                    // from this variable.
                    broadcast(cache);
                });
                // Finally, notify any listeners added via rv.onNextChange.
                var oldListeners = Array.from(listeners);
                listeners.clear();
                oldListeners.forEach(function(listener) {
                    return listener(value);
                });
            }
        } else {
            // When reading from the variable, obtain the current cache from
            // context via cacheSlot. This isn't entirely foolproof, but it's
            // the same system that powers varDep.
            var cache = cacheSlot.getValue();
            if (cache) {
                attach(cache);
                getCacheInfo(cache).dep(rv);
            }
        }
        return value;
    };
    rv.onNextChange = function(listener) {
        listeners.add(listener);
        return function() {
            listeners.delete(listener);
        };
    };
    var attach = rv.attachCache = function(cache) {
        caches.add(cache);
        getCacheInfo(cache).vars.add(rv);
        return rv;
    };
    rv.forgetCache = function(cache) {
        return caches.delete(cache);
    };
    return rv;
}
function broadcast(cache) {
    if (cache.broadcastWatches) {
        cache.broadcastWatches();
    }
} //# sourceMappingURL=reactiveVars.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/core/cache.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "ApolloCache": ()=>ApolloCache
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/zen-observable-ts@1.2.5/node_modules/zen-observable-ts/module.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$sizes$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/caching/sizes.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/getFromAST.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/fragments.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/mergeDeep.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$caches$40$1$2e$0$2e$1$2f$node_modules$2f40$wry$2f$caches$2f$lib$2f$weak$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+caches@1.0.1/node_modules/@wry/caches/lib/weak.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$getMemoryInternals$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/caching/getMemoryInternals.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$core$2f$equalByQuery$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/core/equalByQuery.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$maskFragment$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/maskFragment.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/deprecation/index.js [app-client] (ecmascript)");
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
var ApolloCache = function() {
    function ApolloCache() {
        this.assumeImmutableResults = false;
        // Make sure we compute the same (===) fragment query document every
        // time we receive the same fragment in readFragment.
        this.getFragmentDoc = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["wrap"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getFragmentQueryDocument"], {
            max: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$sizes$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cacheSizes"]["cache.fragmentQueryDocuments"] || 1000 /* defaultCacheSizes["cache.fragmentQueryDocuments"] */ ,
            cache: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$caches$40$1$2e$0$2e$1$2f$node_modules$2f40$wry$2f$caches$2f$lib$2f$weak$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["WeakCache"]
        });
    }
    // Function used to lookup a fragment when a fragment definition is not part
    // of the GraphQL document. This is useful for caches, such as InMemoryCache,
    // that register fragments ahead of time so they can be referenced by name.
    ApolloCache.prototype.lookupFragment = function(fragmentName) {
        return null;
    };
    // Transactional API
    // The batch method is intended to replace/subsume both performTransaction
    // and recordOptimisticTransaction, but performTransaction came first, so we
    // provide a default batch implementation that's just another way of calling
    // performTransaction. Subclasses of ApolloCache (such as InMemoryCache) can
    // override the batch method to do more interesting things with its options.
    ApolloCache.prototype.batch = function(options) {
        var _this = this;
        var optimisticId = typeof options.optimistic === "string" ? options.optimistic : options.optimistic === false ? null : void 0;
        var updateResult;
        this.performTransaction(function() {
            return updateResult = options.update(_this);
        }, optimisticId);
        return updateResult;
    };
    ApolloCache.prototype.recordOptimisticTransaction = function(transaction, optimisticId) {
        this.performTransaction(transaction, optimisticId);
    };
    // Optional API
    // Called once per input document, allowing the cache to make static changes
    // to the query, such as adding __typename fields.
    ApolloCache.prototype.transformDocument = function(document) {
        return document;
    };
    // Called before each ApolloLink request, allowing the cache to make dynamic
    // changes to the query, such as filling in missing fragment definitions.
    ApolloCache.prototype.transformForLink = function(document) {
        return document;
    };
    ApolloCache.prototype.identify = function(object) {
        return;
    };
    ApolloCache.prototype.gc = function() {
        return [];
    };
    ApolloCache.prototype.modify = function(options) {
        return false;
    };
    // DataProxy API
    ApolloCache.prototype.readQuery = function(options, optimistic) {
        var _this = this;
        if (optimistic === void 0) {
            optimistic = !!options.optimistic;
        }
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(options, "canonizeResults", "cache.readQuery");
        }
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["muteDeprecations"])("canonizeResults", function() {
            return _this.read((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                rootId: options.id || "ROOT_QUERY",
                optimistic: optimistic
            }));
        });
    };
    /** {@inheritDoc @apollo/client!ApolloClient#watchFragment:member(1)} */ ApolloCache.prototype.watchFragment = function(options) {
        var _this = this;
        var fragment = options.fragment, fragmentName = options.fragmentName, from = options.from, _a = options.optimistic, optimistic = _a === void 0 ? true : _a, otherOptions = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__rest"])(options, [
            "fragment",
            "fragmentName",
            "from",
            "optimistic"
        ]);
        var query = this.getFragmentDoc(fragment, fragmentName);
        // While our TypeScript types do not allow for `undefined` as a valid
        // `from`, its possible `useFragment` gives us an `undefined` since it
        // calls` cache.identify` and provides that value to `from`. We are
        // adding this fix here however to ensure those using plain JavaScript
        // and using `cache.identify` themselves will avoid seeing the obscure
        // warning.
        var id = typeof from === "undefined" || typeof from === "string" ? from : this.identify(from);
        var dataMasking = !!options[Symbol.for("apollo.dataMasking")];
        if (globalThis.__DEV__ !== false) {
            var actualFragmentName = fragmentName || (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getFragmentDefinition"])(fragment).name.value;
            if (!id) {
                globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(1, actualFragmentName);
            }
        }
        var diffOptions = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, otherOptions), {
            returnPartialData: true,
            id: id,
            query: query,
            optimistic: optimistic
        });
        var latestDiff;
        return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zen$2d$observable$2d$ts$40$1$2e$2$2e$5$2f$node_modules$2f$zen$2d$observable$2d$ts$2f$module$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Observable"](function(observer) {
            return _this.watch((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, diffOptions), {
                immediate: true,
                callback: function(diff) {
                    var data = dataMasking ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$maskFragment$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["maskFragment"])(diff.result, fragment, _this, fragmentName) : diff.result;
                    if (// Always ensure we deliver the first result
                    latestDiff && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$core$2f$equalByQuery$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["equalByQuery"])(query, {
                        data: latestDiff.result
                    }, {
                        data: data
                    }, // TODO: Fix the type on WatchFragmentOptions so that TVars
                    // extends OperationVariables
                    options.variables)) {
                        return;
                    }
                    var result = {
                        data: data,
                        complete: !!diff.complete
                    };
                    if (diff.missing) {
                        result.missing = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["mergeDeepArray"])(diff.missing.map(function(error) {
                            return error.missing;
                        }));
                    }
                    latestDiff = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, diff), {
                        result: data
                    });
                    observer.next(result);
                }
            }));
        });
    };
    ApolloCache.prototype.readFragment = function(options, optimistic) {
        var _this = this;
        if (optimistic === void 0) {
            optimistic = !!options.optimistic;
        }
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(options, "canonizeResults", "cache.readFragment");
        }
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["muteDeprecations"])("canonizeResults", function() {
            return _this.read((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                query: _this.getFragmentDoc(options.fragment, options.fragmentName),
                rootId: options.id,
                optimistic: optimistic
            }));
        });
    };
    ApolloCache.prototype.writeQuery = function(_a) {
        var id = _a.id, data = _a.data, options = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__rest"])(_a, [
            "id",
            "data"
        ]);
        return this.write(Object.assign(options, {
            dataId: id || "ROOT_QUERY",
            result: data
        }));
    };
    ApolloCache.prototype.writeFragment = function(_a) {
        var id = _a.id, data = _a.data, fragment = _a.fragment, fragmentName = _a.fragmentName, options = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__rest"])(_a, [
            "id",
            "data",
            "fragment",
            "fragmentName"
        ]);
        return this.write(Object.assign(options, {
            query: this.getFragmentDoc(fragment, fragmentName),
            dataId: id,
            result: data
        }));
    };
    ApolloCache.prototype.updateQuery = function(options, update) {
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(options, "canonizeResults", "cache.updateQuery");
        }
        return this.batch({
            update: function(cache) {
                var value = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["muteDeprecations"])("canonizeResults", function() {
                    return cache.readQuery(options);
                });
                var data = update(value);
                if (data === void 0 || data === null) return value;
                cache.writeQuery((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                    data: data
                }));
                return data;
            }
        });
    };
    ApolloCache.prototype.updateFragment = function(options, update) {
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(options, "canonizeResults", "cache.updateFragment");
        }
        return this.batch({
            update: function(cache) {
                var value = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["muteDeprecations"])("canonizeResults", function() {
                    return cache.readFragment(options);
                });
                var data = update(value);
                if (data === void 0 || data === null) return value;
                cache.writeFragment((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                    data: data
                }));
                return data;
            }
        });
    };
    return ApolloCache;
}();
;
if (globalThis.__DEV__ !== false) {
    ApolloCache.prototype.getMemoryInternals = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$getMemoryInternals$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getApolloCacheMemoryInternals"];
} //# sourceMappingURL=cache.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/core/types/common.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "MissingFieldError": ()=>MissingFieldError
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
var MissingFieldError = function(_super) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__extends"])(MissingFieldError, _super);
    function MissingFieldError(message, path, query, variables) {
        var _a;
        // 'Error' breaks prototype chain here
        var _this = _super.call(this, message) || this;
        _this.message = message;
        _this.path = path;
        _this.query = query;
        _this.variables = variables;
        if (Array.isArray(_this.path)) {
            _this.missing = _this.message;
            for(var i = _this.path.length - 1; i >= 0; --i){
                _this.missing = (_a = {}, _a[_this.path[i]] = _this.missing, _a);
            }
        } else {
            _this.missing = _this.path;
        }
        // We're not using `Object.setPrototypeOf` here as it isn't fully supported
        // on Android (see issue #3236).
        _this.__proto__ = MissingFieldError.prototype;
        return _this;
    }
    return MissingFieldError;
}(Error);
;
 //# sourceMappingURL=common.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/helpers.js [app-client] (ecmascript) <locals>": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "TypeOrFieldNameRegExp": ()=>TypeOrFieldNameRegExp,
    "defaultDataIdFromObject": ()=>defaultDataIdFromObject,
    "extractFragmentContext": ()=>extractFragmentContext,
    "fieldNameFromStoreName": ()=>fieldNameFromStoreName,
    "getTypenameFromStoreObject": ()=>getTypenameFromStoreObject,
    "hasOwn": ()=>hasOwn,
    "isNullish": ()=>isNullish,
    "makeProcessedFieldsMerger": ()=>makeProcessedFieldsMerger,
    "normalizeConfig": ()=>normalizeConfig,
    "selectionSetMatchesResult": ()=>selectionSetMatchesResult,
    "shouldCanonizeResults": ()=>shouldCanonizeResults,
    "storeValueIsStoreObject": ()=>storeValueIsStoreObject
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$compact$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/compact.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/storeUtils.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/objects.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/arrays.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/directives.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/mergeDeep.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/fragments.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/getFromAST.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
var hasOwn = Object.prototype.hasOwnProperty;
function isNullish(value) {
    return value === null || value === void 0;
}
;
function defaultDataIdFromObject(_a, context) {
    var __typename = _a.__typename, id = _a.id, _id = _a._id;
    if (typeof __typename === "string") {
        if (context) {
            context.keyObject = !isNullish(id) ? {
                id: id
            } : !isNullish(_id) ? {
                _id: _id
            } : void 0;
        }
        // If there is no object.id, fall back to object._id.
        if (isNullish(id) && !isNullish(_id)) {
            id = _id;
        }
        if (!isNullish(id)) {
            return "".concat(__typename, ":").concat(typeof id === "number" || typeof id === "string" ? id : JSON.stringify(id));
        }
    }
}
var defaultConfig = {
    dataIdFromObject: defaultDataIdFromObject,
    addTypename: true,
    resultCaching: true,
    // Thanks to the shouldCanonizeResults helper, this should be the only line
    // you have to change to reenable canonization by default in the future.
    canonizeResults: false
};
function normalizeConfig(config) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$compact$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["compact"])(defaultConfig, config);
}
function shouldCanonizeResults(config) {
    var value = config.canonizeResults;
    return value === void 0 ? defaultConfig.canonizeResults : value;
}
function getTypenameFromStoreObject(store, objectOrReference) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(objectOrReference) ? store.get(objectOrReference.__ref, "__typename") : objectOrReference && objectOrReference.__typename;
}
var TypeOrFieldNameRegExp = /^[_a-z][_0-9a-z]*/i;
function fieldNameFromStoreName(storeFieldName) {
    var match = storeFieldName.match(TypeOrFieldNameRegExp);
    return match ? match[0] : storeFieldName;
}
function selectionSetMatchesResult(selectionSet, result, variables) {
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(result)) {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(result) ? result.every(function(item) {
            return selectionSetMatchesResult(selectionSet, item, variables);
        }) : selectionSet.selections.every(function(field) {
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isField"])(field) && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["shouldInclude"])(field, variables)) {
                var key = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["resultKeyNameFromField"])(field);
                return hasOwn.call(result, key) && (!field.selectionSet || selectionSetMatchesResult(field.selectionSet, result[key], variables));
            }
            // If the selection has been skipped with @skip(true) or
            // @include(false), it should not count against the matching. If
            // the selection is not a field, it must be a fragment (inline or
            // named). We will determine if selectionSetMatchesResult for that
            // fragment when we get to it, so for now we return true.
            return true;
        });
    }
    return false;
}
function storeValueIsStoreObject(value) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(value) && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(value) && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(value);
}
function makeProcessedFieldsMerger() {
    return new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["DeepMerger"]();
}
function extractFragmentContext(document, fragments) {
    // FragmentMap consisting only of fragments defined directly in document, not
    // including other fragments registered in the FragmentRegistry.
    var fragmentMap = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createFragmentMap"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getFragmentDefinitions"])(document));
    return {
        fragmentMap: fragmentMap,
        lookupFragment: function(name) {
            var def = fragmentMap[name];
            if (!def && fragments) {
                def = fragments.lookup(name);
            }
            return def || null;
        }
    };
} //# sourceMappingURL=helpers.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/entityStore.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "EntityStore": ()=>EntityStore,
    "maybeDependOnExistenceOfEntity": ()=>maybeDependOnExistenceOfEntity,
    "supportsResultCaching": ()=>supportsResultCaching
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$dep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/dep.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+equality@0.5.7/node_modules/@wry/equality/lib/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$trie$40$0$2e$5$2e$0$2f$node_modules$2f40$wry$2f$trie$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+trie@0.5.0/node_modules/@wry/trie/lib/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/storeUtils.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/mergeDeep.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$maybeDeepFreeze$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/maybeDeepFreeze.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/objects.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/helpers.js [app-client] (ecmascript) <locals>");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
;
;
var DELETE = Object.create(null);
var delModifier = function() {
    return DELETE;
};
var INVALIDATE = Object.create(null);
var EntityStore = function() {
    function EntityStore(policies, group) {
        var _this = this;
        this.policies = policies;
        this.group = group;
        this.data = Object.create(null);
        // Maps root entity IDs to the number of times they have been retained, minus
        // the number of times they have been released. Retained entities keep other
        // entities they reference (even indirectly) from being garbage collected.
        this.rootIds = Object.create(null);
        // Lazily tracks { __ref: <dataId> } strings contained by this.data[dataId].
        this.refs = Object.create(null);
        // Bound function that can be passed around to provide easy access to fields
        // of Reference objects as well as ordinary objects.
        this.getFieldValue = function(objectOrReference, storeFieldName) {
            return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$maybeDeepFreeze$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["maybeDeepFreeze"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(objectOrReference) ? _this.get(objectOrReference.__ref, storeFieldName) : objectOrReference && objectOrReference[storeFieldName]);
        };
        // Returns true for non-normalized StoreObjects and non-dangling
        // References, indicating that readField(name, objOrRef) has a chance of
        // working. Useful for filtering out dangling references from lists.
        this.canRead = function(objOrRef) {
            return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(objOrRef) ? _this.has(objOrRef.__ref) : typeof objOrRef === "object";
        };
        // Bound function that converts an id or an object with a __typename and
        // primary key fields to a Reference object. If called with a Reference object,
        // that same Reference object is returned. Pass true for mergeIntoStore to persist
        // an object into the store.
        this.toReference = function(objOrIdOrRef, mergeIntoStore) {
            if (typeof objOrIdOrRef === "string") {
                return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["makeReference"])(objOrIdOrRef);
            }
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(objOrIdOrRef)) {
                return objOrIdOrRef;
            }
            var id = _this.policies.identify(objOrIdOrRef)[0];
            if (id) {
                var ref = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["makeReference"])(id);
                if (mergeIntoStore) {
                    _this.merge(id, objOrIdOrRef);
                }
                return ref;
            }
        };
    }
    // Although the EntityStore class is abstract, it contains concrete
    // implementations of the various NormalizedCache interface methods that
    // are inherited by the Root and Layer subclasses.
    EntityStore.prototype.toObject = function() {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, this.data);
    };
    EntityStore.prototype.has = function(dataId) {
        return this.lookup(dataId, true) !== void 0;
    };
    EntityStore.prototype.get = function(dataId, fieldName) {
        this.group.depend(dataId, fieldName);
        if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(this.data, dataId)) {
            var storeObject = this.data[dataId];
            if (storeObject && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(storeObject, fieldName)) {
                return storeObject[fieldName];
            }
        }
        if (fieldName === "__typename" && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(this.policies.rootTypenamesById, dataId)) {
            return this.policies.rootTypenamesById[dataId];
        }
        if (this instanceof Layer) {
            return this.parent.get(dataId, fieldName);
        }
    };
    EntityStore.prototype.lookup = function(dataId, dependOnExistence) {
        // The has method (above) calls lookup with dependOnExistence = true, so
        // that it can later be invalidated when we add or remove a StoreObject for
        // this dataId. Any consumer who cares about the contents of the StoreObject
        // should not rely on this dependency, since the contents could change
        // without the object being added or removed.
        if (dependOnExistence) this.group.depend(dataId, "__exists");
        if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(this.data, dataId)) {
            return this.data[dataId];
        }
        if (this instanceof Layer) {
            return this.parent.lookup(dataId, dependOnExistence);
        }
        if (this.policies.rootTypenamesById[dataId]) {
            return Object.create(null);
        }
    };
    EntityStore.prototype.merge = function(older, newer) {
        var _this = this;
        var dataId;
        // Convert unexpected references to ID strings.
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(older)) older = older.__ref;
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(newer)) newer = newer.__ref;
        var existing = typeof older === "string" ? this.lookup(dataId = older) : older;
        var incoming = typeof newer === "string" ? this.lookup(dataId = newer) : newer;
        // If newer was a string ID, but that ID was not defined in this store,
        // then there are no fields to be merged, so we're done.
        if (!incoming) return;
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(typeof dataId === "string", 2);
        var merged = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["DeepMerger"](storeObjectReconciler).merge(existing, incoming);
        // Even if merged === existing, existing may have come from a lower
        // layer, so we always need to set this.data[dataId] on this level.
        this.data[dataId] = merged;
        if (merged !== existing) {
            delete this.refs[dataId];
            if (this.group.caching) {
                var fieldsToDirty_1 = Object.create(null);
                // If we added a new StoreObject where there was previously none, dirty
                // anything that depended on the existence of this dataId, such as the
                // EntityStore#has method.
                if (!existing) fieldsToDirty_1.__exists = 1;
                // Now invalidate dependents who called getFieldValue for any fields
                // that are changing as a result of this merge.
                Object.keys(incoming).forEach(function(storeFieldName) {
                    if (!existing || existing[storeFieldName] !== merged[storeFieldName]) {
                        // Always dirty the full storeFieldName, which may include
                        // serialized arguments following the fieldName prefix.
                        fieldsToDirty_1[storeFieldName] = 1;
                        // Also dirty fieldNameFromStoreName(storeFieldName) if it's
                        // different from storeFieldName and this field does not have
                        // keyArgs configured, because that means the cache can't make
                        // any assumptions about how field values with the same field
                        // name but different arguments might be interrelated, so it
                        // must err on the side of invalidating all field values that
                        // share the same short fieldName, regardless of arguments.
                        var fieldName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["fieldNameFromStoreName"])(storeFieldName);
                        if (fieldName !== storeFieldName && !_this.policies.hasKeyArgs(merged.__typename, fieldName)) {
                            fieldsToDirty_1[fieldName] = 1;
                        }
                        // If merged[storeFieldName] has become undefined, and this is the
                        // Root layer, actually delete the property from the merged object,
                        // which is guaranteed to have been created fresh in this method.
                        if (merged[storeFieldName] === void 0 && !(_this instanceof Layer)) {
                            delete merged[storeFieldName];
                        }
                    }
                });
                if (fieldsToDirty_1.__typename && !(existing && existing.__typename) && // Since we return default root __typename strings
                // automatically from store.get, we don't need to dirty the
                // ROOT_QUERY.__typename field if merged.__typename is equal
                // to the default string (usually "Query").
                this.policies.rootTypenamesById[dataId] === merged.__typename) {
                    delete fieldsToDirty_1.__typename;
                }
                Object.keys(fieldsToDirty_1).forEach(function(fieldName) {
                    return _this.group.dirty(dataId, fieldName);
                });
            }
        }
    };
    EntityStore.prototype.modify = function(dataId, fields) {
        var _this = this;
        var storeObject = this.lookup(dataId);
        if (storeObject) {
            var changedFields_1 = Object.create(null);
            var needToMerge_1 = false;
            var allDeleted_1 = true;
            var sharedDetails_1 = {
                DELETE: DELETE,
                INVALIDATE: INVALIDATE,
                isReference: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"],
                toReference: this.toReference,
                canRead: this.canRead,
                readField: function(fieldNameOrOptions, from) {
                    return _this.policies.readField(typeof fieldNameOrOptions === "string" ? {
                        fieldName: fieldNameOrOptions,
                        from: from || (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["makeReference"])(dataId)
                    } : fieldNameOrOptions, {
                        store: _this
                    });
                }
            };
            Object.keys(storeObject).forEach(function(storeFieldName) {
                var fieldName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["fieldNameFromStoreName"])(storeFieldName);
                var fieldValue = storeObject[storeFieldName];
                if (fieldValue === void 0) return;
                var modify = typeof fields === "function" ? fields : fields[storeFieldName] || fields[fieldName];
                if (modify) {
                    var newValue = modify === delModifier ? DELETE : modify((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$maybeDeepFreeze$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["maybeDeepFreeze"])(fieldValue), (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, sharedDetails_1), {
                        fieldName: fieldName,
                        storeFieldName: storeFieldName,
                        storage: _this.getStorage(dataId, storeFieldName)
                    }));
                    if (newValue === INVALIDATE) {
                        _this.group.dirty(dataId, storeFieldName);
                    } else {
                        if (newValue === DELETE) newValue = void 0;
                        if (newValue !== fieldValue) {
                            changedFields_1[storeFieldName] = newValue;
                            needToMerge_1 = true;
                            fieldValue = newValue;
                            if (globalThis.__DEV__ !== false) {
                                var checkReference = function(ref) {
                                    if (_this.lookup(ref.__ref) === undefined) {
                                        globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(3, ref);
                                        return true;
                                    }
                                };
                                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(newValue)) {
                                    checkReference(newValue);
                                } else if (Array.isArray(newValue)) {
                                    // Warn about writing "mixed" arrays of Reference and non-Reference objects
                                    var seenReference = false;
                                    var someNonReference = void 0;
                                    for(var _i = 0, newValue_1 = newValue; _i < newValue_1.length; _i++){
                                        var value = newValue_1[_i];
                                        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(value)) {
                                            seenReference = true;
                                            if (checkReference(value)) break;
                                        } else {
                                            // Do not warn on primitive values, since those could never be represented
                                            // by a reference. This is a valid (albeit uncommon) use case.
                                            if (typeof value === "object" && !!value) {
                                                var id = _this.policies.identify(value)[0];
                                                // check if object could even be referenced, otherwise we are not interested in it for this warning
                                                if (id) {
                                                    someNonReference = value;
                                                }
                                            }
                                        }
                                        if (seenReference && someNonReference !== undefined) {
                                            globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(4, someNonReference);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if (fieldValue !== void 0) {
                    allDeleted_1 = false;
                }
            });
            if (needToMerge_1) {
                this.merge(dataId, changedFields_1);
                if (allDeleted_1) {
                    if (this instanceof Layer) {
                        this.data[dataId] = void 0;
                    } else {
                        delete this.data[dataId];
                    }
                    this.group.dirty(dataId, "__exists");
                }
                return true;
            }
        }
        return false;
    };
    // If called with only one argument, removes the entire entity
    // identified by dataId. If called with a fieldName as well, removes all
    // fields of that entity whose names match fieldName according to the
    // fieldNameFromStoreName helper function. If called with a fieldName
    // and variables, removes all fields of that entity whose names match fieldName
    // and whose arguments when cached exactly match the variables passed.
    EntityStore.prototype.delete = function(dataId, fieldName, args) {
        var _a;
        var storeObject = this.lookup(dataId);
        if (storeObject) {
            var typename = this.getFieldValue(storeObject, "__typename");
            var storeFieldName = fieldName && args ? this.policies.getStoreFieldName({
                typename: typename,
                fieldName: fieldName,
                args: args
            }) : fieldName;
            return this.modify(dataId, storeFieldName ? (_a = {}, _a[storeFieldName] = delModifier, _a) : delModifier);
        }
        return false;
    };
    EntityStore.prototype.evict = function(options, limit) {
        var evicted = false;
        if (options.id) {
            if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(this.data, options.id)) {
                evicted = this.delete(options.id, options.fieldName, options.args);
            }
            if (this instanceof Layer && this !== limit) {
                evicted = this.parent.evict(options, limit) || evicted;
            }
            // Always invalidate the field to trigger rereading of watched
            // queries, even if no cache data was modified by the eviction,
            // because queries may depend on computed fields with custom read
            // functions, whose values are not stored in the EntityStore.
            if (options.fieldName || evicted) {
                this.group.dirty(options.id, options.fieldName || "__exists");
            }
        }
        return evicted;
    };
    EntityStore.prototype.clear = function() {
        this.replace(null);
    };
    EntityStore.prototype.extract = function() {
        var _this = this;
        var obj = this.toObject();
        var extraRootIds = [];
        this.getRootIdSet().forEach(function(id) {
            if (!__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(_this.policies.rootTypenamesById, id)) {
                extraRootIds.push(id);
            }
        });
        if (extraRootIds.length) {
            obj.__META = {
                extraRootIds: extraRootIds.sort()
            };
        }
        return obj;
    };
    EntityStore.prototype.replace = function(newData) {
        var _this = this;
        Object.keys(this.data).forEach(function(dataId) {
            if (!(newData && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(newData, dataId))) {
                _this.delete(dataId);
            }
        });
        if (newData) {
            var __META = newData.__META, rest_1 = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__rest"])(newData, [
                "__META"
            ]);
            Object.keys(rest_1).forEach(function(dataId) {
                _this.merge(dataId, rest_1[dataId]);
            });
            if (__META) {
                __META.extraRootIds.forEach(this.retain, this);
            }
        }
    };
    EntityStore.prototype.retain = function(rootId) {
        return this.rootIds[rootId] = (this.rootIds[rootId] || 0) + 1;
    };
    EntityStore.prototype.release = function(rootId) {
        if (this.rootIds[rootId] > 0) {
            var count = --this.rootIds[rootId];
            if (!count) delete this.rootIds[rootId];
            return count;
        }
        return 0;
    };
    // Return a Set<string> of all the ID strings that have been retained by
    // this layer/root *and* any layers/roots beneath it.
    EntityStore.prototype.getRootIdSet = function(ids) {
        if (ids === void 0) {
            ids = new Set();
        }
        Object.keys(this.rootIds).forEach(ids.add, ids);
        if (this instanceof Layer) {
            this.parent.getRootIdSet(ids);
        } else {
            // Official singleton IDs like ROOT_QUERY and ROOT_MUTATION are
            // always considered roots for garbage collection, regardless of
            // their retainment counts in this.rootIds.
            Object.keys(this.policies.rootTypenamesById).forEach(ids.add, ids);
        }
        return ids;
    };
    // The goal of garbage collection is to remove IDs from the Root layer of the
    // store that are no longer reachable starting from any IDs that have been
    // explicitly retained (see retain and release, above). Returns an array of
    // dataId strings that were removed from the store.
    EntityStore.prototype.gc = function() {
        var _this = this;
        var ids = this.getRootIdSet();
        var snapshot = this.toObject();
        ids.forEach(function(id) {
            if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(snapshot, id)) {
                // Because we are iterating over an ECMAScript Set, the IDs we add here
                // will be visited in later iterations of the forEach loop only if they
                // were not previously contained by the Set.
                Object.keys(_this.findChildRefIds(id)).forEach(ids.add, ids);
                // By removing IDs from the snapshot object here, we protect them from
                // getting removed from the root store layer below.
                delete snapshot[id];
            }
        });
        var idsToRemove = Object.keys(snapshot);
        if (idsToRemove.length) {
            var root_1 = this;
            while(root_1 instanceof Layer)root_1 = root_1.parent;
            idsToRemove.forEach(function(id) {
                return root_1.delete(id);
            });
        }
        return idsToRemove;
    };
    EntityStore.prototype.findChildRefIds = function(dataId) {
        if (!__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(this.refs, dataId)) {
            var found_1 = this.refs[dataId] = Object.create(null);
            var root = this.data[dataId];
            if (!root) return found_1;
            var workSet_1 = new Set([
                root
            ]);
            // Within the store, only arrays and objects can contain child entity
            // references, so we can prune the traversal using this predicate:
            workSet_1.forEach(function(obj) {
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(obj)) {
                    found_1[obj.__ref] = true;
                // In rare cases, a { __ref } Reference object may have other fields.
                // This often indicates a mismerging of References with StoreObjects,
                // but garbage collection should not be fooled by a stray __ref
                // property in a StoreObject (ignoring all the other fields just
                // because the StoreObject looks like a Reference). To avoid this
                // premature termination of findChildRefIds recursion, we fall through
                // to the code below, which will handle any other properties of obj.
                }
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(obj)) {
                    Object.keys(obj).forEach(function(key) {
                        var child = obj[key];
                        // No need to add primitive values to the workSet, since they cannot
                        // contain reference objects.
                        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(child)) {
                            workSet_1.add(child);
                        }
                    });
                }
            });
        }
        return this.refs[dataId];
    };
    EntityStore.prototype.makeCacheKey = function() {
        return this.group.keyMaker.lookupArray(arguments);
    };
    return EntityStore;
}();
;
// A single CacheGroup represents a set of one or more EntityStore objects,
// typically the Root store in a CacheGroup by itself, and all active Layer
// stores in a group together. A single EntityStore object belongs to only
// one CacheGroup, store.group. The CacheGroup is responsible for tracking
// dependencies, so store.group is helpful for generating unique keys for
// cached results that need to be invalidated when/if those dependencies
// change. If we used the EntityStore objects themselves as cache keys (that
// is, store rather than store.group), the cache would become unnecessarily
// fragmented by all the different Layer objects. Instead, the CacheGroup
// approach allows all optimistic Layer objects in the same linked list to
// belong to one CacheGroup, with the non-optimistic Root object belonging
// to another CacheGroup, allowing resultCaching dependencies to be tracked
// separately for optimistic and non-optimistic entity data.
var CacheGroup = function() {
    function CacheGroup(caching, parent) {
        if (parent === void 0) {
            parent = null;
        }
        this.caching = caching;
        this.parent = parent;
        this.d = null;
        this.resetCaching();
    }
    CacheGroup.prototype.resetCaching = function() {
        this.d = this.caching ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$dep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["dep"])() : null;
        this.keyMaker = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$trie$40$0$2e$5$2e$0$2f$node_modules$2f40$wry$2f$trie$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Trie"](__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseWeakMap"]);
    };
    CacheGroup.prototype.depend = function(dataId, storeFieldName) {
        if (this.d) {
            this.d(makeDepKey(dataId, storeFieldName));
            var fieldName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["fieldNameFromStoreName"])(storeFieldName);
            if (fieldName !== storeFieldName) {
                // Fields with arguments that contribute extra identifying
                // information to the fieldName (thus forming the storeFieldName)
                // depend not only on the full storeFieldName but also on the
                // short fieldName, so the field can be invalidated using either
                // level of specificity.
                this.d(makeDepKey(dataId, fieldName));
            }
            if (this.parent) {
                this.parent.depend(dataId, storeFieldName);
            }
        }
    };
    CacheGroup.prototype.dirty = function(dataId, storeFieldName) {
        if (this.d) {
            this.d.dirty(makeDepKey(dataId, storeFieldName), // When storeFieldName === "__exists", that means the entity identified
            // by dataId has either disappeared from the cache or was newly added,
            // so the result caching system would do well to "forget everything it
            // knows" about that object. To achieve that kind of invalidation, we
            // not only dirty the associated result cache entry, but also remove it
            // completely from the dependency graph. For the optimism implementation
            // details, see https://github.com/benjamn/optimism/pull/195.
            storeFieldName === "__exists" ? "forget" : "setDirty");
        }
    };
    return CacheGroup;
}();
function makeDepKey(dataId, storeFieldName) {
    // Since field names cannot have '#' characters in them, this method
    // of joining the field name and the ID should be unambiguous, and much
    // cheaper than JSON.stringify([dataId, fieldName]).
    return storeFieldName + "#" + dataId;
}
function maybeDependOnExistenceOfEntity(store, entityId) {
    if (supportsResultCaching(store)) {
        // We use this pseudo-field __exists elsewhere in the EntityStore code to
        // represent changes in the existence of the entity object identified by
        // entityId. This dependency gets reliably dirtied whenever an object with
        // this ID is deleted (or newly created) within this group, so any result
        // cache entries (for example, StoreReader#executeSelectionSet results) that
        // depend on __exists for this entityId will get dirtied as well, leading to
        // the eventual recomputation (instead of reuse) of those result objects the
        // next time someone reads them from the cache.
        store.group.depend(entityId, "__exists");
    }
}
(function(EntityStore) {
    // Refer to this class as EntityStore.Root outside this namespace.
    var Root = function(_super) {
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__extends"])(Root, _super);
        function Root(_a) {
            var policies = _a.policies, _b = _a.resultCaching, resultCaching = _b === void 0 ? true : _b, seed = _a.seed;
            var _this = _super.call(this, policies, new CacheGroup(resultCaching)) || this;
            _this.stump = new Stump(_this);
            _this.storageTrie = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$trie$40$0$2e$5$2e$0$2f$node_modules$2f40$wry$2f$trie$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Trie"](__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseWeakMap"]);
            if (seed) _this.replace(seed);
            return _this;
        }
        Root.prototype.addLayer = function(layerId, replay) {
            // Adding an optimistic Layer on top of the Root actually adds the Layer
            // on top of the Stump, so the Stump always comes between the Root and
            // any Layer objects that we've added.
            return this.stump.addLayer(layerId, replay);
        };
        Root.prototype.removeLayer = function() {
            // Never remove the root layer.
            return this;
        };
        Root.prototype.getStorage = function() {
            return this.storageTrie.lookupArray(arguments);
        };
        return Root;
    }(EntityStore);
    EntityStore.Root = Root;
})(EntityStore || (EntityStore = {}));
// Not exported, since all Layer instances are created by the addLayer method
// of the EntityStore.Root class.
var Layer = function(_super) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__extends"])(Layer, _super);
    function Layer(id, parent, replay, group) {
        var _this = _super.call(this, parent.policies, group) || this;
        _this.id = id;
        _this.parent = parent;
        _this.replay = replay;
        _this.group = group;
        replay(_this);
        return _this;
    }
    Layer.prototype.addLayer = function(layerId, replay) {
        return new Layer(layerId, this, replay, this.group);
    };
    Layer.prototype.removeLayer = function(layerId) {
        var _this = this;
        // Remove all instances of the given id, not just the first one.
        var parent = this.parent.removeLayer(layerId);
        if (layerId === this.id) {
            if (this.group.caching) {
                // Dirty every ID we're removing. Technically we might be able to avoid
                // dirtying fields that have values in higher layers, but we don't have
                // easy access to higher layers here, and we're about to recreate those
                // layers anyway (see parent.addLayer below).
                Object.keys(this.data).forEach(function(dataId) {
                    var ownStoreObject = _this.data[dataId];
                    var parentStoreObject = parent["lookup"](dataId);
                    if (!parentStoreObject) {
                        // The StoreObject identified by dataId was defined in this layer
                        // but will be undefined in the parent layer, so we can delete the
                        // whole entity using this.delete(dataId). Since we're about to
                        // throw this layer away, the only goal of this deletion is to dirty
                        // the removed fields.
                        _this.delete(dataId);
                    } else if (!ownStoreObject) {
                        // This layer had an entry for dataId but it was undefined, which
                        // means the entity was deleted in this layer, and it's about to
                        // become undeleted when we remove this layer, so we need to dirty
                        // all fields that are about to be reexposed.
                        _this.group.dirty(dataId, "__exists");
                        Object.keys(parentStoreObject).forEach(function(storeFieldName) {
                            _this.group.dirty(dataId, storeFieldName);
                        });
                    } else if (ownStoreObject !== parentStoreObject) {
                        // If ownStoreObject is not exactly the same as parentStoreObject,
                        // dirty any fields whose values will change as a result of this
                        // removal.
                        Object.keys(ownStoreObject).forEach(function(storeFieldName) {
                            if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["equal"])(ownStoreObject[storeFieldName], parentStoreObject[storeFieldName])) {
                                _this.group.dirty(dataId, storeFieldName);
                            }
                        });
                    }
                });
            }
            return parent;
        }
        // No changes are necessary if the parent chain remains identical.
        if (parent === this.parent) return this;
        // Recreate this layer on top of the new parent.
        return parent.addLayer(this.id, this.replay);
    };
    Layer.prototype.toObject = function() {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, this.parent.toObject()), this.data);
    };
    Layer.prototype.findChildRefIds = function(dataId) {
        var fromParent = this.parent.findChildRefIds(dataId);
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(this.data, dataId) ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, fromParent), _super.prototype.findChildRefIds.call(this, dataId)) : fromParent;
    };
    Layer.prototype.getStorage = function() {
        var p = this.parent;
        while(p.parent)p = p.parent;
        return p.getStorage.apply(p, // @ts-expect-error
        arguments);
    };
    return Layer;
}(EntityStore);
// Represents a Layer permanently installed just above the Root, which allows
// reading optimistically (and registering optimistic dependencies) even when
// no optimistic layers are currently active. The stump.group CacheGroup object
// is shared by any/all Layer objects added on top of the Stump.
var Stump = function(_super) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__extends"])(Stump, _super);
    function Stump(root) {
        return _super.call(this, "EntityStore.Stump", root, function() {}, new CacheGroup(root.group.caching, root.group)) || this;
    }
    Stump.prototype.removeLayer = function() {
        // Never remove the Stump layer.
        return this;
    };
    Stump.prototype.merge = function(older, newer) {
        // We never want to write any data into the Stump, so we forward any merge
        // calls to the Root instead. Another option here would be to throw an
        // exception, but the toReference(object, true) function can sometimes
        // trigger Stump writes (which used to be Root writes, before the Stump
        // concept was introduced).
        return this.parent.merge(older, newer);
    };
    return Stump;
}(Layer);
function storeObjectReconciler(existingObject, incomingObject, property) {
    var existingValue = existingObject[property];
    var incomingValue = incomingObject[property];
    // Wherever there is a key collision, prefer the incoming value, unless
    // it is deeply equal to the existing value. It's worth checking deep
    // equality here (even though blindly returning incoming would be
    // logically correct) because preserving the referential identity of
    // existing data can prevent needless rereading and rerendering.
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["equal"])(existingValue, incomingValue) ? existingValue : incomingValue;
}
function supportsResultCaching(store) {
    // When result caching is disabled, store.depend will be null.
    return !!(store instanceof EntityStore && store.group.caching);
} //# sourceMappingURL=entityStore.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/object-canon.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "ObjectCanon": ()=>ObjectCanon
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$trie$40$0$2e$5$2e$0$2f$node_modules$2f40$wry$2f$trie$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+trie@0.5.0/node_modules/@wry/trie/lib/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/objects.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/arrays.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
function shallowCopy(value) {
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(value)) {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(value) ? value.slice(0) : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({
            __proto__: Object.getPrototypeOf(value)
        }, value);
    }
    return value;
}
// When programmers talk about the "canonical form" of an object, they
// usually have the following meaning in mind, which I've copied from
// https://en.wiktionary.org/wiki/canonical_form:
//
// 1. A standard or normal presentation of a mathematical entity [or
//    object]. A canonical form is an element of a set of representatives
//    of equivalence classes of forms such that there is a function or
//    procedure which projects every element of each equivalence class
//    onto that one element, the canonical form of that equivalence
//    class. The canonical form is expected to be simpler than the rest of
//    the forms in some way.
//
// That's a long-winded way of saying any two objects that have the same
// canonical form may be considered equivalent, even if they are !==,
// which usually means the objects are structurally equivalent (deeply
// equal), but don't necessarily use the same memory.
//
// Like a literary or musical canon, this ObjectCanon class represents a
// collection of unique canonical items (JavaScript objects), with the
// important property that canon.admit(a) === canon.admit(b) if a and b
// are deeply equal to each other. In terms of the definition above, the
// canon.admit method is the "function or procedure which projects every"
// object "onto that one element, the canonical form."
//
// In the worst case, the canonicalization process may involve looking at
// every property in the provided object tree, so it takes the same order
// of time as deep equality checking. Fortunately, already-canonicalized
// objects are returned immediately from canon.admit, so the presence of
// canonical subtrees tends to speed up canonicalization.
//
// Since consumers of canonical objects can check for deep equality in
// constant time, canonicalizing cache results can massively improve the
// performance of application code that skips re-rendering unchanged
// results, such as "pure" UI components in a framework like React.
//
// Of course, since canonical objects may be shared widely between
// unrelated consumers, it's important to think of them as immutable, even
// though they are not actually frozen with Object.freeze in production,
// due to the extra performance overhead that comes with frozen objects.
//
// Custom scalar objects whose internal class name is neither Array nor
// Object can be included safely in the admitted tree, but they will not
// be replaced with a canonical version (to put it another way, they are
// assumed to be canonical already).
//
// If we ignore custom objects, no detection of cycles or repeated object
// references is currently required by the StoreReader class, since
// GraphQL result objects are JSON-serializable trees (and thus contain
// neither cycles nor repeated subtrees), so we can avoid the complexity
// of keeping track of objects we've already seen during the recursion of
// the admit method.
//
// In the future, we may consider adding additional cases to the switch
// statement to handle other common object types, such as "[object Date]"
// objects, as needed.
var ObjectCanon = function() {
    function ObjectCanon() {
        // Set of all canonical objects this ObjectCanon has admitted, allowing
        // canon.admit to return previously-canonicalized objects immediately.
        this.known = new (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseWeakSet"] ? WeakSet : Set)();
        // Efficient storage/lookup structure for canonical objects.
        this.pool = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$trie$40$0$2e$5$2e$0$2f$node_modules$2f40$wry$2f$trie$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Trie"](__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseWeakMap"]);
        // Make the ObjectCanon assume this value has already been
        // canonicalized.
        this.passes = new WeakMap();
        // Arrays that contain the same elements in a different order can share
        // the same SortedKeysInfo object, to save memory.
        this.keysByJSON = new Map();
        // This has to come last because it depends on keysByJSON.
        this.empty = this.admit({});
    }
    ObjectCanon.prototype.isKnown = function(value) {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(value) && this.known.has(value);
    };
    ObjectCanon.prototype.pass = function(value) {
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(value)) {
            var copy = shallowCopy(value);
            this.passes.set(copy, value);
            return copy;
        }
        return value;
    };
    ObjectCanon.prototype.admit = function(value) {
        var _this = this;
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(value)) {
            var original = this.passes.get(value);
            if (original) return original;
            var proto = Object.getPrototypeOf(value);
            switch(proto){
                case Array.prototype:
                    {
                        if (this.known.has(value)) return value;
                        var array = value.map(this.admit, this);
                        // Arrays are looked up in the Trie using their recursively
                        // canonicalized elements, and the known version of the array is
                        // preserved as node.array.
                        var node = this.pool.lookupArray(array);
                        if (!node.array) {
                            this.known.add(node.array = array);
                            // Since canonical arrays may be shared widely between
                            // unrelated consumers, it's important to regard them as
                            // immutable, even if they are not frozen in production.
                            if (globalThis.__DEV__ !== false) {
                                Object.freeze(array);
                            }
                        }
                        return node.array;
                    }
                case null:
                case Object.prototype:
                    {
                        if (this.known.has(value)) return value;
                        var proto_1 = Object.getPrototypeOf(value);
                        var array_1 = [
                            proto_1
                        ];
                        var keys = this.sortedKeys(value);
                        array_1.push(keys.json);
                        var firstValueIndex_1 = array_1.length;
                        keys.sorted.forEach(function(key) {
                            array_1.push(_this.admit(value[key]));
                        });
                        // Objects are looked up in the Trie by their prototype (which
                        // is *not* recursively canonicalized), followed by a JSON
                        // representation of their (sorted) keys, followed by the
                        // sequence of recursively canonicalized values corresponding to
                        // those keys. To keep the final results unambiguous with other
                        // sequences (such as arrays that just happen to contain [proto,
                        // keys.json, value1, value2, ...]), the known version of the
                        // object is stored as node.object.
                        var node = this.pool.lookupArray(array_1);
                        if (!node.object) {
                            var obj_1 = node.object = Object.create(proto_1);
                            this.known.add(obj_1);
                            keys.sorted.forEach(function(key, i) {
                                obj_1[key] = array_1[firstValueIndex_1 + i];
                            });
                            // Since canonical objects may be shared widely between
                            // unrelated consumers, it's important to regard them as
                            // immutable, even if they are not frozen in production.
                            if (globalThis.__DEV__ !== false) {
                                Object.freeze(obj_1);
                            }
                        }
                        return node.object;
                    }
            }
        }
        return value;
    };
    // It's worthwhile to cache the sorting of arrays of strings, since the
    // same initial unsorted arrays tend to be encountered many times.
    // Fortunately, we can reuse the Trie machinery to look up the sorted
    // arrays in linear time (which is faster than sorting large arrays).
    ObjectCanon.prototype.sortedKeys = function(obj) {
        var keys = Object.keys(obj);
        var node = this.pool.lookupArray(keys);
        if (!node.keys) {
            keys.sort();
            var json = JSON.stringify(keys);
            if (!(node.keys = this.keysByJSON.get(json))) {
                this.keysByJSON.set(json, node.keys = {
                    sorted: keys,
                    json: json
                });
            }
        }
        return node.keys;
    };
    return ObjectCanon;
}();
;
 //# sourceMappingURL=object-canon.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/readFromStore.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "StoreReader": ()=>StoreReader
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/graphql@16.12.0/node_modules/graphql/language/kinds.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/storeUtils.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/directives.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$transform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/transform.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/getFromAST.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/fragments.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$maybeDeepFreeze$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/maybeDeepFreeze.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/mergeDeep.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/objects.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canUse.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$compact$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/compact.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canonicalStringify$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canonicalStringify.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$sizes$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/caching/sizes.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/entityStore.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/arrays.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/helpers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$core$2f$types$2f$common$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/core/types/common.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$object$2d$canon$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/object-canon.js [app-client] (ecmascript)");
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
function execSelectionSetKeyArgs(options) {
    return [
        options.selectionSet,
        options.objectOrReference,
        options.context,
        // We split out this property so we can pass different values
        // independently without modifying options.context itself.
        options.context.canonizeResults
    ];
}
var StoreReader = function() {
    function StoreReader(config) {
        var _this = this;
        this.knownResults = new (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canUse$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canUseWeakMap"] ? WeakMap : Map)();
        this.config = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$compact$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["compact"])(config, {
            addTypename: config.addTypename !== false,
            canonizeResults: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["shouldCanonizeResults"])(config)
        });
        this.canon = config.canon || new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$object$2d$canon$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ObjectCanon"]();
        // memoized functions in this class will be "garbage-collected"
        // by recreating the whole `StoreReader` in
        // `InMemoryCache.resetResultsCache`
        // (triggered from `InMemoryCache.gc` with `resetResultCache: true`)
        this.executeSelectionSet = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["wrap"])(function(options) {
            var _a;
            var canonizeResults = options.context.canonizeResults;
            var peekArgs = execSelectionSetKeyArgs(options);
            // Negate this boolean option so we can find out if we've already read
            // this result using the other boolean value.
            peekArgs[3] = !canonizeResults;
            var other = (_a = _this.executeSelectionSet).peek.apply(_a, peekArgs);
            if (other) {
                if (canonizeResults) {
                    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, other), {
                        // If we previously read this result without canonizing it, we can
                        // reuse that result simply by canonizing it now.
                        result: _this.canon.admit(other.result)
                    });
                }
                // If we previously read this result with canonization enabled, we can
                // return that canonized result as-is.
                return other;
            }
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["maybeDependOnExistenceOfEntity"])(options.context.store, options.enclosingRef.__ref);
            // Finally, if we didn't find any useful previous results, run the real
            // execSelectionSetImpl method with the given options.
            return _this.execSelectionSetImpl(options);
        }, {
            max: this.config.resultCacheMaxSize || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$sizes$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cacheSizes"]["inMemoryCache.executeSelectionSet"] || 50000 /* defaultCacheSizes["inMemoryCache.executeSelectionSet"] */ ,
            keyArgs: execSelectionSetKeyArgs,
            // Note that the parameters of makeCacheKey are determined by the
            // array returned by keyArgs.
            makeCacheKey: function(selectionSet, parent, context, canonizeResults) {
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supportsResultCaching"])(context.store)) {
                    return context.store.makeCacheKey(selectionSet, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(parent) ? parent.__ref : parent, context.varString, canonizeResults);
                }
            }
        });
        this.executeSubSelectedArray = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["wrap"])(function(options) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["maybeDependOnExistenceOfEntity"])(options.context.store, options.enclosingRef.__ref);
            return _this.execSubSelectedArrayImpl(options);
        }, {
            max: this.config.resultCacheMaxSize || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$sizes$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cacheSizes"]["inMemoryCache.executeSubSelectedArray"] || 10000 /* defaultCacheSizes["inMemoryCache.executeSubSelectedArray"] */ ,
            makeCacheKey: function(_a) {
                var field = _a.field, array = _a.array, context = _a.context;
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supportsResultCaching"])(context.store)) {
                    return context.store.makeCacheKey(field, array, context.varString);
                }
            }
        });
    }
    StoreReader.prototype.resetCanon = function() {
        this.canon = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$object$2d$canon$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ObjectCanon"]();
    };
    /**
     * Given a store and a query, return as much of the result as possible and
     * identify if any data was missing from the store.
     */ StoreReader.prototype.diffQueryAgainstStore = function(_a) {
        var store = _a.store, query = _a.query, _b = _a.rootId, rootId = _b === void 0 ? "ROOT_QUERY" : _b, variables = _a.variables, _c = _a.returnPartialData, returnPartialData = _c === void 0 ? true : _c, _d = _a.canonizeResults, canonizeResults = _d === void 0 ? this.config.canonizeResults : _d;
        var policies = this.config.cache.policies;
        variables = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getDefaultValues"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getQueryDefinition"])(query))), variables);
        var rootRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["makeReference"])(rootId);
        var execResult = this.executeSelectionSet({
            selectionSet: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getMainDefinition"])(query).selectionSet,
            objectOrReference: rootRef,
            enclosingRef: rootRef,
            context: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({
                store: store,
                query: query,
                policies: policies,
                variables: variables,
                varString: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canonicalStringify$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canonicalStringify"])(variables),
                canonizeResults: canonizeResults
            }, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["extractFragmentContext"])(query, this.config.fragments))
        });
        var missing;
        if (execResult.missing) {
            // For backwards compatibility we still report an array of
            // MissingFieldError objects, even though there will only ever be at most
            // one of them, now that all missing field error messages are grouped
            // together in the execResult.missing tree.
            missing = [
                new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$core$2f$types$2f$common$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["MissingFieldError"](firstMissing(execResult.missing), execResult.missing, query, variables)
            ];
            if (!returnPartialData) {
                throw missing[0];
            }
        }
        return {
            result: execResult.result,
            complete: !missing,
            missing: missing
        };
    };
    StoreReader.prototype.isFresh = function(result, parent, selectionSet, context) {
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supportsResultCaching"])(context.store) && this.knownResults.get(result) === selectionSet) {
            var latest = this.executeSelectionSet.peek(selectionSet, parent, context, // If result is canonical, then it could only have been previously
            // cached by the canonizing version of executeSelectionSet, so we can
            // avoid checking both possibilities here.
            this.canon.isKnown(result));
            if (latest && result === latest.result) {
                return true;
            }
        }
        return false;
    };
    // Uncached version of executeSelectionSet.
    StoreReader.prototype.execSelectionSetImpl = function(_a) {
        var _this = this;
        var selectionSet = _a.selectionSet, objectOrReference = _a.objectOrReference, enclosingRef = _a.enclosingRef, context = _a.context;
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(objectOrReference) && !context.policies.rootTypenamesById[objectOrReference.__ref] && !context.store.has(objectOrReference.__ref)) {
            return {
                result: this.canon.empty,
                missing: "Dangling reference to missing ".concat(objectOrReference.__ref, " object")
            };
        }
        var variables = context.variables, policies = context.policies, store = context.store;
        var typename = store.getFieldValue(objectOrReference, "__typename");
        var objectsToMerge = [];
        var missing;
        var missingMerger = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["DeepMerger"]();
        if (this.config.addTypename && typeof typename === "string" && !policies.rootIdsByTypename[typename]) {
            // Ensure we always include a default value for the __typename
            // field, if we have one, and this.config.addTypename is true. Note
            // that this field can be overridden by other merged objects.
            objectsToMerge.push({
                __typename: typename
            });
        }
        function handleMissing(result, resultName) {
            var _a;
            if (result.missing) {
                missing = missingMerger.merge(missing, (_a = {}, _a[resultName] = result.missing, _a));
            }
            return result.result;
        }
        var workSet = new Set(selectionSet.selections);
        workSet.forEach(function(selection) {
            var _a, _b;
            // Omit fields with directives @skip(if: <truthy value>) or
            // @include(if: <falsy value>).
            if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["shouldInclude"])(selection, variables)) return;
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isField"])(selection)) {
                var fieldValue = policies.readField({
                    fieldName: selection.name.value,
                    field: selection,
                    variables: context.variables,
                    from: objectOrReference
                }, context);
                var resultName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["resultKeyNameFromField"])(selection);
                if (fieldValue === void 0) {
                    if (!__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$transform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["addTypenameToDocument"].added(selection)) {
                        missing = missingMerger.merge(missing, (_a = {}, _a[resultName] = "Can't find field '".concat(selection.name.value, "' on ").concat((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(objectOrReference) ? objectOrReference.__ref + " object" : "object " + JSON.stringify(objectOrReference, null, 2)), _a));
                    }
                } else if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(fieldValue)) {
                    if (fieldValue.length > 0) {
                        fieldValue = handleMissing(_this.executeSubSelectedArray({
                            field: selection,
                            array: fieldValue,
                            enclosingRef: enclosingRef,
                            context: context
                        }), resultName);
                    }
                } else if (!selection.selectionSet) {
                    // If the field does not have a selection set, then we handle it
                    // as a scalar value. To keep this.canon from canonicalizing
                    // this value, we use this.canon.pass to wrap fieldValue in a
                    // Pass object that this.canon.admit will later unwrap as-is.
                    if (context.canonizeResults) {
                        fieldValue = _this.canon.pass(fieldValue);
                    }
                } else if (fieldValue != null) {
                    // In this case, because we know the field has a selection set,
                    // it must be trying to query a GraphQLObjectType, which is why
                    // fieldValue must be != null.
                    fieldValue = handleMissing(_this.executeSelectionSet({
                        selectionSet: selection.selectionSet,
                        objectOrReference: fieldValue,
                        enclosingRef: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(fieldValue) ? fieldValue : enclosingRef,
                        context: context
                    }), resultName);
                }
                if (fieldValue !== void 0) {
                    objectsToMerge.push((_b = {}, _b[resultName] = fieldValue, _b));
                }
            } else {
                var fragment = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getFragmentFromSelection"])(selection, context.lookupFragment);
                if (!fragment && selection.kind === __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Kind"].FRAGMENT_SPREAD) {
                    throw (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["newInvariantError"])(10, selection.name.value);
                }
                if (fragment && policies.fragmentMatches(fragment, typename)) {
                    fragment.selectionSet.selections.forEach(workSet.add, workSet);
                }
            }
        });
        var result = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["mergeDeepArray"])(objectsToMerge);
        var finalResult = {
            result: result,
            missing: missing
        };
        var frozen = context.canonizeResults ? this.canon.admit(finalResult) : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$maybeDeepFreeze$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["maybeDeepFreeze"])(finalResult);
        // Store this result with its selection set so that we can quickly
        // recognize it again in the StoreReader#isFresh method.
        if (frozen.result) {
            this.knownResults.set(frozen.result, selectionSet);
        }
        return frozen;
    };
    // Uncached version of executeSubSelectedArray.
    StoreReader.prototype.execSubSelectedArrayImpl = function(_a) {
        var _this = this;
        var field = _a.field, array = _a.array, enclosingRef = _a.enclosingRef, context = _a.context;
        var missing;
        var missingMerger = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["DeepMerger"]();
        function handleMissing(childResult, i) {
            var _a;
            if (childResult.missing) {
                missing = missingMerger.merge(missing, (_a = {}, _a[i] = childResult.missing, _a));
            }
            return childResult.result;
        }
        if (field.selectionSet) {
            array = array.filter(context.store.canRead);
        }
        array = array.map(function(item, i) {
            // null value in array
            if (item === null) {
                return null;
            }
            // This is a nested array, recurse
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(item)) {
                return handleMissing(_this.executeSubSelectedArray({
                    field: field,
                    array: item,
                    enclosingRef: enclosingRef,
                    context: context
                }), i);
            }
            // This is an object, run the selection set on it
            if (field.selectionSet) {
                return handleMissing(_this.executeSelectionSet({
                    selectionSet: field.selectionSet,
                    objectOrReference: item,
                    enclosingRef: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(item) ? item : enclosingRef,
                    context: context
                }), i);
            }
            if (globalThis.__DEV__ !== false) {
                assertSelectionSetForIdValue(context.store, field, item);
            }
            return item;
        });
        return {
            result: context.canonizeResults ? this.canon.admit(array) : array,
            missing: missing
        };
    };
    return StoreReader;
}();
;
function firstMissing(tree) {
    try {
        JSON.stringify(tree, function(_, value) {
            if (typeof value === "string") throw value;
            return value;
        });
    } catch (result) {
        return result;
    }
}
function assertSelectionSetForIdValue(store, field, fieldValue) {
    if (!field.selectionSet) {
        var workSet_1 = new Set([
            fieldValue
        ]);
        workSet_1.forEach(function(value) {
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(value)) {
                (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(!(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(value), 11, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["getTypenameFromStoreObject"])(store, value), field.name.value);
                Object.values(value).forEach(workSet_1.add, workSet_1);
            }
        });
    }
} //# sourceMappingURL=readFromStore.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/key-extractor.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "collectSpecifierPaths": ()=>collectSpecifierPaths,
    "extractKeyPath": ()=>extractKeyPath,
    "getSpecifierPaths": ()=>getSpecifierPaths,
    "keyArgsFnFromSpecifier": ()=>keyArgsFnFromSpecifier,
    "keyFieldsFnFromSpecifier": ()=>keyFieldsFnFromSpecifier
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/storeUtils.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/mergeDeep.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/arrays.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/objects.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/helpers.js [app-client] (ecmascript) <locals>");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
// Mapping from JSON-encoded KeySpecifier strings to associated information.
var specifierInfoCache = Object.create(null);
function lookupSpecifierInfo(spec) {
    // It's safe to encode KeySpecifier arrays with JSON.stringify, since they're
    // just arrays of strings or nested KeySpecifier arrays, and the order of the
    // array elements is important (and suitably preserved by JSON.stringify).
    var cacheKey = JSON.stringify(spec);
    return specifierInfoCache[cacheKey] || (specifierInfoCache[cacheKey] = Object.create(null));
}
function keyFieldsFnFromSpecifier(specifier) {
    var info = lookupSpecifierInfo(specifier);
    return info.keyFieldsFn || (info.keyFieldsFn = function(object, context) {
        var extract = function(from, key) {
            return context.readField(key, from);
        };
        var keyObject = context.keyObject = collectSpecifierPaths(specifier, function(schemaKeyPath) {
            var extracted = extractKeyPath(context.storeObject, schemaKeyPath, // Using context.readField to extract paths from context.storeObject
            // allows the extraction to see through Reference objects and respect
            // custom read functions.
            extract);
            if (extracted === void 0 && object !== context.storeObject && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(object, schemaKeyPath[0])) {
                // If context.storeObject fails to provide a value for the requested
                // path, fall back to the raw result object, if it has a top-level key
                // matching the first key in the path (schemaKeyPath[0]). This allows
                // key fields included in the written data to be saved in the cache
                // even if they are not selected explicitly in context.selectionSet.
                // Not being mentioned by context.selectionSet is convenient here,
                // since it means these extra fields cannot be affected by field
                // aliasing, which is why we can use extractKey instead of
                // context.readField for this extraction.
                extracted = extractKeyPath(object, schemaKeyPath, extractKey);
            }
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(extracted !== void 0, 5, schemaKeyPath.join("."), object);
            return extracted;
        });
        return "".concat(context.typename, ":").concat(JSON.stringify(keyObject));
    });
}
function keyArgsFnFromSpecifier(specifier) {
    var info = lookupSpecifierInfo(specifier);
    return info.keyArgsFn || (info.keyArgsFn = function(args, _a) {
        var field = _a.field, variables = _a.variables, fieldName = _a.fieldName;
        var collected = collectSpecifierPaths(specifier, function(keyPath) {
            var firstKey = keyPath[0];
            var firstChar = firstKey.charAt(0);
            if (firstChar === "@") {
                if (field && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonEmptyArray"])(field.directives)) {
                    var directiveName_1 = firstKey.slice(1);
                    // If the directive appears multiple times, only the first
                    // occurrence's arguments will be used. TODO Allow repetition?
                    // TODO Cache this work somehow, a la aliasMap?
                    var d = field.directives.find(function(d) {
                        return d.name.value === directiveName_1;
                    });
                    // Fortunately argumentsObjectFromField works for DirectiveNode!
                    var directiveArgs = d && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["argumentsObjectFromField"])(d, variables);
                    // For directives without arguments (d defined, but directiveArgs ===
                    // null), the presence or absence of the directive still counts as
                    // part of the field key, so we return null in those cases. If no
                    // directive with this name was found for this field (d undefined and
                    // thus directiveArgs undefined), we return undefined, which causes
                    // this value to be omitted from the key object returned by
                    // collectSpecifierPaths.
                    return directiveArgs && extractKeyPath(directiveArgs, // If keyPath.length === 1, this code calls extractKeyPath with an
                    // empty path, which works because it uses directiveArgs as the
                    // extracted value.
                    keyPath.slice(1));
                }
                // If the key started with @ but there was no corresponding directive,
                // we want to omit this value from the key object, not fall through to
                // treating @whatever as a normal argument name.
                return;
            }
            if (firstChar === "$") {
                var variableName = firstKey.slice(1);
                if (variables && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(variables, variableName)) {
                    var varKeyPath = keyPath.slice(0);
                    varKeyPath[0] = variableName;
                    return extractKeyPath(variables, varKeyPath);
                }
                // If the key started with $ but there was no corresponding variable, we
                // want to omit this value from the key object, not fall through to
                // treating $whatever as a normal argument name.
                return;
            }
            if (args) {
                return extractKeyPath(args, keyPath);
            }
        });
        var suffix = JSON.stringify(collected);
        // If no arguments were passed to this field, and it didn't have any other
        // field key contributions from directives or variables, hide the empty
        // :{} suffix from the field key. However, a field passed no arguments can
        // still end up with a non-empty :{...} suffix if its key configuration
        // refers to directives or variables.
        if (args || suffix !== "{}") {
            fieldName += ":" + suffix;
        }
        return fieldName;
    });
}
function collectSpecifierPaths(specifier, extractor) {
    // For each path specified by specifier, invoke the extractor, and repeatedly
    // merge the results together, with appropriate ancestor context.
    var merger = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$mergeDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["DeepMerger"]();
    return getSpecifierPaths(specifier).reduce(function(collected, path) {
        var _a;
        var toMerge = extractor(path);
        if (toMerge !== void 0) {
            // This path is not expected to contain array indexes, so the toMerge
            // reconstruction will not contain arrays. TODO Fix this?
            for(var i = path.length - 1; i >= 0; --i){
                toMerge = (_a = {}, _a[path[i]] = toMerge, _a);
            }
            collected = merger.merge(collected, toMerge);
        }
        return collected;
    }, Object.create(null));
}
function getSpecifierPaths(spec) {
    var info = lookupSpecifierInfo(spec);
    if (!info.paths) {
        var paths_1 = info.paths = [];
        var currentPath_1 = [];
        spec.forEach(function(s, i) {
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(s)) {
                getSpecifierPaths(s).forEach(function(p) {
                    return paths_1.push(currentPath_1.concat(p));
                });
                currentPath_1.length = 0;
            } else {
                currentPath_1.push(s);
                if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(spec[i + 1])) {
                    paths_1.push(currentPath_1.slice(0));
                    currentPath_1.length = 0;
                }
            }
        });
    }
    return info.paths;
}
function extractKey(object, key) {
    return object[key];
}
function extractKeyPath(object, path, extract) {
    // For each key in path, extract the corresponding child property from obj,
    // flattening arrays if encountered (uncommon for keyFields and keyArgs, but
    // possible). The final result of path.reduce is normalized so unexpected leaf
    // objects have their keys safely sorted. That final result is difficult to
    // type as anything other than any. You're welcome to try to improve the
    // return type, but keep in mind extractKeyPath is not a public function
    // (exported only for testing), so the effort may not be worthwhile unless the
    // limited set of actual callers (see above) pass arguments that TypeScript
    // can statically type. If we know only that path is some array of strings
    // (and not, say, a specific tuple of statically known strings), any (or
    // possibly unknown) is the honest answer.
    extract = extract || extractKey;
    return normalize(path.reduce(function reducer(obj, key) {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(obj) ? obj.map(function(child) {
            return reducer(child, key);
        }) : obj && extract(obj, key);
    }, object));
}
function normalize(value) {
    // Usually the extracted value will be a scalar value, since most primary
    // key fields are scalar, but just in case we get an object or an array, we
    // need to do some normalization of the order of (nested) keys.
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(value)) {
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(value)) {
            return value.map(normalize);
        }
        return collectSpecifierPaths(Object.keys(value).sort(), function(path) {
            return extractKeyPath(value, path);
        });
    }
    return value;
} //# sourceMappingURL=key-extractor.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/policies.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "Policies": ()=>Policies,
    "normalizeReadFieldOptions": ()=>normalizeReadFieldOptions
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/storeUtils.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/objects.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$stringifyForDisplay$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/stringifyForDisplay.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/helpers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/arrays.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$reactiveVars$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/reactiveVars.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$key$2d$extractor$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/key-extractor.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/masking/utils.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
;
;
function argsFromFieldSpecifier(spec) {
    return spec.args !== void 0 ? spec.args : spec.field ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["argumentsObjectFromField"])(spec.field, spec.variables) : null;
}
var nullKeyFieldsFn = function() {
    return void 0;
};
var simpleKeyArgsFn = function(_args, context) {
    return context.fieldName;
};
// These merge functions can be selected by specifying merge:true or
// merge:false in a field policy.
var mergeTrueFn = function(existing, incoming, _a) {
    var mergeObjects = _a.mergeObjects;
    return mergeObjects(existing, incoming);
};
var mergeFalseFn = function(_, incoming) {
    return incoming;
};
var Policies = function() {
    function Policies(config) {
        this.config = config;
        this.typePolicies = Object.create(null);
        this.toBeAdded = Object.create(null);
        // Map from subtype names to sets of supertype names. Note that this
        // representation inverts the structure of possibleTypes (whose keys are
        // supertypes and whose values are arrays of subtypes) because it tends
        // to be much more efficient to search upwards than downwards.
        this.supertypeMap = new Map();
        // Any fuzzy subtypes specified by possibleTypes will be converted to
        // RegExp objects and recorded here. Every key of this map can also be
        // found in supertypeMap. In many cases this Map will be empty, which
        // means no fuzzy subtype checking will happen in fragmentMatches.
        this.fuzzySubtypes = new Map();
        this.rootIdsByTypename = Object.create(null);
        this.rootTypenamesById = Object.create(null);
        this.usingPossibleTypes = false;
        this.config = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({
            dataIdFromObject: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["defaultDataIdFromObject"]
        }, config);
        this.cache = this.config.cache;
        this.setRootTypename("Query");
        this.setRootTypename("Mutation");
        this.setRootTypename("Subscription");
        if (config.possibleTypes) {
            this.addPossibleTypes(config.possibleTypes);
        }
        if (config.typePolicies) {
            this.addTypePolicies(config.typePolicies);
        }
    }
    Policies.prototype.identify = function(object, partialContext) {
        var _a;
        var policies = this;
        var typename = partialContext && (partialContext.typename || ((_a = partialContext.storeObject) === null || _a === void 0 ? void 0 : _a.__typename)) || object.__typename;
        // It should be possible to write root Query fields with writeFragment,
        // using { __typename: "Query", ... } as the data, but it does not make
        // sense to allow the same identification behavior for the Mutation and
        // Subscription types, since application code should never be writing
        // directly to (or reading directly from) those root objects.
        if (typename === this.rootTypenamesById.ROOT_QUERY) {
            return [
                "ROOT_QUERY"
            ];
        }
        // Default context.storeObject to object if not otherwise provided.
        var storeObject = partialContext && partialContext.storeObject || object;
        var context = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, partialContext), {
            typename: typename,
            storeObject: storeObject,
            readField: partialContext && partialContext.readField || function() {
                var options = normalizeReadFieldOptions(arguments, storeObject);
                return policies.readField(options, {
                    store: policies.cache["data"],
                    variables: options.variables
                });
            }
        });
        var id;
        var policy = typename && this.getTypePolicy(typename);
        var keyFn = policy && policy.keyFn || this.config.dataIdFromObject;
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$masking$2f$utils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["disableWarningsSlot"].withValue(true, function() {
            while(keyFn){
                var specifierOrId = keyFn((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, object), storeObject), context);
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(specifierOrId)) {
                    keyFn = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$key$2d$extractor$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["keyFieldsFnFromSpecifier"])(specifierOrId);
                } else {
                    id = specifierOrId;
                    break;
                }
            }
        });
        id = id ? String(id) : void 0;
        return context.keyObject ? [
            id,
            context.keyObject
        ] : [
            id
        ];
    };
    Policies.prototype.addTypePolicies = function(typePolicies) {
        var _this = this;
        Object.keys(typePolicies).forEach(function(typename) {
            var _a = typePolicies[typename], queryType = _a.queryType, mutationType = _a.mutationType, subscriptionType = _a.subscriptionType, incoming = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__rest"])(_a, [
                "queryType",
                "mutationType",
                "subscriptionType"
            ]);
            // Though {query,mutation,subscription}Type configurations are rare,
            // it's important to call setRootTypename as early as possible,
            // since these configurations should apply consistently for the
            // entire lifetime of the cache. Also, since only one __typename can
            // qualify as one of these root types, these three properties cannot
            // be inherited, unlike the rest of the incoming properties. That
            // restriction is convenient, because the purpose of this.toBeAdded
            // is to delay the processing of type/field policies until the first
            // time they're used, allowing policies to be added in any order as
            // long as all relevant policies (including policies for supertypes)
            // have been added by the time a given policy is used for the first
            // time. In other words, since inheritance doesn't matter for these
            // properties, there's also no need to delay their processing using
            // the this.toBeAdded queue.
            if (queryType) _this.setRootTypename("Query", typename);
            if (mutationType) _this.setRootTypename("Mutation", typename);
            if (subscriptionType) _this.setRootTypename("Subscription", typename);
            if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(_this.toBeAdded, typename)) {
                _this.toBeAdded[typename].push(incoming);
            } else {
                _this.toBeAdded[typename] = [
                    incoming
                ];
            }
        });
    };
    Policies.prototype.updateTypePolicy = function(typename, incoming, existingFieldPolicies) {
        var existing = this.getTypePolicy(typename);
        var keyFields = incoming.keyFields, fields = incoming.fields;
        function setMerge(existing, merge) {
            existing.merge = typeof merge === "function" ? merge : merge === true ? mergeTrueFn : merge === false ? mergeFalseFn : existing.merge;
        }
        // Type policies can define merge functions, as an alternative to
        // using field policies to merge child objects.
        setMerge(existing, incoming.merge);
        existing.keyFn = // Pass false to disable normalization for this typename.
        keyFields === false ? nullKeyFieldsFn : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(keyFields) ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$key$2d$extractor$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["keyFieldsFnFromSpecifier"])(keyFields) : typeof keyFields === "function" ? keyFields : existing.keyFn;
        if (fields) {
            Object.keys(fields).forEach(function(fieldName) {
                var existing = existingFieldPolicies[fieldName];
                // Field policy inheritance is atomic/shallow: you can't inherit a
                // field policy and then override just its read function, since read
                // and merge functions often need to cooperate, so changing only one
                // of them would be a recipe for inconsistency.
                // So here we avoid merging an inherited field policy with an updated one.
                if (!existing || (existing === null || existing === void 0 ? void 0 : existing.typename) !== typename) {
                    existing = existingFieldPolicies[fieldName] = {
                        typename: typename
                    };
                }
                var incoming = fields[fieldName];
                if (typeof incoming === "function") {
                    existing.read = incoming;
                } else {
                    var keyArgs = incoming.keyArgs, read = incoming.read, merge = incoming.merge;
                    existing.keyFn = // Pass false to disable argument-based differentiation of
                    // field identities.
                    keyArgs === false ? simpleKeyArgsFn : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(keyArgs) ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$key$2d$extractor$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["keyArgsFnFromSpecifier"])(keyArgs) : typeof keyArgs === "function" ? keyArgs : existing.keyFn;
                    if (typeof read === "function") {
                        existing.read = read;
                    }
                    setMerge(existing, merge);
                }
                if (existing.read && existing.merge) {
                    // If we have both a read and a merge function, assume
                    // keyArgs:false, because read and merge together can take
                    // responsibility for interpreting arguments in and out. This
                    // default assumption can always be overridden by specifying
                    // keyArgs explicitly in the FieldPolicy.
                    existing.keyFn = existing.keyFn || simpleKeyArgsFn;
                }
            });
        }
    };
    Policies.prototype.setRootTypename = function(which, typename) {
        if (typename === void 0) {
            typename = which;
        }
        var rootId = "ROOT_" + which.toUpperCase();
        var old = this.rootTypenamesById[rootId];
        if (typename !== old) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(!old || old === which, 6, which);
            // First, delete any old __typename associated with this rootId from
            // rootIdsByTypename.
            if (old) delete this.rootIdsByTypename[old];
            // Now make this the only __typename that maps to this rootId.
            this.rootIdsByTypename[typename] = rootId;
            // Finally, update the __typename associated with this rootId.
            this.rootTypenamesById[rootId] = typename;
        }
    };
    Policies.prototype.addPossibleTypes = function(possibleTypes) {
        var _this = this;
        this.usingPossibleTypes = true;
        Object.keys(possibleTypes).forEach(function(supertype) {
            // Make sure all types have an entry in this.supertypeMap, even if
            // their supertype set is empty, so we can return false immediately
            // from policies.fragmentMatches for unknown supertypes.
            _this.getSupertypeSet(supertype, true);
            possibleTypes[supertype].forEach(function(subtype) {
                _this.getSupertypeSet(subtype, true).add(supertype);
                var match = subtype.match(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["TypeOrFieldNameRegExp"]);
                if (!match || match[0] !== subtype) {
                    // TODO Don't interpret just any invalid typename as a RegExp.
                    _this.fuzzySubtypes.set(subtype, new RegExp(subtype));
                }
            });
        });
    };
    Policies.prototype.getTypePolicy = function(typename) {
        var _this = this;
        if (!__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(this.typePolicies, typename)) {
            var policy_1 = this.typePolicies[typename] = Object.create(null);
            policy_1.fields = Object.create(null);
            // When the TypePolicy for typename is first accessed, instead of
            // starting with an empty policy object, inherit any properties or
            // fields from the type policies of the supertypes of typename.
            //
            // Any properties or fields defined explicitly within the TypePolicy
            // for typename will take precedence, and if there are multiple
            // supertypes, the properties of policies whose types were added
            // later via addPossibleTypes will take precedence over those of
            // earlier supertypes. TODO Perhaps we should warn about these
            // conflicts in development, and recommend defining the property
            // explicitly in the subtype policy?
            //
            // Field policy inheritance is atomic/shallow: you can't inherit a
            // field policy and then override just its read function, since read
            // and merge functions often need to cooperate, so changing only one
            // of them would be a recipe for inconsistency.
            //
            // Once the TypePolicy for typename has been accessed, its properties can
            // still be updated directly using addTypePolicies, but future changes to
            // inherited supertype policies will not be reflected in this subtype
            // policy, because this code runs at most once per typename.
            var supertypes_1 = this.supertypeMap.get(typename);
            if (!supertypes_1 && this.fuzzySubtypes.size) {
                // To make the inheritance logic work for unknown typename strings that
                // may have fuzzy supertypes, we give this typename an empty supertype
                // set and then populate it with any fuzzy supertypes that match.
                supertypes_1 = this.getSupertypeSet(typename, true);
                // This only works for typenames that are directly matched by a fuzzy
                // supertype. What if there is an intermediate chain of supertypes?
                // While possible, that situation can only be solved effectively by
                // specifying the intermediate relationships via possibleTypes, manually
                // and in a non-fuzzy way.
                this.fuzzySubtypes.forEach(function(regExp, fuzzy) {
                    if (regExp.test(typename)) {
                        // The fuzzy parameter is just the original string version of regExp
                        // (not a valid __typename string), but we can look up the
                        // associated supertype(s) in this.supertypeMap.
                        var fuzzySupertypes = _this.supertypeMap.get(fuzzy);
                        if (fuzzySupertypes) {
                            fuzzySupertypes.forEach(function(supertype) {
                                return supertypes_1.add(supertype);
                            });
                        }
                    }
                });
            }
            if (supertypes_1 && supertypes_1.size) {
                supertypes_1.forEach(function(supertype) {
                    var _a = _this.getTypePolicy(supertype), fields = _a.fields, rest = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__rest"])(_a, [
                        "fields"
                    ]);
                    Object.assign(policy_1, rest);
                    Object.assign(policy_1.fields, fields);
                });
            }
        }
        var inbox = this.toBeAdded[typename];
        if (inbox && inbox.length) {
            // Merge the pending policies into this.typePolicies, in the order they
            // were originally passed to addTypePolicy.
            inbox.splice(0).forEach(function(policy) {
                _this.updateTypePolicy(typename, policy, _this.typePolicies[typename].fields);
            });
        }
        return this.typePolicies[typename];
    };
    Policies.prototype.getFieldPolicy = function(typename, fieldName) {
        if (typename) {
            return this.getTypePolicy(typename).fields[fieldName];
        }
    };
    Policies.prototype.getSupertypeSet = function(subtype, createIfMissing) {
        var supertypeSet = this.supertypeMap.get(subtype);
        if (!supertypeSet && createIfMissing) {
            this.supertypeMap.set(subtype, supertypeSet = new Set());
        }
        return supertypeSet;
    };
    Policies.prototype.fragmentMatches = function(fragment, typename, result, variables) {
        var _this = this;
        if (!fragment.typeCondition) return true;
        // If the fragment has a type condition but the object we're matching
        // against does not have a __typename, the fragment cannot match.
        if (!typename) return false;
        var supertype = fragment.typeCondition.name.value;
        // Common case: fragment type condition and __typename are the same.
        if (typename === supertype) return true;
        if (this.usingPossibleTypes && this.supertypeMap.has(supertype)) {
            var typenameSupertypeSet = this.getSupertypeSet(typename, true);
            var workQueue_1 = [
                typenameSupertypeSet
            ];
            var maybeEnqueue_1 = function(subtype) {
                var supertypeSet = _this.getSupertypeSet(subtype, false);
                if (supertypeSet && supertypeSet.size && workQueue_1.indexOf(supertypeSet) < 0) {
                    workQueue_1.push(supertypeSet);
                }
            };
            // We need to check fuzzy subtypes only if we encountered fuzzy
            // subtype strings in addPossibleTypes, and only while writing to
            // the cache, since that's when selectionSetMatchesResult gives a
            // strong signal of fragment matching. The StoreReader class calls
            // policies.fragmentMatches without passing a result object, so
            // needToCheckFuzzySubtypes is always false while reading.
            var needToCheckFuzzySubtypes = !!(result && this.fuzzySubtypes.size);
            var checkingFuzzySubtypes = false;
            // It's important to keep evaluating workQueue.length each time through
            // the loop, because the queue can grow while we're iterating over it.
            for(var i = 0; i < workQueue_1.length; ++i){
                var supertypeSet = workQueue_1[i];
                if (supertypeSet.has(supertype)) {
                    if (!typenameSupertypeSet.has(supertype)) {
                        if (checkingFuzzySubtypes) {
                            globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(7, typename, supertype);
                        }
                        // Record positive results for faster future lookup.
                        // Unfortunately, we cannot safely cache negative results,
                        // because new possibleTypes data could always be added to the
                        // Policies class.
                        typenameSupertypeSet.add(supertype);
                    }
                    return true;
                }
                supertypeSet.forEach(maybeEnqueue_1);
                if (needToCheckFuzzySubtypes && // Start checking fuzzy subtypes only after exhausting all
                // non-fuzzy subtypes (after the final iteration of the loop).
                i === workQueue_1.length - 1 && // We could wait to compare fragment.selectionSet to result
                // after we verify the supertype, but this check is often less
                // expensive than that search, and we will have to do the
                // comparison anyway whenever we find a potential match.
                (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["selectionSetMatchesResult"])(fragment.selectionSet, result, variables)) {
                    // We don't always need to check fuzzy subtypes (if no result
                    // was provided, or !this.fuzzySubtypes.size), but, when we do,
                    // we only want to check them once.
                    needToCheckFuzzySubtypes = false;
                    checkingFuzzySubtypes = true;
                    // If we find any fuzzy subtypes that match typename, extend the
                    // workQueue to search through the supertypes of those fuzzy
                    // subtypes. Otherwise the for-loop will terminate and we'll
                    // return false below.
                    this.fuzzySubtypes.forEach(function(regExp, fuzzyString) {
                        var match = typename.match(regExp);
                        if (match && match[0] === typename) {
                            maybeEnqueue_1(fuzzyString);
                        }
                    });
                }
            }
        }
        return false;
    };
    Policies.prototype.hasKeyArgs = function(typename, fieldName) {
        var policy = this.getFieldPolicy(typename, fieldName);
        return !!(policy && policy.keyFn);
    };
    Policies.prototype.getStoreFieldName = function(fieldSpec) {
        var typename = fieldSpec.typename, fieldName = fieldSpec.fieldName;
        var policy = this.getFieldPolicy(typename, fieldName);
        var storeFieldName;
        var keyFn = policy && policy.keyFn;
        if (keyFn && typename) {
            var context = {
                typename: typename,
                fieldName: fieldName,
                field: fieldSpec.field || null,
                variables: fieldSpec.variables
            };
            var args = argsFromFieldSpecifier(fieldSpec);
            while(keyFn){
                var specifierOrString = keyFn(args, context);
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(specifierOrString)) {
                    keyFn = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$key$2d$extractor$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["keyArgsFnFromSpecifier"])(specifierOrString);
                } else {
                    // If the custom keyFn returns a falsy value, fall back to
                    // fieldName instead.
                    storeFieldName = specifierOrString || fieldName;
                    break;
                }
            }
        }
        if (storeFieldName === void 0) {
            storeFieldName = fieldSpec.field ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["storeKeyNameFromField"])(fieldSpec.field, fieldSpec.variables) : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getStoreKeyName"])(fieldName, argsFromFieldSpecifier(fieldSpec));
        }
        // Returning false from a keyArgs function is like configuring
        // keyArgs: false, but more dynamic.
        if (storeFieldName === false) {
            return fieldName;
        }
        // Make sure custom field names start with the actual field.name.value
        // of the field, so we can always figure out which properties of a
        // StoreObject correspond to which original field names.
        return fieldName === (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["fieldNameFromStoreName"])(storeFieldName) ? storeFieldName : fieldName + ":" + storeFieldName;
    };
    Policies.prototype.readField = function(options, context) {
        var objectOrReference = options.from;
        if (!objectOrReference) return;
        var nameOrField = options.field || options.fieldName;
        if (!nameOrField) return;
        if (options.typename === void 0) {
            var typename = context.store.getFieldValue(objectOrReference, "__typename");
            if (typename) options.typename = typename;
        }
        var storeFieldName = this.getStoreFieldName(options);
        var fieldName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["fieldNameFromStoreName"])(storeFieldName);
        var existing = context.store.getFieldValue(objectOrReference, storeFieldName);
        var policy = this.getFieldPolicy(options.typename, fieldName);
        var read = policy && policy.read;
        if (read) {
            var readOptions = makeFieldFunctionOptions(this, objectOrReference, options, context, context.store.getStorage((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(objectOrReference) ? objectOrReference.__ref : objectOrReference, storeFieldName));
            // Call read(existing, readOptions) with cacheSlot holding this.cache.
            return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$reactiveVars$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cacheSlot"].withValue(this.cache, read, [
                existing,
                readOptions
            ]);
        }
        return existing;
    };
    Policies.prototype.getReadFunction = function(typename, fieldName) {
        var policy = this.getFieldPolicy(typename, fieldName);
        return policy && policy.read;
    };
    Policies.prototype.getMergeFunction = function(parentTypename, fieldName, childTypename) {
        var policy = this.getFieldPolicy(parentTypename, fieldName);
        var merge = policy && policy.merge;
        if (!merge && childTypename) {
            policy = this.getTypePolicy(childTypename);
            merge = policy && policy.merge;
        }
        return merge;
    };
    Policies.prototype.runMergeFunction = function(existing, incoming, _a, context, storage) {
        var field = _a.field, typename = _a.typename, merge = _a.merge;
        if (merge === mergeTrueFn) {
            // Instead of going to the trouble of creating a full
            // FieldFunctionOptions object and calling mergeTrueFn, we can
            // simply call mergeObjects, as mergeTrueFn would.
            return makeMergeObjectsFunction(context.store)(existing, incoming);
        }
        if (merge === mergeFalseFn) {
            // Likewise for mergeFalseFn, whose implementation is even simpler.
            return incoming;
        }
        // If cache.writeQuery or cache.writeFragment was called with
        // options.overwrite set to true, we still call merge functions, but
        // the existing data is always undefined, so the merge function will
        // not attempt to combine the incoming data with the existing data.
        if (context.overwrite) {
            existing = void 0;
        }
        return merge(existing, incoming, makeFieldFunctionOptions(this, // Unlike options.readField for read functions, we do not fall
        // back to the current object if no foreignObjOrRef is provided,
        // because it's not clear what the current object should be for
        // merge functions: the (possibly undefined) existing object, or
        // the incoming object? If you think your merge function needs
        // to read sibling fields in order to produce a new value for
        // the current field, you might want to rethink your strategy,
        // because that's a recipe for making merge behavior sensitive
        // to the order in which fields are written into the cache.
        // However, readField(name, ref) is useful for merge functions
        // that need to deduplicate child objects and references.
        void 0, {
            typename: typename,
            fieldName: field.name.value,
            field: field,
            variables: context.variables
        }, context, storage || Object.create(null)));
    };
    return Policies;
}();
;
function makeFieldFunctionOptions(policies, objectOrReference, fieldSpec, context, storage) {
    var storeFieldName = policies.getStoreFieldName(fieldSpec);
    var fieldName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["fieldNameFromStoreName"])(storeFieldName);
    var variables = fieldSpec.variables || context.variables;
    var _a = context.store, toReference = _a.toReference, canRead = _a.canRead;
    return {
        args: argsFromFieldSpecifier(fieldSpec),
        field: fieldSpec.field || null,
        fieldName: fieldName,
        storeFieldName: storeFieldName,
        variables: variables,
        isReference: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"],
        toReference: toReference,
        storage: storage,
        cache: policies.cache,
        canRead: canRead,
        readField: function() {
            return policies.readField(normalizeReadFieldOptions(arguments, objectOrReference, variables), context);
        },
        mergeObjects: makeMergeObjectsFunction(context.store)
    };
}
function normalizeReadFieldOptions(readFieldArgs, objectOrReference, variables) {
    var fieldNameOrOptions = readFieldArgs[0], from = readFieldArgs[1], argc = readFieldArgs.length;
    var options;
    if (typeof fieldNameOrOptions === "string") {
        options = {
            fieldName: fieldNameOrOptions,
            // Default to objectOrReference only when no second argument was
            // passed for the from parameter, not when undefined is explicitly
            // passed as the second argument.
            from: argc > 1 ? from : objectOrReference
        };
    } else {
        options = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, fieldNameOrOptions);
        // Default to objectOrReference only when fieldNameOrOptions.from is
        // actually omitted, rather than just undefined.
        if (!__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(options, "from")) {
            options.from = objectOrReference;
        }
    }
    if (globalThis.__DEV__ !== false && options.from === void 0) {
        globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(8, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$stringifyForDisplay$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["stringifyForDisplay"])(Array.from(readFieldArgs)));
    }
    if (void 0 === options.variables) {
        options.variables = variables;
    }
    return options;
}
function makeMergeObjectsFunction(store) {
    return function mergeObjects(existing, incoming) {
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(existing) || (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(incoming)) {
            throw (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["newInvariantError"])(9);
        }
        // These dynamic checks are necessary because the parameters of a
        // custom merge function can easily have the any type, so the type
        // system cannot always enforce the StoreObject | Reference parameter
        // types of options.mergeObjects.
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(existing) && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$objects$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonNullObject"])(incoming)) {
            var eType = store.getFieldValue(existing, "__typename");
            var iType = store.getFieldValue(incoming, "__typename");
            var typesDiffer = eType && iType && eType !== iType;
            if (typesDiffer) {
                return incoming;
            }
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(existing) && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["storeValueIsStoreObject"])(incoming)) {
                // Update the normalized EntityStore for the entity identified by
                // existing.__ref, preferring/overwriting any fields contributed by the
                // newer incoming StoreObject.
                store.merge(existing.__ref, incoming);
                return existing;
            }
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["storeValueIsStoreObject"])(existing) && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(incoming)) {
                // Update the normalized EntityStore for the entity identified by
                // incoming.__ref, taking fields from the older existing object only if
                // those fields are not already present in the newer StoreObject
                // identified by incoming.__ref.
                store.merge(existing, incoming.__ref);
                return incoming;
            }
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["storeValueIsStoreObject"])(existing) && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["storeValueIsStoreObject"])(incoming)) {
                return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, existing), incoming);
            }
        }
        return incoming;
    };
} //# sourceMappingURL=policies.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/writeToStore.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "StoreWriter": ()=>StoreWriter
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+equality@0.5.7/node_modules/@wry/equality/lib/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$trie$40$0$2e$5$2e$0$2f$node_modules$2f40$wry$2f$trie$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+trie@0.5.0/node_modules/@wry/trie/lib/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/graphql@16.12.0/node_modules/graphql/language/kinds.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/fragments.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/getFromAST.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/storeUtils.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/directives.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$cloneDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/cloneDeep.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$transform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/transform.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/arrays.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canonicalStringify$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canonicalStringify.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/helpers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$policies$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/policies.js [app-client] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
;
;
;
// Since there are only four possible combinations of context.clientOnly and
// context.deferred values, we should need at most four "flavors" of any given
// WriteContext. To avoid creating multiple copies of the same context, we cache
// the contexts in the context.flavors Map (shared by all flavors) according to
// their clientOnly and deferred values (always in that order).
function getContextFlavor(context, clientOnly, deferred) {
    var key = "".concat(clientOnly).concat(deferred);
    var flavored = context.flavors.get(key);
    if (!flavored) {
        context.flavors.set(key, flavored = context.clientOnly === clientOnly && context.deferred === deferred ? context : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, context), {
            clientOnly: clientOnly,
            deferred: deferred
        }));
    }
    return flavored;
}
var StoreWriter = function() {
    function StoreWriter(cache, reader, fragments) {
        this.cache = cache;
        this.reader = reader;
        this.fragments = fragments;
    }
    StoreWriter.prototype.writeToStore = function(store, _a) {
        var _this = this;
        var query = _a.query, result = _a.result, dataId = _a.dataId, variables = _a.variables, overwrite = _a.overwrite;
        var operationDefinition = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getOperationDefinition"])(query);
        var merger = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["makeProcessedFieldsMerger"])();
        variables = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$getFromAST$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getDefaultValues"])(operationDefinition)), variables);
        var context = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({
            store: store,
            written: Object.create(null),
            merge: function(existing, incoming) {
                return merger.merge(existing, incoming);
            },
            variables: variables,
            varString: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canonicalStringify$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canonicalStringify"])(variables)
        }, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["extractFragmentContext"])(query, this.fragments)), {
            overwrite: !!overwrite,
            incomingById: new Map(),
            clientOnly: false,
            deferred: false,
            flavors: new Map()
        });
        var ref = this.processSelectionSet({
            result: result || Object.create(null),
            dataId: dataId,
            selectionSet: operationDefinition.selectionSet,
            mergeTree: {
                map: new Map()
            },
            context: context
        });
        if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(ref)) {
            throw (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["newInvariantError"])(12, result);
        }
        // So far, the store has not been modified, so now it's time to process
        // context.incomingById and merge those incoming fields into context.store.
        context.incomingById.forEach(function(_a, dataId) {
            var storeObject = _a.storeObject, mergeTree = _a.mergeTree, fieldNodeSet = _a.fieldNodeSet;
            var entityRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["makeReference"])(dataId);
            if (mergeTree && mergeTree.map.size) {
                var applied = _this.applyMerges(mergeTree, entityRef, storeObject, context);
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(applied)) {
                    // Assume References returned by applyMerges have already been merged
                    // into the store. See makeMergeObjectsFunction in policies.ts for an
                    // example of how this can happen.
                    return;
                }
                // Otherwise, applyMerges returned a StoreObject, whose fields we should
                // merge into the store (see store.merge statement below).
                storeObject = applied;
            }
            if (globalThis.__DEV__ !== false && !context.overwrite) {
                var fieldsWithSelectionSets_1 = Object.create(null);
                fieldNodeSet.forEach(function(field) {
                    if (field.selectionSet) {
                        fieldsWithSelectionSets_1[field.name.value] = true;
                    }
                });
                var hasSelectionSet_1 = function(storeFieldName) {
                    return fieldsWithSelectionSets_1[(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["fieldNameFromStoreName"])(storeFieldName)] === true;
                };
                var hasMergeFunction_1 = function(storeFieldName) {
                    var childTree = mergeTree && mergeTree.map.get(storeFieldName);
                    return Boolean(childTree && childTree.info && childTree.info.merge);
                };
                Object.keys(storeObject).forEach(function(storeFieldName) {
                    // If a merge function was defined for this field, trust that it
                    // did the right thing about (not) clobbering data. If the field
                    // has no selection set, it's a scalar field, so it doesn't need
                    // a merge function (even if it's an object, like JSON data).
                    if (hasSelectionSet_1(storeFieldName) && !hasMergeFunction_1(storeFieldName)) {
                        warnAboutDataLoss(entityRef, storeObject, storeFieldName, context.store);
                    }
                });
            }
            store.merge(dataId, storeObject);
        });
        // Any IDs written explicitly to the cache will be retained as
        // reachable root IDs for garbage collection purposes. Although this
        // logic includes root IDs like ROOT_QUERY and ROOT_MUTATION, their
        // retainment counts are effectively ignored because cache.gc() always
        // includes them in its root ID set.
        store.retain(ref.__ref);
        return ref;
    };
    StoreWriter.prototype.processSelectionSet = function(_a) {
        var _this = this;
        var dataId = _a.dataId, result = _a.result, selectionSet = _a.selectionSet, context = _a.context, // This object allows processSelectionSet to report useful information
        // to its callers without explicitly returning that information.
        mergeTree = _a.mergeTree;
        var policies = this.cache.policies;
        // This variable will be repeatedly updated using context.merge to
        // accumulate all fields that need to be written into the store.
        var incoming = Object.create(null);
        // If typename was not passed in, infer it. Note that typename is
        // always passed in for tricky-to-infer cases such as "Query" for
        // ROOT_QUERY.
        var typename = dataId && policies.rootTypenamesById[dataId] || (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTypenameFromResult"])(result, selectionSet, context.fragmentMap) || dataId && context.store.get(dataId, "__typename");
        if ("string" === typeof typename) {
            incoming.__typename = typename;
        }
        // This readField function will be passed as context.readField in the
        // KeyFieldsContext object created within policies.identify (called below).
        // In addition to reading from the existing context.store (thanks to the
        // policies.readField(options, context) line at the very bottom), this
        // version of readField can read from Reference objects that are currently
        // pending in context.incomingById, which is important whenever keyFields
        // need to be extracted from a child object that processSelectionSet has
        // turned into a Reference.
        var readField = function() {
            var options = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$policies$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["normalizeReadFieldOptions"])(arguments, incoming, context.variables);
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(options.from)) {
                var info = context.incomingById.get(options.from.__ref);
                if (info) {
                    var result_1 = policies.readField((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                        from: info.storeObject
                    }), context);
                    if (result_1 !== void 0) {
                        return result_1;
                    }
                }
            }
            return policies.readField(options, context);
        };
        var fieldNodeSet = new Set();
        this.flattenFields(selectionSet, result, // This WriteContext will be the default context value for fields returned
        // by the flattenFields method, but some fields may be assigned a modified
        // context, depending on the presence of @client and other directives.
        context, typename).forEach(function(context, field) {
            var _a;
            var resultFieldKey = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["resultKeyNameFromField"])(field);
            var value = result[resultFieldKey];
            fieldNodeSet.add(field);
            if (value !== void 0) {
                var storeFieldName = policies.getStoreFieldName({
                    typename: typename,
                    fieldName: field.name.value,
                    field: field,
                    variables: context.variables
                });
                var childTree = getChildMergeTree(mergeTree, storeFieldName);
                var incomingValue = _this.processFieldValue(value, field, // Reset context.clientOnly and context.deferred to their default
                // values before processing nested selection sets.
                field.selectionSet ? getContextFlavor(context, false, false) : context, childTree);
                // To determine if this field holds a child object with a merge function
                // defined in its type policy (see PR #7070), we need to figure out the
                // child object's __typename.
                var childTypename = void 0;
                // The field's value can be an object that has a __typename only if the
                // field has a selection set. Otherwise incomingValue is scalar.
                if (field.selectionSet && ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(incomingValue) || (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["storeValueIsStoreObject"])(incomingValue))) {
                    childTypename = readField("__typename", incomingValue);
                }
                var merge = policies.getMergeFunction(typename, field.name.value, childTypename);
                if (merge) {
                    childTree.info = {
                        // TODO Check compatibility against any existing childTree.field?
                        field: field,
                        typename: typename,
                        merge: merge
                    };
                } else {
                    maybeRecycleChildMergeTree(mergeTree, storeFieldName);
                }
                incoming = context.merge(incoming, (_a = {}, _a[storeFieldName] = incomingValue, _a));
            } else if (globalThis.__DEV__ !== false && !context.clientOnly && !context.deferred && !__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$transform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["addTypenameToDocument"].added(field) && // If the field has a read function, it may be a synthetic field or
            // provide a default value, so its absence from the written data should
            // not be cause for alarm.
            !policies.getReadFunction(typename, field.name.value)) {
                globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].error(13, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["resultKeyNameFromField"])(field), result);
            }
        });
        // Identify the result object, even if dataId was already provided,
        // since we always need keyObject below.
        try {
            var _b = policies.identify(result, {
                typename: typename,
                selectionSet: selectionSet,
                fragmentMap: context.fragmentMap,
                storeObject: incoming,
                readField: readField
            }), id = _b[0], keyObject = _b[1];
            // If dataId was not provided, fall back to the id just generated by
            // policies.identify.
            dataId = dataId || id;
            // Write any key fields that were used during identification, even if
            // they were not mentioned in the original query.
            if (keyObject) {
                // TODO Reverse the order of the arguments?
                incoming = context.merge(incoming, keyObject);
            }
        } catch (e) {
            // If dataId was provided, tolerate failure of policies.identify.
            if (!dataId) throw e;
        }
        if ("string" === typeof dataId) {
            var dataRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["makeReference"])(dataId);
            // Avoid processing the same entity object using the same selection
            // set more than once. We use an array instead of a Set since most
            // entity IDs will be written using only one selection set, so the
            // size of this array is likely to be very small, meaning indexOf is
            // likely to be faster than Set.prototype.has.
            var sets = context.written[dataId] || (context.written[dataId] = []);
            if (sets.indexOf(selectionSet) >= 0) return dataRef;
            sets.push(selectionSet);
            // If we're about to write a result object into the store, but we
            // happen to know that the exact same (===) result object would be
            // returned if we were to reread the result with the same inputs,
            // then we can skip the rest of the processSelectionSet work for
            // this object, and immediately return a Reference to it.
            if (this.reader && this.reader.isFresh(result, dataRef, selectionSet, context)) {
                return dataRef;
            }
            var previous_1 = context.incomingById.get(dataId);
            if (previous_1) {
                previous_1.storeObject = context.merge(previous_1.storeObject, incoming);
                previous_1.mergeTree = mergeMergeTrees(previous_1.mergeTree, mergeTree);
                fieldNodeSet.forEach(function(field) {
                    return previous_1.fieldNodeSet.add(field);
                });
            } else {
                context.incomingById.set(dataId, {
                    storeObject: incoming,
                    // Save a reference to mergeTree only if it is not empty, because
                    // empty MergeTrees may be recycled by maybeRecycleChildMergeTree and
                    // reused for entirely different parts of the result tree.
                    mergeTree: mergeTreeIsEmpty(mergeTree) ? void 0 : mergeTree,
                    fieldNodeSet: fieldNodeSet
                });
            }
            return dataRef;
        }
        return incoming;
    };
    StoreWriter.prototype.processFieldValue = function(value, field, context, mergeTree) {
        var _this = this;
        if (!field.selectionSet || value === null) {
            // In development, we need to clone scalar values so that they can be
            // safely frozen with maybeDeepFreeze in readFromStore.ts. In production,
            // it's cheaper to store the scalar values directly in the cache.
            return globalThis.__DEV__ !== false ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$cloneDeep$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cloneDeep"])(value) : value;
        }
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(value)) {
            return value.map(function(item, i) {
                var value = _this.processFieldValue(item, field, context, getChildMergeTree(mergeTree, i));
                maybeRecycleChildMergeTree(mergeTree, i);
                return value;
            });
        }
        return this.processSelectionSet({
            result: value,
            selectionSet: field.selectionSet,
            context: context,
            mergeTree: mergeTree
        });
    };
    // Implements https://spec.graphql.org/draft/#sec-Field-Collection, but with
    // some additions for tracking @client and @defer directives.
    StoreWriter.prototype.flattenFields = function(selectionSet, result, context, typename) {
        if (typename === void 0) {
            typename = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTypenameFromResult"])(result, selectionSet, context.fragmentMap);
        }
        var fieldMap = new Map();
        var policies = this.cache.policies;
        var limitingTrie = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$trie$40$0$2e$5$2e$0$2f$node_modules$2f40$wry$2f$trie$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Trie"](false); // No need for WeakMap, since limitingTrie does not escape.
        (function flatten(selectionSet, inheritedContext) {
            var visitedNode = limitingTrie.lookup(selectionSet, // Because we take inheritedClientOnly and inheritedDeferred into
            // consideration here (in addition to selectionSet), it's possible for
            // the same selection set to be flattened more than once, if it appears
            // in the query with different @client and/or @directive configurations.
            inheritedContext.clientOnly, inheritedContext.deferred);
            if (visitedNode.visited) return;
            visitedNode.visited = true;
            selectionSet.selections.forEach(function(selection) {
                if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$directives$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["shouldInclude"])(selection, context.variables)) return;
                var clientOnly = inheritedContext.clientOnly, deferred = inheritedContext.deferred;
                if (// Since the presence of @client or @defer on this field can only
                // cause clientOnly or deferred to become true, we can skip the
                // forEach loop if both clientOnly and deferred are already true.
                !(clientOnly && deferred) && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isNonEmptyArray"])(selection.directives)) {
                    selection.directives.forEach(function(dir) {
                        var name = dir.name.value;
                        if (name === "client") clientOnly = true;
                        if (name === "defer") {
                            var args = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["argumentsObjectFromField"])(dir, context.variables);
                            // The @defer directive takes an optional args.if boolean
                            // argument, similar to @include(if: boolean). Note that
                            // @defer(if: false) does not make context.deferred false, but
                            // instead behaves as if there was no @defer directive.
                            if (!args || args.if !== false) {
                                deferred = true;
                            }
                        // TODO In the future, we may want to record args.label using
                        // context.deferred, if a label is specified.
                        }
                    });
                }
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isField"])(selection)) {
                    var existing = fieldMap.get(selection);
                    if (existing) {
                        // If this field has been visited along another recursive path
                        // before, the final context should have clientOnly or deferred set
                        // to true only if *all* paths have the directive (hence the &&).
                        clientOnly = clientOnly && existing.clientOnly;
                        deferred = deferred && existing.deferred;
                    }
                    fieldMap.set(selection, getContextFlavor(context, clientOnly, deferred));
                } else {
                    var fragment = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$fragments$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getFragmentFromSelection"])(selection, context.lookupFragment);
                    if (!fragment && selection.kind === __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$graphql$40$16$2e$12$2e$0$2f$node_modules$2f$graphql$2f$language$2f$kinds$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Kind"].FRAGMENT_SPREAD) {
                        throw (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["newInvariantError"])(14, selection.name.value);
                    }
                    if (fragment && policies.fragmentMatches(fragment, typename, result, context.variables)) {
                        flatten(fragment.selectionSet, getContextFlavor(context, clientOnly, deferred));
                    }
                }
            });
        })(selectionSet, context);
        return fieldMap;
    };
    StoreWriter.prototype.applyMerges = function(mergeTree, existing, incoming, context, getStorageArgs) {
        var _a;
        var _this = this;
        if (mergeTree.map.size && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(incoming)) {
            var e_1 = // Items in the same position in different arrays are not
            // necessarily related to each other, so when incoming is an array
            // we process its elements as if there was no existing data.
            !(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(incoming) && // Likewise, existing must be either a Reference or a StoreObject
            // in order for its fields to be safe to merge with the fields of
            // the incoming object.
            ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(existing) || (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["storeValueIsStoreObject"])(existing)) ? existing : void 0;
            // This narrowing is implied by mergeTree.map.size > 0 and
            // !isReference(incoming), though TypeScript understandably cannot
            // hope to infer this type.
            var i_1 = incoming;
            // The options.storage objects provided to read and merge functions
            // are derived from the identity of the parent object plus a
            // sequence of storeFieldName strings/numbers identifying the nested
            // field name path of each field value to be merged.
            if (e_1 && !getStorageArgs) {
                getStorageArgs = [
                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(e_1) ? e_1.__ref : e_1
                ];
            }
            // It's possible that applying merge functions to this subtree will
            // not change the incoming data, so this variable tracks the fields
            // that did change, so we can create a new incoming object when (and
            // only when) at least one incoming field has changed. We use a Map
            // to preserve the type of numeric keys.
            var changedFields_1;
            var getValue_1 = function(from, name) {
                return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(from) ? typeof name === "number" ? from[name] : void 0 : context.store.getFieldValue(from, String(name));
            };
            mergeTree.map.forEach(function(childTree, storeFieldName) {
                var eVal = getValue_1(e_1, storeFieldName);
                var iVal = getValue_1(i_1, storeFieldName);
                // If we have no incoming data, leave any existing data untouched.
                if (void 0 === iVal) return;
                if (getStorageArgs) {
                    getStorageArgs.push(storeFieldName);
                }
                var aVal = _this.applyMerges(childTree, eVal, iVal, context, getStorageArgs);
                if (aVal !== iVal) {
                    changedFields_1 = changedFields_1 || new Map();
                    changedFields_1.set(storeFieldName, aVal);
                }
                if (getStorageArgs) {
                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"])(getStorageArgs.pop() === storeFieldName);
                }
            });
            if (changedFields_1) {
                // Shallow clone i so we can add changed fields to it.
                incoming = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(i_1) ? i_1.slice(0) : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, i_1);
                changedFields_1.forEach(function(value, name) {
                    incoming[name] = value;
                });
            }
        }
        if (mergeTree.info) {
            return this.cache.policies.runMergeFunction(existing, incoming, mergeTree.info, context, getStorageArgs && (_a = context.store).getStorage.apply(_a, getStorageArgs));
        }
        return incoming;
    };
    return StoreWriter;
}();
;
var emptyMergeTreePool = [];
function getChildMergeTree(_a, name) {
    var map = _a.map;
    if (!map.has(name)) {
        map.set(name, emptyMergeTreePool.pop() || {
            map: new Map()
        });
    }
    return map.get(name);
}
function mergeMergeTrees(left, right) {
    if (left === right || !right || mergeTreeIsEmpty(right)) return left;
    if (!left || mergeTreeIsEmpty(left)) return right;
    var info = left.info && right.info ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, left.info), right.info) : left.info || right.info;
    var needToMergeMaps = left.map.size && right.map.size;
    var map = needToMergeMaps ? new Map() : left.map.size ? left.map : right.map;
    var merged = {
        info: info,
        map: map
    };
    if (needToMergeMaps) {
        var remainingRightKeys_1 = new Set(right.map.keys());
        left.map.forEach(function(leftTree, key) {
            merged.map.set(key, mergeMergeTrees(leftTree, right.map.get(key)));
            remainingRightKeys_1.delete(key);
        });
        remainingRightKeys_1.forEach(function(key) {
            merged.map.set(key, mergeMergeTrees(right.map.get(key), left.map.get(key)));
        });
    }
    return merged;
}
function mergeTreeIsEmpty(tree) {
    return !tree || !(tree.info || tree.map.size);
}
function maybeRecycleChildMergeTree(_a, name) {
    var map = _a.map;
    var childTree = map.get(name);
    if (childTree && mergeTreeIsEmpty(childTree)) {
        emptyMergeTreePool.push(childTree);
        map.delete(name);
    }
}
var warnings = new Set();
// Note that this function is unused in production, and thus should be
// pruned by any well-configured minifier.
function warnAboutDataLoss(existingRef, incomingObj, storeFieldName, store) {
    var getChild = function(objOrRef) {
        var child = store.getFieldValue(objOrRef, storeFieldName);
        return typeof child === "object" && child;
    };
    var existing = getChild(existingRef);
    if (!existing) return;
    var incoming = getChild(incomingObj);
    if (!incoming) return;
    // It's always safe to replace a reference, since it refers to data
    // safely stored elsewhere.
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(existing)) return;
    // If the values are structurally equivalent, we do not need to worry
    // about incoming replacing existing.
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["equal"])(existing, incoming)) return;
    // If we're replacing every key of the existing object, then the
    // existing data would be overwritten even if the objects were
    // normalized, so warning would not be helpful here.
    if (Object.keys(existing).every(function(key) {
        return store.getFieldValue(incoming, key) !== void 0;
    })) {
        return;
    }
    var parentType = store.getFieldValue(existingRef, "__typename") || store.getFieldValue(incomingObj, "__typename");
    var fieldName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["fieldNameFromStoreName"])(storeFieldName);
    var typeDotName = "".concat(parentType, ".").concat(fieldName);
    // Avoid warning more than once for the same type and field name.
    if (warnings.has(typeDotName)) return;
    warnings.add(typeDotName);
    var childTypenames = [];
    // Arrays do not have __typename fields, and always need a custom merge
    // function, even if their elements are normalized entities.
    if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(existing) && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$arrays$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isArray"])(incoming)) {
        [
            existing,
            incoming
        ].forEach(function(child) {
            var typename = store.getFieldValue(child, "__typename");
            if (typeof typename === "string" && !childTypenames.includes(typename)) {
                childTypenames.push(typename);
            }
        });
    }
    globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(15, fieldName, parentType, childTypenames.length ? "either ensure all objects of type " + childTypenames.join(" and ") + " have an ID or a custom merge function, or " : "", typeDotName, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, existing), (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, incoming));
} //# sourceMappingURL=writeToStore.js.map

})()),
"[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/inMemoryCache.js [app-client] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {
"use strict";

__turbopack_esm__({
    "InMemoryCache": ()=>InMemoryCache
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/globals/invariantWrappers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/optimism@0.18.1/node_modules/optimism/lib/index.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@wry+equality@0.5.7/node_modules/@wry/equality/lib/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$core$2f$cache$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/core/cache.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$core$2f$types$2f$common$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/core/types/common.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$transform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/transform.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/storeUtils.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$DocumentTransform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/DocumentTransform.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canonicalStringify$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/common/canonicalStringify.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$print$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/graphql/print.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$sizes$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/caching/sizes.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$readFromStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/readFromStore.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$writeToStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/writeToStore.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/entityStore.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$reactiveVars$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/reactiveVars.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$policies$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/policies.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/cache/inmemory/helpers.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$getMemoryInternals$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/caching/getMemoryInternals.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@apollo+client@3.14.0_@types+react@19.2.7_graphql-ws@5.16.2_graphql@16.12.0__graphql@16.12.0__tbq6iuuvyf5o7vygi75isfjkly/node_modules/@apollo/client/utilities/deprecation/index.js [app-client] (ecmascript)");
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
;
;
;
;
var InMemoryCache = function(_super) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__extends"])(InMemoryCache, _super);
    function InMemoryCache(config) {
        if (config === void 0) {
            config = {};
        }
        var _this = _super.call(this) || this;
        _this.watches = new Set();
        _this.addTypenameTransform = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$DocumentTransform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["DocumentTransform"](__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$transform$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["addTypenameToDocument"]);
        // Override the default value, since InMemoryCache result objects are frozen
        // in development and expected to remain logically immutable in production.
        _this.assumeImmutableResults = true;
        _this.makeVar = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$reactiveVars$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["makeVar"];
        _this.txCount = 0;
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(config, "addTypename", "InMemoryCache", "Please remove the `addTypename` option when initializing `InMemoryCache`.");
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(config, "canonizeResults", "InMemoryCache", "Please remove the `canonizeResults` option when initializing `InMemoryCache`.");
        }
        _this.config = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["normalizeConfig"])(config);
        _this.addTypename = !!_this.config.addTypename;
        _this.policies = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$policies$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Policies"]({
            cache: _this,
            dataIdFromObject: _this.config.dataIdFromObject,
            possibleTypes: _this.config.possibleTypes,
            typePolicies: _this.config.typePolicies
        });
        _this.init();
        return _this;
    }
    InMemoryCache.prototype.init = function() {
        // Passing { resultCaching: false } in the InMemoryCache constructor options
        // will completely disable dependency tracking, which will improve memory
        // usage but worsen the performance of repeated reads.
        var rootStore = this.data = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["EntityStore"].Root({
            policies: this.policies,
            resultCaching: this.config.resultCaching
        });
        // When no optimistic writes are currently active, cache.optimisticData ===
        // cache.data, so there are no additional layers on top of the actual data.
        // When an optimistic update happens, this.optimisticData will become a
        // linked list of EntityStore Layer objects that terminates with the
        // original this.data cache object.
        this.optimisticData = rootStore.stump;
        this.resetResultCache();
    };
    InMemoryCache.prototype.resetResultCache = function(resetResultIdentities) {
        var _this = this;
        var previousReader = this.storeReader;
        var fragments = this.config.fragments;
        this.addTypenameTransform.resetCache();
        fragments === null || fragments === void 0 ? void 0 : fragments.resetCaches();
        // The StoreWriter is mostly stateless and so doesn't really need to be
        // reset, but it does need to have its writer.storeReader reference updated,
        // so it's simpler to update this.storeWriter as well.
        this.storeWriter = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$writeToStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["StoreWriter"](this, this.storeReader = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$readFromStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["StoreReader"]({
            cache: this,
            addTypename: this.addTypename,
            resultCacheMaxSize: this.config.resultCacheMaxSize,
            canonizeResults: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["shouldCanonizeResults"])(this.config),
            canon: resetResultIdentities ? void 0 : previousReader && previousReader.canon,
            fragments: fragments
        }), fragments);
        this.maybeBroadcastWatch = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$optimism$40$0$2e$18$2e$1$2f$node_modules$2f$optimism$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["wrap"])(function(c, options) {
            return _this.broadcastWatch(c, options);
        }, {
            max: this.config.resultCacheMaxSize || __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$sizes$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cacheSizes"]["inMemoryCache.maybeBroadcastWatch"] || 5000 /* defaultCacheSizes["inMemoryCache.maybeBroadcastWatch"] */ ,
            makeCacheKey: function(c) {
                // Return a cache key (thus enabling result caching) only if we're
                // currently using a data store that can track cache dependencies.
                var store = c.optimistic ? _this.optimisticData : _this.data;
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$entityStore$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supportsResultCaching"])(store)) {
                    var optimistic = c.optimistic, id = c.id, variables = c.variables;
                    return store.makeCacheKey(c.query, // Different watches can have the same query, optimistic
                    // status, rootId, and variables, but if their callbacks are
                    // different, the (identical) result needs to be delivered to
                    // each distinct callback. The easiest way to achieve that
                    // separation is to include c.callback in the cache key for
                    // maybeBroadcastWatch calls. See issue #5733.
                    c.callback, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canonicalStringify$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canonicalStringify"])({
                        optimistic: optimistic,
                        id: id,
                        variables: variables
                    }));
                }
            }
        });
        // Since we have thrown away all the cached functions that depend on the
        // CacheGroup dependencies maintained by EntityStore, we should also reset
        // all CacheGroup dependency information.
        new Set([
            this.data.group,
            this.optimisticData.group
        ]).forEach(function(group) {
            return group.resetCaching();
        });
    };
    InMemoryCache.prototype.restore = function(data) {
        this.init();
        // Since calling this.init() discards/replaces the entire StoreReader, along
        // with the result caches it maintains, this.data.replace(data) won't have
        // to bother deleting the old data.
        if (data) this.data.replace(data);
        return this;
    };
    InMemoryCache.prototype.extract = function(optimistic) {
        if (optimistic === void 0) {
            optimistic = false;
        }
        return (optimistic ? this.optimisticData : this.data).extract();
    };
    InMemoryCache.prototype.read = function(options) {
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(options, "canonizeResults", "cache.read");
        }
        var // Since read returns data or null, without any additional metadata
        // about whether/where there might have been missing fields, the
        // default behavior cannot be returnPartialData = true (like it is
        // for the diff method), since defaulting to true would violate the
        // integrity of the T in the return type. However, partial data may
        // be useful in some cases, so returnPartialData:true may be
        // specified explicitly.
        _a = options.returnPartialData, // Since read returns data or null, without any additional metadata
        // about whether/where there might have been missing fields, the
        // default behavior cannot be returnPartialData = true (like it is
        // for the diff method), since defaulting to true would violate the
        // integrity of the T in the return type. However, partial data may
        // be useful in some cases, so returnPartialData:true may be
        // specified explicitly.
        returnPartialData = _a === void 0 ? false : _a;
        try {
            return this.storeReader.diffQueryAgainstStore((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                store: options.optimistic ? this.optimisticData : this.data,
                config: this.config,
                returnPartialData: returnPartialData
            })).result || null;
        } catch (e) {
            if (e instanceof __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$core$2f$types$2f$common$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["MissingFieldError"]) {
                // Swallow MissingFieldError and return null, so callers do not need to
                // worry about catching "normal" exceptions resulting from incomplete
                // cache data. Unexpected errors will be re-thrown. If you need more
                // information about which fields were missing, use cache.diff instead,
                // and examine diffResult.missing.
                return null;
            }
            throw e;
        }
    };
    InMemoryCache.prototype.write = function(options) {
        try {
            ++this.txCount;
            return this.storeWriter.writeToStore(this.data, options);
        } finally{
            if (!--this.txCount && options.broadcast !== false) {
                this.broadcastWatches();
            }
        }
    };
    InMemoryCache.prototype.modify = function(options) {
        if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(options, "id") && !options.id) {
            // To my knowledge, TypeScript does not currently provide a way to
            // enforce that an optional property?:type must *not* be undefined
            // when present. That ability would be useful here, because we want
            // options.id to default to ROOT_QUERY only when no options.id was
            // provided. If the caller attempts to pass options.id with a
            // falsy/undefined value (perhaps because cache.identify failed), we
            // should not assume the goal was to modify the ROOT_QUERY object.
            // We could throw, but it seems natural to return false to indicate
            // that nothing was modified.
            return false;
        }
        var store = options.optimistic ? this.optimisticData : this.data;
        try {
            ++this.txCount;
            return store.modify(options.id || "ROOT_QUERY", options.fields);
        } finally{
            if (!--this.txCount && options.broadcast !== false) {
                this.broadcastWatches();
            }
        }
    };
    InMemoryCache.prototype.diff = function(options) {
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(options, "canonizeResults", "cache.diff");
        }
        return this.storeReader.diffQueryAgainstStore((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
            store: options.optimistic ? this.optimisticData : this.data,
            rootId: options.id || "ROOT_QUERY",
            config: this.config
        }));
    };
    InMemoryCache.prototype.watch = function(watch) {
        var _this = this;
        if (!this.watches.size) {
            // In case we previously called forgetCache(this) because
            // this.watches became empty (see below), reattach this cache to any
            // reactive variables on which it previously depended. It might seem
            // paradoxical that we're able to recall something we supposedly
            // forgot, but the point of calling forgetCache(this) is to silence
            // useless broadcasts while this.watches is empty, and to allow the
            // cache to be garbage collected. If, however, we manage to call
            // recallCache(this) here, this cache object must not have been
            // garbage collected yet, and should resume receiving updates from
            // reactive variables, now that it has a watcher to notify.
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$reactiveVars$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["recallCache"])(this);
        }
        this.watches.add(watch);
        if (watch.immediate) {
            this.maybeBroadcastWatch(watch);
        }
        return function() {
            // Once we remove the last watch from this.watches, cache.broadcastWatches
            // no longer does anything, so we preemptively tell the reactive variable
            // system to exclude this cache from future broadcasts.
            if (_this.watches.delete(watch) && !_this.watches.size) {
                (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$reactiveVars$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["forgetCache"])(_this);
            }
            // Remove this watch from the LRU cache managed by the
            // maybeBroadcastWatch OptimisticWrapperFunction, to prevent memory
            // leaks involving the closure of watch.callback.
            _this.maybeBroadcastWatch.forget(watch);
        };
    };
    InMemoryCache.prototype.gc = function(options) {
        if (globalThis.__DEV__ !== false) {
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["warnRemovedOption"])(options || {}, "resetResultIdentities", "cache.gc", "First ensure all usages of `canonizeResults` are removed, then remove this option.");
        }
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canonicalStringify$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canonicalStringify"].reset();
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$print$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["print"].reset();
        var ids = this.optimisticData.gc();
        if (options && !this.txCount) {
            if (options.resetResultCache) {
                this.resetResultCache(options.resetResultIdentities);
            } else if (options.resetResultIdentities) {
                this.storeReader.resetCanon();
            }
        }
        return ids;
    };
    // Call this method to ensure the given root ID remains in the cache after
    // garbage collection, along with its transitive child entities. Note that
    // the cache automatically retains all directly written entities. By default,
    // the retainment persists after optimistic updates are removed. Pass true
    // for the optimistic argument if you would prefer for the retainment to be
    // discarded when the top-most optimistic layer is removed. Returns the
    // resulting (non-negative) retainment count.
    InMemoryCache.prototype.retain = function(rootId, optimistic) {
        return (optimistic ? this.optimisticData : this.data).retain(rootId);
    };
    // Call this method to undo the effect of the retain method, above. Once the
    // retainment count falls to zero, the given ID will no longer be preserved
    // during garbage collection, though it may still be preserved by other safe
    // entities that refer to it. Returns the resulting (non-negative) retainment
    // count, in case that's useful.
    InMemoryCache.prototype.release = function(rootId, optimistic) {
        return (optimistic ? this.optimisticData : this.data).release(rootId);
    };
    // Returns the canonical ID for a given StoreObject, obeying typePolicies
    // and keyFields (and dataIdFromObject, if you still use that). At minimum,
    // the object must contain a __typename and any primary key fields required
    // to identify entities of that type. If you pass a query result object, be
    // sure that none of the primary key fields have been renamed by aliasing.
    // If you pass a Reference object, its __ref ID string will be returned.
    InMemoryCache.prototype.identify = function(object) {
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$graphql$2f$storeUtils$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isReference"])(object)) return object.__ref;
        try {
            return this.policies.identify(object)[0];
        } catch (e) {
            globalThis.__DEV__ !== false && __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$globals$2f$invariantWrappers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["invariant"].warn(e);
        }
    };
    InMemoryCache.prototype.evict = function(options) {
        if (!options.id) {
            if (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$helpers$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasOwn"].call(options, "id")) {
                // See comment in modify method about why we return false when
                // options.id exists but is falsy/undefined.
                return false;
            }
            options = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                id: "ROOT_QUERY"
            });
        }
        try {
            // It's unlikely that the eviction will end up invoking any other
            // cache update operations while it's running, but {in,de}crementing
            // this.txCount still seems like a good idea, for uniformity with
            // the other update methods.
            ++this.txCount;
            // Pass this.data as a limit on the depth of the eviction, so evictions
            // during optimistic updates (when this.data is temporarily set equal to
            // this.optimisticData) do not escape their optimistic Layer.
            return this.optimisticData.evict(options, this.data);
        } finally{
            if (!--this.txCount && options.broadcast !== false) {
                this.broadcastWatches();
            }
        }
    };
    InMemoryCache.prototype.reset = function(options) {
        var _this = this;
        this.init();
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$common$2f$canonicalStringify$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["canonicalStringify"].reset();
        if (options && options.discardWatches) {
            // Similar to what happens in the unsubscribe function returned by
            // cache.watch, applied to all current watches.
            this.watches.forEach(function(watch) {
                return _this.maybeBroadcastWatch.forget(watch);
            });
            this.watches.clear();
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$inmemory$2f$reactiveVars$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["forgetCache"])(this);
        } else {
            // Calling this.init() above unblocks all maybeBroadcastWatch caching, so
            // this.broadcastWatches() triggers a broadcast to every current watcher
            // (letting them know their data is now missing). This default behavior is
            // convenient because it means the watches do not have to be manually
            // reestablished after resetting the cache. To prevent this broadcast and
            // cancel all watches, pass true for options.discardWatches.
            this.broadcastWatches();
        }
        return Promise.resolve();
    };
    InMemoryCache.prototype.removeOptimistic = function(idToRemove) {
        var newOptimisticData = this.optimisticData.removeLayer(idToRemove);
        if (newOptimisticData !== this.optimisticData) {
            this.optimisticData = newOptimisticData;
            this.broadcastWatches();
        }
    };
    InMemoryCache.prototype.batch = function(options) {
        var _this = this;
        var update = options.update, _a = options.optimistic, optimistic = _a === void 0 ? true : _a, removeOptimistic = options.removeOptimistic, onWatchUpdated = options.onWatchUpdated;
        var updateResult;
        var perform = function(layer) {
            var _a = _this, data = _a.data, optimisticData = _a.optimisticData;
            ++_this.txCount;
            if (layer) {
                _this.data = _this.optimisticData = layer;
            }
            try {
                return updateResult = update(_this);
            } finally{
                --_this.txCount;
                _this.data = data;
                _this.optimisticData = optimisticData;
            }
        };
        var alreadyDirty = new Set();
        if (onWatchUpdated && !this.txCount) {
            // If an options.onWatchUpdated callback is provided, we want to call it
            // with only the Cache.WatchOptions objects affected by options.update,
            // but there might be dirty watchers already waiting to be broadcast that
            // have nothing to do with the update. To prevent including those watchers
            // in the post-update broadcast, we perform this initial broadcast to
            // collect the dirty watchers, so we can re-dirty them later, after the
            // post-update broadcast, allowing them to receive their pending
            // broadcasts the next time broadcastWatches is called, just as they would
            // if we never called cache.batch.
            this.broadcastWatches((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                onWatchUpdated: function(watch) {
                    alreadyDirty.add(watch);
                    return false;
                }
            }));
        }
        if (typeof optimistic === "string") {
            // Note that there can be multiple layers with the same optimistic ID.
            // When removeOptimistic(id) is called for that id, all matching layers
            // will be removed, and the remaining layers will be reapplied.
            this.optimisticData = this.optimisticData.addLayer(optimistic, perform);
        } else if (optimistic === false) {
            // Ensure both this.data and this.optimisticData refer to the root
            // (non-optimistic) layer of the cache during the update. Note that
            // this.data could be a Layer if we are currently executing an optimistic
            // update function, but otherwise will always be an EntityStore.Root
            // instance.
            perform(this.data);
        } else {
            // Otherwise, leave this.data and this.optimisticData unchanged and run
            // the update with broadcast batching.
            perform();
        }
        if (typeof removeOptimistic === "string") {
            this.optimisticData = this.optimisticData.removeLayer(removeOptimistic);
        }
        // Note: if this.txCount > 0, then alreadyDirty.size === 0, so this code
        // takes the else branch and calls this.broadcastWatches(options), which
        // does nothing when this.txCount > 0.
        if (onWatchUpdated && alreadyDirty.size) {
            this.broadcastWatches((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$tslib$40$2$2e$8$2e$1$2f$node_modules$2f$tslib$2f$tslib$2e$es6$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["__assign"])({}, options), {
                onWatchUpdated: function(watch, diff) {
                    var result = onWatchUpdated.call(this, watch, diff);
                    if (result !== false) {
                        // Since onWatchUpdated did not return false, this diff is
                        // about to be broadcast to watch.callback, so we don't need
                        // to re-dirty it with the other alreadyDirty watches below.
                        alreadyDirty.delete(watch);
                    }
                    return result;
                }
            }));
            // Silently re-dirty any watches that were already dirty before the update
            // was performed, and were not broadcast just now.
            if (alreadyDirty.size) {
                alreadyDirty.forEach(function(watch) {
                    return _this.maybeBroadcastWatch.dirty(watch);
                });
            }
        } else {
            // If alreadyDirty is empty or we don't have an onWatchUpdated
            // function, we don't need to go to the trouble of wrapping
            // options.onWatchUpdated.
            this.broadcastWatches(options);
        }
        return updateResult;
    };
    InMemoryCache.prototype.performTransaction = function(update, optimisticId) {
        return this.batch({
            update: update,
            optimistic: optimisticId || optimisticId !== null
        });
    };
    InMemoryCache.prototype.transformDocument = function(document) {
        return this.addTypenameToDocument(this.addFragmentsToDocument(document));
    };
    InMemoryCache.prototype.fragmentMatches = function(fragment, typename) {
        return this.policies.fragmentMatches(fragment, typename);
    };
    InMemoryCache.prototype.lookupFragment = function(fragmentName) {
        var _a;
        return ((_a = this.config.fragments) === null || _a === void 0 ? void 0 : _a.lookup(fragmentName)) || null;
    };
    InMemoryCache.prototype.broadcastWatches = function(options) {
        var _this = this;
        if (!this.txCount) {
            this.watches.forEach(function(c) {
                return _this.maybeBroadcastWatch(c, options);
            });
        }
    };
    InMemoryCache.prototype.addFragmentsToDocument = function(document) {
        var fragments = this.config.fragments;
        return fragments ? fragments.transform(document) : document;
    };
    InMemoryCache.prototype.addTypenameToDocument = function(document) {
        if (this.addTypename) {
            return this.addTypenameTransform.transformDocument(document);
        }
        return document;
    };
    // This method is wrapped by maybeBroadcastWatch, which is called by
    // broadcastWatches, so that we compute and broadcast results only when
    // the data that would be broadcast might have changed. It would be
    // simpler to check for changes after recomputing a result but before
    // broadcasting it, but this wrapping approach allows us to skip both
    // the recomputation and the broadcast, in most cases.
    InMemoryCache.prototype.broadcastWatch = function(c, options) {
        var _this = this;
        var lastDiff = c.lastDiff;
        // Both WatchOptions and DiffOptions extend ReadOptions, and DiffOptions
        // currently requires no additional properties, so we can use c (a
        // WatchOptions object) as DiffOptions, without having to allocate a new
        // object, and without having to enumerate the relevant properties (query,
        // variables, etc.) explicitly. There will be some additional properties
        // (lastDiff, callback, etc.), but cache.diff ignores them.
        var diff = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$deprecation$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["muteDeprecations"])("canonizeResults", function() {
            return _this.diff(c);
        });
        if (options) {
            if (c.optimistic && typeof options.optimistic === "string") {
                diff.fromOptimisticTransaction = true;
            }
            if (options.onWatchUpdated && options.onWatchUpdated.call(this, c, diff, lastDiff) === false) {
                // Returning false from the onWatchUpdated callback will prevent
                // calling c.callback(diff) for this watcher.
                return;
            }
        }
        if (!lastDiff || !(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$wry$2b$equality$40$0$2e$5$2e$7$2f$node_modules$2f40$wry$2f$equality$2f$lib$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["equal"])(lastDiff.result, diff.result)) {
            c.callback(c.lastDiff = diff, lastDiff);
        }
    };
    return InMemoryCache;
}(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$cache$2f$core$2f$cache$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ApolloCache"]);
;
if (globalThis.__DEV__ !== false) {
    InMemoryCache.prototype.getMemoryInternals = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$apollo$2b$client$40$3$2e$14$2e$0_$40$types$2b$react$40$19$2e$2$2e$7_graphql$2d$ws$40$5$2e$16$2e$2_graphql$40$16$2e$12$2e$0_$5f$graphql$40$16$2e$12$2e$0_$5f$tbq6iuuvyf5o7vygi75isfjkly$2f$node_modules$2f40$apollo$2f$client$2f$utilities$2f$caching$2f$getMemoryInternals$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getInMemoryCacheMemoryInternals"];
} //# sourceMappingURL=inMemoryCache.js.map

})()),
}]);

//# sourceMappingURL=bddf7_%40apollo_client_cache_5dfcbf._.js.map