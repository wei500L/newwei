# Swagger UI 静态资源来源说明

本目录是 `swagger-ui-dist` 的裁剪副本，只保留 api-go 的 `/docs`（C-7）实际提供的文件。
不要在运行时从 CDN 加载任何资源：全部资源用 `go:embed` 打进 api-go 二进制。

## 版本与来源

- npm 包：`swagger-ui-dist@5.29.4`
- 版本依据：`pnpm-lock.yaml` 中 `@nestjs/swagger@11.2.1` 的依赖解析（`swagger-ui-dist: 5.29.4`），
  与 NestJS 当前 `/docs` 使用的资源版本一致。
- tarball：`https://registry.npmjs.org/swagger-ui-dist/-/swagger-ui-dist-5.29.4.tgz`
- tarball sha256：`9ce71c6a44f624079861db8329d76c2ee0c4ec37718a46638b2cf25f1b4f9a1d`
- 许可证：Apache-2.0，见同目录 `LICENSE` 与 `NOTICE`；`*.LICENSE.txt` 是 bundle 内附带的三方许可证清单。

## 保留的文件与用途

| 文件 | 用途 |
|---|---|
| `swagger-ui.css` | Swagger UI 样式 |
| `swagger-ui-bundle.js` | Swagger UI 主 bundle |
| `swagger-ui-bundle.js.LICENSE.txt` | bundle 内三方许可证 |
| `swagger-ui-standalone-preset.js` | StandaloneLayout 预设 |
| `swagger-ui-standalone-preset.js.LICENSE.txt` | 预设包三方许可证 |
| `favicon-16x16.png`、`favicon-32x32.png` | 页面 favicon（与 Nest 页面一致） |
| `oauth2-redirect.html`、`oauth2-redirect.js` | Swagger UI 的 OAuth2 回跳页（本 API 只用 Bearer，保留以对齐 Nest 的静态目录） |
| `LICENSE`、`NOTICE` | 上游许可证；不通过 HTTP 提供（Nest 对 `/docs/LICENSE` 也返回 404） |

未保留：source map、ES module 变体、`index.html`/`swagger-initializer.js` 模板（页面模板由
`internal/apidocs` 自己生成，以便把 `/docs/json` 指向嵌入的契约快照）、`@scarf/scarf`
（安装期统计依赖，运行期不需要）。

## 与 NestJS `/docs` 的关系

`@nestjs/swagger` 的 `SwaggerModule.setup("docs", …)` 把 `swagger-ui-dist` 目录挂在 `/docs`
前缀下，并用该目录的模板生成页面。api-go 的 `/docs` 复刻同样的路径集合（页面、`/docs/json`、
静态资源），但：

- OpenAPI 文档内容来自仓库内的 `apps/api/tests/contract/openapi.snapshot.json` 逐字节副本
  （见 `internal/apidocs/openapi.snapshot.json`），不从运行时生成；
- 页面标题为 `Swagger UI`，与 Nest 未设置 `customSiteTitle` 时一致；
- `/docs/swagger-ui-init.js` 由 Go 生成，`url` 指向 `/docs/json`，不内联 spec；
- Nest 默认还会提供 `/docs-yaml`（YAML 序列化）；本批只提供 JSON，差异记录在
  `docs/refactor/cutover/runbook.md` 与 PR 描述中。
