# personal · 个人设置、阅读工作台与公共门户

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

个人 UI 六读六写、订阅/画像/摘要、公共门户四条 GET 已注册。公共故事 brief 缓存缺失可能调用模型并写回；推荐目录可能访问向量/嵌入，并非全部纯本地读取。

关键数据与副作用：MySQL UserSetting/内容订阅/行为/投递设置、Mongo 新闻、Redis、Elasticsearch、vector/model-service、LiteLLM。UserSetting 六种 UI 读写共用八个 key。邮件投递 scheduler 仍为 Nest。

真实剩余缺口：本表范围均有 Go 路由，但邮件投递 Cron、模型冷路径真实调用和生产流量仍需独立处理；不因 HTTP 入口齐备宣称个人域端到端迁完。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：首次基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；14:18 MSK 最新 main [CI 39122519950](https://github.com/wei500L/newwei/actions/runs/39122519950) 进行中，不能继承旧结果。#68 的 PR head a1c96172 普通 CI 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

Nest 功能目录：[user-settings](../../../../apps/api/src/modules/user-settings)、[user-content-subscriptions](../../../../apps/api/src/modules/user-content-subscriptions)、[user-news-behavior](../../../../apps/api/src/modules/user-news-behavior)、[user-digest](../../../../apps/api/src/modules/user-digest)、[public-portal](../../../../apps/api/src/modules/public-portal)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [UserSettingsRead](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_USER_SETTINGS_READ_MODE` | [usersettingsread](../../../../apps/api-go/internal/usersettingsread) | `go` |
| [UserSettingsWrite](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_USER_SETTINGS_WRITE_MODE` | [usersettingswrite](../../../../apps/api-go/internal/usersettingswrite) | `go` |
| [WithContentSubscriptions](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_CONTENT_SUBSCRIPTIONS_MODE` | [contentsubscriptions](../../../../apps/api-go/internal/contentsubscriptions) / [contentcatalog](../../../../apps/api-go/internal/contentcatalog) | `legacy` |
| [WithPublicPortal](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_PUBLIC_PORTAL_MODE` | [publicportal](../../../../apps/api-go/internal/publicportal) | `go` |
| [WithUserDigest](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_USER_DIGEST_MODE` | [userdigest](../../../../apps/api-go/internal/userdigest) | `legacy` |
| [WithUserNewsBehavior](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_USER_NEWS_BEHAVIOR_MODE` | [newsbehavior](../../../../apps/api-go/internal/newsbehavior) | `legacy` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

历史兼容例外：API_GO_USER_SETTINGS_READ_MODE 默认空，onboarding 由 API_GO_ONBOARDING_MODE（默认 shadow）控制；rss-reader/spacetime-timeline 默认 shadow，其他三个默认 legacy。读可设 shadow/go，写模式 go 要求读 go。`GET /api/healthz/live` 不在个人域。

## 精确 HTTP 清单

分母 31：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/public-portal/channels/:topic` | 公开 | [public-portal.controller.ts](../../../../apps/api/src/modules/public-portal/public-portal.controller.ts) · `getChannel` | WithPublicPortal |
| `GET /api/public-portal/home` | 公开 | [public-portal.controller.ts](../../../../apps/api/src/modules/public-portal/public-portal.controller.ts) · `getHome` | WithPublicPortal |
| `GET /api/public-portal/stories/id/:id` | 公开 | [public-portal.controller.ts](../../../../apps/api/src/modules/public-portal/public-portal.controller.ts) · `getStoryById` | WithPublicPortal |
| `GET /api/public-portal/stories/slug/:slug` | 公开 | [public-portal.controller.ts](../../../../apps/api/src/modules/public-portal/public-portal.controller.ts) · `getStoryBySlug` | WithPublicPortal |
| `GET /api/user-content-subscriptions` | items.read | [user-content-subscriptions.controller.ts](../../../../apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts) · `list` | WithContentSubscriptions |
| `POST /api/user-content-subscriptions/batch-delete` | items.read | [user-content-subscriptions.controller.ts](../../../../apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts) · `batchDelete` | WithContentSubscriptions |
| `POST /api/user-content-subscriptions/batch-upsert` | items.read | [user-content-subscriptions.controller.ts](../../../../apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts) · `batchUpsert` | WithContentSubscriptions |
| `GET /api/user-content-subscriptions/catalog` | items.read | [user-content-subscriptions.controller.ts](../../../../apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts) · `catalog` | WithContentSubscriptions |
| `POST /api/user-content-subscriptions/catalog/lookup` | items.read | [user-content-subscriptions.controller.ts](../../../../apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts) · `lookup` | WithContentSubscriptions |
| `GET /api/user-content-subscriptions/recommendations` | items.read | [user-content-subscriptions.controller.ts](../../../../apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts) · `recommendations` | WithContentSubscriptions |
| `GET /api/user-content-subscriptions/related-topics` | items.read | [user-content-subscriptions.controller.ts](../../../../apps/api/src/modules/user-content-subscriptions/user-content-subscriptions.controller.ts) · `relatedTopics` | WithContentSubscriptions |
| `GET /api/user-digest` | items.read | [user-digest.controller.ts](../../../../apps/api/src/modules/user-digest/user-digest.controller.ts) · `getDigest` | WithUserDigest |
| `GET /api/user-digest/delivery` | items.read | [user-digest.controller.ts](../../../../apps/api/src/modules/user-digest/user-digest.controller.ts) · `getDelivery` | WithUserDigest |
| `PUT /api/user-digest/delivery` | items.read | [user-digest.controller.ts](../../../../apps/api/src/modules/user-digest/user-digest.controller.ts) · `updateDelivery` | WithUserDigest |
| `GET /api/user-digest/preference` | items.read | [user-digest.controller.ts](../../../../apps/api/src/modules/user-digest/user-digest.controller.ts) · `getPreference` | WithUserDigest |
| `PUT /api/user-digest/preference` | items.read | [user-digest.controller.ts](../../../../apps/api/src/modules/user-digest/user-digest.controller.ts) · `updatePreference` | WithUserDigest |
| `POST /api/user-news-behavior` | items.read | [user-news-behavior.controller.ts](../../../../apps/api/src/modules/user-news-behavior/user-news-behavior.controller.ts) · `record` | WithUserNewsBehavior |
| `DELETE /api/user-news-behavior/profile` | items.read | [user-news-behavior.controller.ts](../../../../apps/api/src/modules/user-news-behavior/user-news-behavior.controller.ts) · `clearProfile` | WithUserNewsBehavior |
| `GET /api/user-news-behavior/profile` | items.read | [user-news-behavior.controller.ts](../../../../apps/api/src/modules/user-news-behavior/user-news-behavior.controller.ts) · `profile` | WithUserNewsBehavior |
| `GET /api/user-settings/ui/newsnow` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `getNewsnowUiSettings` | UserSettingsRead |
| `PUT /api/user-settings/ui/newsnow` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `updateNewsnowUiSettings` | UserSettingsWrite |
| `GET /api/user-settings/ui/onboarding` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `getOnboardingUiSettings` | UserSettingsRead |
| `PUT /api/user-settings/ui/onboarding` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `updateOnboardingUiSettings` | UserSettingsWrite |
| `GET /api/user-settings/ui/rss-reader` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `getRssReaderUiSettings` | UserSettingsRead |
| `PUT /api/user-settings/ui/rss-reader` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `updateRssReaderUiSettings` | UserSettingsWrite |
| `GET /api/user-settings/ui/situation-monitor` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `getSituationMonitorUiSettings` | UserSettingsRead |
| `PUT /api/user-settings/ui/situation-monitor` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `updateSituationMonitorUiSettings` | UserSettingsWrite |
| `GET /api/user-settings/ui/spacetime-timeline` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `getSpacetimeTimelineUiSettings` | UserSettingsRead |
| `PUT /api/user-settings/ui/spacetime-timeline` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `updateSpacetimeTimelineUiSettings` | UserSettingsWrite |
| `GET /api/user-settings/ui/war-map` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `getWarMapUiSettings` | UserSettingsRead |
| `PUT /api/user-settings/ui/war-map` | items.read | [user-ui-settings.controller.ts](../../../../apps/api/src/modules/user-settings/user-ui-settings.controller.ts) · `updateWarMapUiSettings` | UserSettingsWrite |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#14](https://github.com/wei500L/newwei/pull/14) | [3cf22dae1bb4](https://github.com/wei500L/newwei/commit/3cf22dae1bb4fbda85c8419e1c66f77ff794dbb0) | feat(api-go): onboarding 用户设置 GET 进入 shadow |
| [#15](https://github.com/wei500L/newwei/pull/15) | [683befcffdf3](https://github.com/wei500L/newwei/commit/683befcffdf383ef84182d3b6bed10b98b727ebb) | feat(api-go): RSS Reader 与 Spacetime 设置 GET 进入 shadow |
| [#16](https://github.com/wei500L/newwei/pull/16) | [503c3696b0bd](https://github.com/wei500L/newwei/commit/503c3696b0bdce396261f1eb671042cd584a9955) | feat(api-go): 接入真实 API 入口并闭环 shadow |
| [#18](https://github.com/wei500L/newwei/pull/18) | [a852620c3fd9](https://github.com/wei500L/newwei/commit/a852620c3fd9c03e2f6161d1cbf1a6d6873afa70) | feat(api-go): 完成 user-settings 只读域 Go 接管 |
| [#19](https://github.com/wei500L/newwei/pull/19) | [b2dff4a01594](https://github.com/wei500L/newwei/commit/b2dff4a01594a5d2e3c1475fe4a9efdf72576335) | feat(api-go): 完成 user-settings 六个 PUT 的 Go 写接管 |
| [#20](https://github.com/wei500L/newwei/pull/20) | [257571141272](https://github.com/wei500L/newwei/commit/257571141272d2a07b587fba204a08990c3777d1) | feat(api-go): 公开首页与频道由 Go 独立查询 MySQL |
| [#21](https://github.com/wei500L/newwei/pull/21) | [db39161054bb](https://github.com/wei500L/newwei/commit/db39161054bb6f4aa214413a0750f83b2ca199b6) | feat(api-go): 公开故事详情由 Go 独立查询并生成 brief |
| [#30](https://github.com/wei500L/newwei/pull/30) | [6fdd4c90b352](https://github.com/wei500L/newwei/commit/6fdd4c90b352bc4a3c5f31f9d72fccdd6e6b7687) | 🔐 feat(api-go): 接管个人订阅、行为画像与每日摘要 |

- [docs/refactor/go-personal-news-workspace.md](../../go-personal-news-workspace.md)

- [docs/refactor/api-go-four-mode.md](../../api-go-four-mode.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
