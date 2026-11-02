# 3D 地球 G0：引入 GEV 源码与构建配置

> **一句话目标**：
> - 把 GEV 锁定版本的源码以快照方式放进 `vendor/gods-eye-view/`；
> - 把它的运行时依赖加到 `apps/web`；
> - 配好 Next/webpack，让 `@gev/*` 能被客户端代码引用、Cesium 能正常加载静态资源；
> - 提供「不许碰到 `.vue`」的 import 检查脚本，并接入 CI。
>
> 本批**不写任何界面**，只验证「能编译」。
>
> **依赖**：无。**开工前必读**：本目录 README 全文。
>
> **特殊许可**：本批需要运行一次 `pnpm install` 来更新 `pnpm-lock.yaml`（用户已同意）。除此之外不运行 dev server，也不运行 docker。

## 任务

### 0.1 导入快照：脚本 `infra/scripts/src/globe-vendor.mts`

新建脚本，在根目录 `package.json` 加 `"globe:vendor": "tsx infra/scripts/src/globe-vendor.mts"`。用法：`pnpm globe:vendor <commit-sha>`。行为：

1. 下载 `https://codeload.github.com/bilawalsidhu/gods-eye-view/tar.gz/<sha>` 到系统临时目录下一个新建的空目录，然后解压。**不执行**里面任何脚本。
2. 把解压结果同步到 `vendor/gods-eye-view/`（先清空目标目录，但保留 `UPSTREAM.md`），**排除**：`docs/media/`、`.github/`、`.agents/`、`node_modules/`、`.env*`（`.env.example` 除外）。
3. 更新 `vendor/gods-eye-view/UPSTREAM.md` 顶部的「上游 commit」和「导入日期」两行。
4. 输出新增、删除、修改的文件数。

用这个脚本导入 `43a67f9ae224e7a1d6d32d81f690520f5c7f7f70`。

> 以后升级时，先在一个分支上运行脚本，再把 `UPSTREAM.md` 登记的本地补丁逐个重新打上。不用 `git subtree`，因为它会把约 120 MB 的历史带进仓库。

### 0.2 新建 `vendor/gods-eye-view/UPSTREAM.md`

内容包括：

- 上游地址
- 锁定的 commit
- 导入日期
- 排除清单
- 「本地补丁」表：表头为「文件 | 目的 | 摘要 | 批次」，本批为空
- 许可说明：代码 MIT；数据和模型按 `LICENSE`、`DATA_SOURCES.md`、`public/models/README.md` 各自的许可；非商用数据清单（抄 README §9）

### 0.3 工具链隔离

- `vendor/` 本来就不在 `pnpm-workspace.yaml` 的匹配范围里，**不要**把它加进去。
- 根目录 `package.json` 的 `lint-staged` 两条规则都要排除 `vendor/**`（改用带否定的 glob，或用 `lint-staged` 的函数式配置过滤路径）。
- 新建或追加 `.prettierignore`：写入 `vendor/`。
- `.gitattributes` 追加：`vendor/** linguist-vendored` 和 `vendor/**/*.geojsonl -diff`。

### 0.4 `apps/web/package.json` 依赖

把 GEV `package.json` 中 `dependencies` 的 14 个包按**相同的版本范围**加入 `apps/web` 的 `dependencies`：

`@jtarrio/signals`、`@jtarrio/webrtlsdr`、`@mapbox/vector-tile`、`@meri-imperiumi/eccodes-wasm`、`cesium`、`egm96-universal`、`hls.js`、`mapillary-js`、`mgrs`、`pbf`、`pinia`、`satellite.js`、`vue`、`vue-i18n`

> `vue` 和 `pinia` 是必需的：部分图层（例如 `layers/wind`）内部用 Pinia 仓库保存状态，即使我们不渲染任何 Vue 组件。

然后在仓库根目录运行 `pnpm install`，**只提交** `apps/web/package.json` 和 `pnpm-lock.yaml` 的变化。

同时新增脚本：

```json
"globe:assets": "node scripts/copy-cesium-assets.mjs",
"globe:check-imports": "node scripts/globe-check-imports.mjs",
"predev": "node scripts/copy-cesium-assets.mjs",
"prebuild": "node scripts/copy-cesium-assets.mjs"
```

（如果 `predev` / `prebuild` 已经存在，就用 `&&` 串接，不要覆盖。）

### 0.5 `apps/web/scripts/copy-cesium-assets.mjs`

- 把 `node_modules/cesium/Build/Cesium/` 下的 `Workers`、`ThirdParty`、`Assets`、`Widgets` 四个目录复制到 `apps/web/public/cesium/`。
- 用 `fs.cpSync(..., { recursive: true })`。
- 目标目录已存在且 `public/cesium/.version` 与 `cesium/package.json` 的版本一致时，跳过复制。
- 在 `apps/web/.gitignore`（没有就新建）写入 `public/cesium/`。

### 0.6 `apps/web/next.config.mjs`

在现有 `nextConfig` 上**追加**（不要动现有字段）：

```js
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const webRoot = dirname(fileURLToPath(import.meta.url));
const gevSrc = resolvePath(webRoot, "../../vendor/gods-eye-view/src");

// nextConfig 内：
experimental: {
  ...(nextConfig.experimental ?? {}),
  externalDir: true, // 允许编译 apps/web 目录之外的 vendor 源码
},
webpack(config, { isServer }) {
  config.resolve.alias = {
    ...(config.resolve.alias ?? {}),
    "@gev": gevSrc,
  };
  // vendor 源码里的裸 import（cesium、pinia…）从 apps/web/node_modules 解析，保证 Cesium 只有一份实例
  config.resolve.modules = [
    ...(config.resolve.modules ?? ["node_modules"]),
    resolvePath(webRoot, "node_modules"),
  ];
  config.module.unknownContextCritical = false; // Cesium 的已知 webpack 警告
  config.ignoreWarnings = [
    ...(config.ignoreWarnings ?? []),
    { module: /vendor[\\/]gods-eye-view/ },
    { module: /node_modules[\\/]cesium/ },
  ];
  if (isServer) {
    // GEV 只在客户端运行；万一被服务端引用，直接构建失败，比运行时报 window 未定义更早暴露
    config.resolve.alias["@gev"] = false;
  }
  return config;
},
```

- 如果 `nextConfig` 已经有 `webpack` 字段，要合并，不要覆盖。
- `isServer` 时把 `@gev` 设为 `false`，会让服务端打包中的 `@gev` import 解析为空模块。这要求所有使用方都通过 `next/dynamic({ ssr: false })` 加载（README §5-3）。

### 0.7 类型声明 `apps/web/types/gev.d.ts`

```ts
// GEV 是无类型的 JS。只做最宽松的声明；我们在 lib/globe/engine-types.ts 里为实际用到的接口写窄类型（G2）。
declare module "@gev/*";
```

确认 `tsconfig.json` 的 `include` 覆盖了 `types/**/*.d.ts`。**不要**在 `tsconfig.json` 的 `paths` 里加 `@gev`：一旦能解析到 `.js` 文件，TypeScript 会报 TS7016，而不会使用上面这条宽松声明。

ESLint：如果 `import/no-unresolved` 报 `@gev/...`，在 `apps/web/.eslintrc.*` 的 `rules` 中给该规则加 `{ ignore: ["^@gev/"] }`。

### 0.8 import 白名单检查脚本 `apps/web/scripts/globe-check-imports.mjs`

用纯 Node 实现，不引入依赖：

1. 扫描 `apps/web/{app,components,lib,hooks}` 下所有 `.ts`、`.tsx`，用正则收集 `from "@gev/..."` 和 `import("@gev/...")` 的模块说明符。
2. 把每个说明符解析为 `vendor/gods-eye-view/src/<path>`（补 `.js` 后缀）。
3. 从这些入口开始做深度优先遍历，跟随**相对路径**的静态 import、re-export 和字面量动态 import（正则即可）；裸包名不跟。
4. 一旦遍历到 `.vue` 文件，打印完整链路（`入口 → … → X.vue`）并以退出码 1 结束。
5. 另外维护一个**黑名单**，至少包含 `app/application.js`、`app/data.js`、`app/controls.js`、`ui/composition.js`、`hud.js`、`ui/applicationShell.js`、`main.js`、`standalone/application.js`。遍历中碰到其中任何一个也算失败。
6. 没有任何 `@gev` 引用时输出 `0 entries` 并成功退出（本批就是这种情况）。

为它写一个 Vitest 测试 `apps/web/scripts/globe-check-imports.test.mjs`：

- 在临时目录里造一个迷你的 vendor 树和 app 树，分别验证三种情况：遇到 `.vue` 失败、遇到黑名单模块失败、干净时成功。
- 脚本需要导出一个可测试的函数，例如 `checkGevImports({ appRoots, vendorSrc })`。
- 如果 `vitest.config.ts` 的 `include` 不收 `scripts/`，就加上这个测试文件的路径（只追加）。

### 0.9 CI（`.github/workflows/ci.yml`）

在 web 的 verify 步骤后追加一步：`pnpm --filter @modular/web globe:check-imports`。

另外新增一个独立 job `globe-vendor`：

- 只在 `vendor/gods-eye-view/**` 有变化时运行（用 `dorny/paths-filter`，或者参照本仓库已有的路径过滤写法）；
- 使用 Node 24，`working-directory: vendor/gods-eye-view`；
- 依次运行：`npm ci --ignore-scripts`、`npm run check:boundaries`、`npm run format:check`；
- 先不跑它的全量单元测试，在注释里说明原因：它的测试依赖 git fixture，耗时也较长。G6 打补丁时再按需加上被补丁的测试文件。

---

## 禁止事项

- 不写 `/globe` 页面，也不引用任何 `@gev/*` 模块（这些属于 G2）。
- 不修改 vendor 里的任何文件（`UPSTREAM.md` 除外）。
- 不改 `pnpm-workspace.yaml`。

## 验证

- README §6 全部命令。其中 `build` 必须通过：此时还没有任何 `@gev` 引用，验证的是配置本身没有破坏构建。
- `git diff --stat` 应该只包含：`vendor/gods-eye-view/**`（快照）、`infra/scripts/src/globe-vendor.mts`、根 `package.json`、`.gitattributes`、`.prettierignore`、`apps/web/{package.json,next.config.mjs,types/gev.d.ts,scripts/*,.gitignore}`、`pnpm-lock.yaml`、`.github/workflows/ci.yml`，以及可能的 `.eslintrc`、`vitest.config.ts`。

## 提交（分 2 次）

1. `📦 chore(vendor): 引入 gods-eye-view 43a67f9 快照与同步脚本`（只包含 vendor 和脚本，便于审查）
2. `🔧 build(web): 3D 地球 G0 依赖、webpack 别名、Cesium 静态资源与 import 白名单检查`
