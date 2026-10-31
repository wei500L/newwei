# MONITOR-GEOCODING-001 · 监控地点解析接入系统地理编码

- 状态：`reserved`；2026-11-01 已提供[执行提示词](MONITOR-GEOCODING-001.prompt.md)，尚无编码 PR/head/CI 证据。
- 缺口：`GAP-MONITOR-GEOCODING-001`，对应[态势复核 M-04](../../review/situation-realtime.md)。
- 核对基线：main `e04fc4d8bb54596afd302a309ebc852c7676d958`；[普通 CI 41242463081](https://github.com/wei500L/newwei/actions/runs/41242463081) 三主 job success，两个 regen skipped。开工重新 fetch 并检查认领。
- 分支建议：`codex/fix-monitor-geocoding`；复用匹配的独立工作树，否则创建。当前尚未创建该业务 worktree。
- 根因证据：`apps/api-go/internal/situationmonitors/location.go` 的 `geocode` 直接请求固定 Nominatim URL/UA；`service.go` 自建 HTTP client；`cmd/api/situation_monitors.go:20` 未注入已有共享 geocoder。系统配置、Redis 正/负缓存及全局限速均被绕过。
- 可复用实现：`internal/geocoding/geocode.go` 的 `Client.Geocode`、`RedisCache`、`SQLSettingsReader`；生产配置参考 `cmd/api/settings_diagnostics.go` 的 `wireGeocoding`，使用现有 `Nominatim*` / `Geocode*` config。
- 产品链：系统 User-Agent/email 设置及环境 BaseURL 等配置 → 共享缓存/限速的地点解析 → 监控 preview/create/update → 持久化与 Web 编辑/展示。不是新增地理编码产品或给监控增加设置管理权限。
- 所有权：`internal/situationmonitors`、必要的 `internal/geocoding`、`cmd/api/situation_monitors.go`、`cmd/api/main.go` 中该调用的最小接线；Web `situation-monitor-monitors-panel.tsx`、对应 types/测试和必要的现有设置面板；CI 仅在缺少执行覆盖时扩展既有集成步骤。
- 并行边界：可与 `CRAWL-TABLE-NORMALIZATION-001` 分窗口执行；不触及采集域和采集 UI。共享 main/CI 的本轮必要增量归本任务，不能重构整个启动器或 workflow。

验收重点：`POST /api/situation-monitor/monitors/preview`、`POST /api/situation-monitor/monitors`、`PATCH /api/situation-monitor/monitors/:id` 都经过注入的共享 geocoder；配置身份/URL/语言/超时/TTL/限速正确；preview 后创建/更新复用缓存；显式坐标优先、country/bounds/无结果与可恢复失败语义不变；普通用户原有监控权限、orgId/userId 归属与系统同步规则不变。

不经本服务 HTTP 回调 `POST /api/geo/geocode`，不调用管理 `Probe` 冒充普通解析，不改变 war-map 的独立缓存策略或其他实时信号链。测试只用 fake Nominatim 与现有 CI Redis/MySQL，不访问公网；保持普通 geocode 与管理员诊断的权限/行为差异。无新增公开 API/迁移 mode/配置项需求。

编码窗口只更新自己的 task 与 PR，交付 Ready PR、精确 head、普通 CI 结果与链接、静态审查 `file:line` 和未验证边界。本机仅静态审查/必要格式化，不安装或运行 build/test/lint/typecheck/vet/Docker/服务；不合并/auto-merge，不部署或声称实网验证。
