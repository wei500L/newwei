# MONITOR-GEOCODING-001 · 监控地点解析接入系统地理编码

- 状态：`merged`；2026-11-01 核实 [#156](https://github.com/wei500L/newwei/pull/156) 实际 merge `fc9f823a34ba2257048c4c0c4ce7785f8c446a5a`；最终源 head `3b06403823be753587a81cbe0a2feb06a3c7ccb7` 已是当前 main `2e63645d` 祖先，[源 head 普通 CI 41251389520](https://github.com/wei500L/newwei/actions/runs/41251389520) 三主 job success，两个 regen skipped。不以初版实现 head 或失败旧 run 替代最终证据。
- 最终业务 merge `2e63645d` 的[CI 41286944654](https://github.com/wei500L/newwei/actions/runs/41286944654) 后续核对已 completed/success，三主 job success、两个 regen skipped；中间 merge run 41286940726 cancelled。`GAP-MONITOR-GEOCODING-001` 按源码范围关闭，未部署/实网验证；当前 main CI 见入口。
- 缺口：`GAP-MONITOR-GEOCODING-001`，对应[态势复核 M-04](../../review/situation-realtime.md)。
- 核对基线：main `e04fc4d8bb54596afd302a309ebc852c7676d958`；[普通 CI 41242463081](https://github.com/wei500L/newwei/actions/runs/41242463081) 三主 job success，两个 regen skipped。开工重新 fetch 并检查认领。
- 分支建议：`codex/fix-monitor-geocoding`；已创建独立工作树 `/Users/oo/project/newwei-monitor-geocoding`（基于 `e04fc4d8`），本机仅静态审查与 gofmt。
- 修复前根因证据：`apps/api-go/internal/situationmonitors/location.go` 的 `geocode` 直接请求固定 Nominatim URL/UA；`service.go` 自建 HTTP client；`cmd/api/situation_monitors.go:20` 未注入已有共享 geocoder。系统配置、Redis 正/负缓存及全局限速均被绕过。
- 可复用实现：`internal/geocoding/geocode.go` 的 `Client.Geocode`、`RedisCache`、`SQLSettingsReader`；生产配置参考 `cmd/api/settings_diagnostics.go` 的 `wireGeocoding`，使用现有 `Nominatim*` / `Geocode*` config。
- 产品链：系统 User-Agent/email 设置及环境 BaseURL 等配置 → 共享缓存/限速的地点解析 → 监控 preview/create/update → 持久化与 Web 编辑/展示。不是新增地理编码产品或给监控增加设置管理权限。
- 所有权：`internal/situationmonitors`、必要的 `internal/geocoding`、`cmd/api/situation_monitors.go`、`cmd/api/main.go` 中该调用的最小接线；Web `situation-monitor-monitors-panel.tsx`、对应 types/测试和必要的现有设置面板；CI 仅在缺少执行覆盖时扩展既有集成步骤。
- 并行边界：可与 `CRAWL-TABLE-NORMALIZATION-001` 分窗口执行；不触及采集域和采集 UI。共享 main/CI 的本轮必要增量归本任务，不能重构整个启动器或 workflow。

验收重点：`POST /api/situation-monitor/monitors/preview`、`POST /api/situation-monitor/monitors`、`PATCH /api/situation-monitor/monitors/:id` 都经过注入的共享 geocoder；配置身份/URL/语言/超时/TTL/限速正确；preview 后创建/更新复用缓存；显式坐标优先、country/bounds/无结果与可恢复失败语义不变；普通用户原有监控权限、orgId/userId 归属与系统同步规则不变。

不经本服务 HTTP 回调 `POST /api/geo/geocode`，不调用管理 `Probe` 冒充普通解析，不改变 war-map 的独立缓存策略或其他实时信号链。测试只用 fake Nominatim 与现有 CI Redis/MySQL，不访问公网；保持普通 geocode 与管理员诊断的权限/行为差异。无新增公开 API/迁移 mode/配置项需求。

编码窗口只更新自己的 task 与 PR，交付 Ready PR、精确 head、普通 CI 结果与链接、静态审查 `file:line` 和未验证边界。本机仅静态审查/必要格式化，不安装或运行 build/test/lint/typecheck/vet/Docker/服务；不合并/auto-merge，不部署或声称实网验证。

## 实际落地与核对

- `cmd/api/geocoding_client.go` 统一 REST/监控使用的配置工厂，共用 Redis cache/全局 limiter 与 SQL 身份设置；`situation_monitors.go:22`、`main.go:664` 完成真实生产接线。只读信号投影构造器显式传 nil，未添加固定公网 fallback。
- `internal/situationmonitors/location.go:129` 委托共享客户端，保存时复用与 country 相符的预览缓存；显式坐标、country/bounds 映射与可恢复失败语义保留。监控原有权限与 orgId/userId 归属未引入管理设置权限。
- `internal/situationmonitors/integration_test.go:287,514` 覆盖配置/缓存/限速、preview/create/update 与租户隔离；`.github/workflows/ci.yml:321` 的既有集成 job 实际执行该包。Web 行为测试 `situation-monitor-monitors-panel.test.tsx:182,242,286` 覆盖创建、编辑重新预览、无命中；共享地点类型补齐，布局保留。
- 本次只做相关接线、类型/返回契约、错误处理、权限范围与 CI 去向的静态复核，不冒充完整重审。未运行本机 build/test/lint/typecheck/vet/Docker/服务，未调用真实 Nominatim/LLM；CI 仅为 fake 上游与 CI Redis/MySQL。下一检查点为最终 main CI，不重复派本 task。
