# CRAWL-METADATA-001 · 网页元数据预览

- 状态reserved；2026-10-18按用户继续并行任务要求认领并发出，不实施业务或操作编码对话。
- 基线origin/main 9d0462e16d88d146b8afbf67cdd58d8b7419ff29；#69 merged，main最近五次CI成功；对照3cedce9a无候选业务变动。
- 分支refactor/go-crawl-metadata；worktree /Users/oo/project/newwei-go-crawl-metadata，规划时未创建。
- [完整提示词](CRAWL-METADATA-001.prompt.md)；记录发布至[Ready规划PR #71](https://github.com/wei500L/newwei/pull/71)，非业务交付。

## 精确范围与事实

POST /api/crawl-tasks/metadata（crawl.read，201，{orgId,total,results}）及Query crawlMetadata(input:CrawlMetadataInput!):[CrawlMetadataResultModel!]!（crawl.read，列表）。两入口调用extract，仅urls/sitemap；没有RSS/list/deep/crawl4ai调用，不能把服务中未被该入口调用的方法全部迁移。

本次限定深读Nest Controller/Resolver/DTO/models/types、normalize/resolve/robots/sitemap/XML与新闻时间字段、fetchWithStatus/fetchMaybe/条件缓存、parseMetadata/评分/并发；核对URL validator与Go newssources私有URL校验、Registry/SDL、main/wire、精确路由、现有远端依赖生成通道。REST与GraphQL验证差异明确，逐URL失败与输入失败分开。Go尚无两入口业务/Registry，SDL已有不等于实现。

## 所有权与依赖

新internal/crawlmetadata、graphqlread/crawlmetadata、cmd/api/crawl_metadata.go、legacyproxy规则；newssources仅窄URL校验导出。HTTP独立API_GO_CRAWL_METADATA_MODE；GraphQL子开关API_GO_GRAPHQL_CRAWL_METADATA_MODE仅依赖READ。默认legacy，非法值启动失败。HTTP只用DB/JWT/Redis鉴权与公网HTTP/DNS；GraphQL父READ另需Mongo，业务无Mongo/DB写、无BullMQ/cron/crawl4ai/S3。

避开#70工作台写、#72简报、STORAGE-MEDIA-001、ITEMS-LIST-001、AUTH-LOGIN-001核心文件；GraphQL注册放settingscrawl之外，不触碰S3注册Options或contract/exec。共享main/config/compose仅本批语义增量。依赖清单按模块条目：本批HTML解析x/net与必要关联，S3任务AWS SDK；各分支正常远端再生成，后合者merge主线后取并集，不能覆盖对方清单。官方HTML5解析器文档已查，不指定未经核实的版本；本机不安装。

## 占用与验证边界

发出前#70仍OPEN/Ready head adb765d0；新增#72 OPEN/Ready head517a73f9，实际main/config及文件diff已读，普通CI当时verify运行中，不宣称全部通过。S3与items目录已有开发，登录目录已创建且当时干净，均保留占用。未创建本业务worktree、无本批业务PR/实现/合并/生产启用。

仅静态核实，无本机build/test、依赖安装、服务、真实站点/Redis请求。保留必要SSRF/权限，不新增防御框架；具体优化为一次HTML DOM解析及head遍历。编码窗口只PR交付说明，共享地图由规划窗口回填。
