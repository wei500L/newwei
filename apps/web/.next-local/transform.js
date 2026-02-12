const CHUNK_PUBLIC_PATH = "transform.js";
const runtime = require("./chunks/[turbopack]_runtime.js");
runtime.loadChunk("chunks/[root of the server]__03e415._.js");
runtime.loadChunk("chunks/postcss_config_js_transform_ts_3cacb2._.js");
runtime.getOrInstantiateRuntimeModule("[turbopack-node]/globals.ts [postcss] (ecmascript)", CHUNK_PUBLIC_PATH);
module.exports = runtime.getOrInstantiateRuntimeModule("[turbopack-node]/ipc/evaluate.ts/evaluate.js { INNER => \"[project]/apps/web/postcss.config.js/transform.ts { CONFIG => \\\"[project]/apps/web/postcss.config.js_.loader.mjs [postcss] (ecmascript)\\\" } [postcss] (ecmascript)\", RUNTIME => \"[turbopack-node]/ipc/evaluate.ts [postcss] (ecmascript)\" } [postcss] (ecmascript)", CHUNK_PUBLIC_PATH).exports;
