你在 newwei 的独立编码窗口执行 `MONITOR-GEOCODING-001`。直接修复态势监控地点解析绕过系统地理编码的问题，贯通配置、共享缓存/限速、监控预览/创建/更新与 Web 使用，提交并 push，创建 Ready PR；不要停在方案，不合并、不启用 auto-merge。Go 迁移退役已经完成，不恢复 Node 或迁移分流。

先读仓库 AGENTS.md、`docs/refactor/migration-map/README.md`、`PLANNING.md` 和本 task。规划记录与提示词在 `codex/plan-go-cutover-next` / 规划 PR #149；未合入 main 时从该分支只取本 task/提示词，不合并整条规划分支。fetch 最新 main，检查开放 PR、worktree 与认领；匹配任务工作树可复用，否则建独立工作树，分支建议 `codex/fix-monitor-geocoding`。核对基线 `e04fc4d8bb54596afd302a309ebc852c7676d958`，不能据旧 checkout 判断当前状态。

已确认根因与入口：

- `internal/situationmonitors/location.go` 的 `geocode` 硬编码公网 Nominatim URL 和 User-Agent，`service.go` 自建 HTTP client，`cmd/api/situation_monitors.go` 的 `NewService(db)` 没有共享地理编码依赖。对应复核 M-04 / `GAP-MONITOR-GEOCODING-001`。
- 已有 `internal/geocoding/geocode.go`：`Client.Geocode`、Redis 正/负缓存、`rate:geocode:nominatim` 全局窗口与 `SQLSettingsReader`。生产配置参考 `cmd/api/settings_diagnostics.go` 的 `wireGeocoding`，包括 BaseURL/UserAgent/Email/AcceptLanguage、Timeout、CacheTTL/NegativeTTL、RatePerSecond。
- 系统设置 UI 已能保存 User-Agent/email；BaseURL 等来自现有运行配置，不要误当成 UI 已有字段。监控 Web 使用 `apps/web/app/(app)/situation-monitor/situation-monitor-monitors-panel.tsx`，预览返回 `locationResolution`，提交沿用地点名/坐标/country。

完成以下同一条产品链：

1. 为监控 Service 注入合适的具名、窄接口地理编码依赖，把地点解析接到已有 `Client.Geocode` 语义与真实生产配置。可以复用现有实例或相同配置的实例，但 Redis 缓存/全局限速和 SQL 身份设置必须共用；不能另造一套缓存、限速或固定 HTTP fallback。改造构造器时检查全部调用点，生产 preview/create/update 不能遗漏接线。
2. 最小修改 `wireSituationMonitors` 与 main 调用以传入所需资源；配置、资源校验与普通 geocoding 一致。移除监控的硬编码请求实现和无用 HTTP client。不要通过调用自身 `POST /api/geo/geocode` 复用逻辑，不新增后台任务、迁移开关或通用依赖注入框架。
3. 保持 `resolveLocation` 可观察语义：名称/国家归一化、明确传入的 country 处理、显式坐标优先、缺失坐标由命中补齐、country/bounds 映射、无结果与无效坐标处理。现有逻辑即使有坐标仍可能查询 country/bounds，不能把“有坐标就跳过”当无影响优化。缓存/上游临时失败按现有可恢复行为处理，不能丢弃已提供的有效坐标，也不能把超时/5xx/限速当确定查无地点永久负缓存。复用共享客户端规则，不改变 war-map `Resolve` 的独立 transient 策略。
4. 覆盖三个实际入口：`POST /api/situation-monitor/monitors/preview`、`POST /api/situation-monitor/monitors`、`PATCH /api/situation-monitor/monitors/:id`。预览、保存、读取的地点与 country/bounds 一致；重复请求复用缓存并共同消耗既有全局额度。保持 handler 状态码/DTO、认证、orgId/userId 归属、手动监控限额/系统只读、现有锁/迁移与内容订阅对账，不扩大成监控服务重构。
5. 核对现有设置面板、监控编辑器的预览 → 确认 → 创建/编辑 → 展示链路。必要时修正 locationResolution 到保存 payload/展示的类型和行为，保留既有交互；UI 不需要新增设置页或 BaseURL 输入。若现有 UI 已满足要求，用行为测试证明正确：用户预览地点后保存，发出的地点名/坐标/country 与响应一致；编辑后重新预览/保存也正确，无命中时遵循现有提示和提交规则。避免只改 backend 却放任实际 UI 链路断裂。
6. 添加必要测试，以 httptest fake Nominatim、受控设置与既有 CI Redis/MySQL 证明真实接线：配置 URL/请求身份/国家/语言，预览后保存命中缓存，确定无结果的负缓存，临时失败不会污染负缓存，共享限速，显式坐标与边界映射，跨 org/user 拒绝访问。共享客户端已有规则测试可复用，不堆重复测试；没有覆盖的监控集成加入现有普通 CI 步骤，确保 `-tags=integration` 和 `-run 'Integration'` 等选择器实际执行，不只创建未运行文件。测试不得访问公网 Nominatim 或真实 LLM。

权限与所有权：

- 普通监控请求沿用现有权限，不附加地理编码 REST 的 `items.read` 或管理诊断的 `settings.manage`。`POST /api/geo/geocode` 与 `POST /api/system-settings/geo/nominatim/test` 保持各自原有鉴权；管理 `Probe` 的诊断行为不能被普通监控复用替代。
- 本任务拥有 situationmonitors、必要的 geocoding 与 Web 监控/已有设置面板，Go main 仅该 wiring 调用，CI 仅现有集成 job 必要增量。另一个窗口 `CRAWL-TABLE-NORMALIZATION-001` 拥有采集域与采集 UI；不触及这些路径、不重写共用启动器/CI/config。
- 只更新本 task 与 PR，不改共享迁移地图、GAPS、统计或任务索引。不提交/清理别人的脏文件；遇到确需越界的具体阻塞先协调所有权。
- 新业务 DTO/接口/缓存投影用具名强类型，不使用 `any/interface{}/map[string]any/[]any` 承载新增业务数据；JSON 协议叶子可用 `json.RawMessage`。不安装包、不为凑范围增加锁、重试、熔断、通用框架或专用 smoke workflow。

验证与交付：

- 本机不安装依赖，不运行 build/test/lint/typecheck/vet/Docker/服务；仅静态检查、diff 检查与必要格式化。测试在已有普通 GitHub Actions CI 运行。新增/修改源码注释用英文，文档、提交与 PR 中文。
- 做纯静态审查并反向复核：类型/JSON/API 契约、错误/取消路径、缓存和 limiter 生产接线、全部构造器调用点、orgId/userId 与权限边界；结论保留 `file:line` 证据，参照 `.workflow/reviews/static-audit.md`，修复本范围发现的问题。
- 只 stage 自己的改动，中文 emoji + `type(scope)` 正常 commit/push，不 amend/rebase/force-push，创建 Ready PR。说明硬编码前后的具体行为、配置生效范围、缓存/失败语义、UI 覆盖和验证限制。
- 等最终精确 head 的普通 CI，修复本范围失败再正常提交；记录 lint/typecheck、Web coverage、相关 Go 单元/地理编码与监控集成实际步骤及链接。Node vector app 已删除，不执行旧命令、不削弱已有 Go vector 门禁。skipped 不算通过，源 head 不代替 merge head，fake 上游不等于实网验证。
- 最终返回 Ready PR、head、普通 CI 链接/结果、静态审查结论和未验证边界；task 回填实际状态。不部署、不连接真实外部服务。
