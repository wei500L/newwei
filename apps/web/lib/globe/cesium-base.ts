// Cesium 通过 window.CESIUM_BASE_URL 定位 Workers / Assets / Widgets 等静态资源。
// G0 把 Cesium 的四个资源目录复制到了 apps/web/public/cesium/（见
// scripts/copy-cesium-assets.mjs），所以这里指向 "/cesium/"。
//
// 这一句必须早于任何 `cesium` / `@gev/*` 的 import 求值：ES import 会被提升，
// 因此单独放在本模块里，并由 runtime.ts 的**第一条** import 引入。若日后有
// 别的文件直接 import `cesium`，也要先 import 本模块。
if (typeof window !== "undefined") {
  window.CESIUM_BASE_URL = "/cesium/";
}

declare global {
  interface Window {
    /** Cesium 的静态资源前缀。 */
    CESIUM_BASE_URL?: string;
    /** 开发环境下挂载的运行时实例（仅非 production）。 */
    __newweiGlobe?: unknown;
    /** GEV 用它读取浏览器端 Google Maps 密钥（见 app/scene.js）。 */
    __GOOGLE_MAPS_API_KEY__?: string;
  }
}

export {};
