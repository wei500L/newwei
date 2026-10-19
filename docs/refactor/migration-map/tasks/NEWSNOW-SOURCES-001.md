# NEWSNOW-SOURCES-001 · NewsNow来源获取、批量刷新与实时接缝

- 状态reserved；2026-10-19 Europe/Moscow，本规划窗口保存并发出[独立完整提示词](NEWSNOW-SOURCES-001.prompt.md)，未实施业务。
- 基线origin/main `91e759b449c4511dc96d86539ea0eb258754d07e`，普通CI[39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593)在该精确head success；verify/vector-integration/api-go-user-settings-integration success，两regen skipped。非本批运行/部署证据。
- 业务分支 `refactor/go-newsnow-sources`，worktree `/Users/oo/project/newwei-go-newsnow-sources`，尚未创建；执行器活动未核实。业务PR/head/merge/CI未产生。
- 规划分支 `docs/plan-newsnow-feed`，worktree `/Users/oo/project/newwei-plan-newsnow-feed`；首份认领/提示词提交 `b194917391d54514a8e52ece2680544067d3abe1` 已正常推送，发布于 [Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)。规划PR自身CI尚未确认完成，不借用main绿灯；业务PR仍未创建。
- 来源BL-18的source/batch子链，关联GAP-LEGACY-001；必要来源实时接缝受GAP-ASYNC-001索引，但不认领通用WS或cron。

## 精确交付与工作量

GET /api/news-aggregator/source（公开、200）与POST /api/news-aggregator/sources/batch（公开、201）完整冷获取/强刷，不是缓存读取。当前元数据64个ID、41个可达来源族；registry导入44模块，ghxi/linuxdo/smzdm因disable:true不对外，不恢复，disable:cf仍支持尝试。ID不是HTTP计数；实际工作包含JSON/HTML/RSS/GraphQL、前置Cookie、CLS/Coolapk签名、GB2312、相对日期、别名redirect、全局runtime secret解密、冷热缓存/租约和实时消息。

源契约/参数/null/false/错误经过GlobalExceptionFilter后的差异、所有64 ID、特殊getter、Redis物理key/TTL和并发优化均保存在提示词。只读全局SystemSetting news_source_runtime_secrets，DB+Redis，无Mongo/事务/审计生产/队列。Go复用元数据静态registry新只读port、infrastructuresettings新runtime-reader窄port及已存在crypto/strict parser、sharedDB/Redis/x/net/x/text；未假设私有helper已公开。

优化：将10项整块等待改最多10个fetchSource持续worker pool，结果按输入index回收，保持批量去重/前100/部分成功与顺序；不把10当底层HTTP全局并发上限，不改getter内部既有并发。

## 执行所有权与冲突

拟新增API_GO_NEWSNOW_SOURCES_MODE默认legacy，双端非法值启动失败；独立公开两路仅DB/Redis，不强开JWT/Mongo/旧ops。新增newsnowsources/providers与wire/routes；ops只新增元数据port、infra只新增runtime-reader，不动已有CRUD。Nest只新增source-refresh专用Redis subscriber及module/env增量。

NewsnowDispatcher/ActiveSourceRegistry当前进程内。拟新增newsnow:source-refresh:v1 relay，Go不携org；Nest按认证socket的本地active org选目标。Redis Socket.IO adapter开启时，用(refreshId,orgId)短TTL60秒NX标记避免重复组织跨实例广播；关闭时各实例走本地广播，不做跨实例领取。此为来源接缝的必要有限去重，无耐久outbox/强投递承诺，不迁通用WS。

Nest预热Cron仍唯一后台owner：每分钟source-warm、锁lock:cron:newsnow-source-warm、并发6；热点分析Cron每10分钟也保持。它们仍调用Nest fetchSource与兼容缓存/锁，不因两HTTP迁入Go而标cron已迁。推荐/热点模型/LLM backfill/pipeline等排除。

审计Ready[PR #92](https://github.com/wei500L/newwei/pull/92)开放，head28c8f761a2ce4a447080414f154b567648cc6bd1，普通CI[39248452603](https://github.com/wei500L/newwei/actions/runs/39248452603)成功；真实diff已核shared main/config/env/compose/README，保留AuditOutboxMode/ScheduleEnabled/needsRedis/关闭并集。本批核心包不重叠，不改其业务task或要求已运行窗口重做文档。

## 核对深度与交接

只深入本域两Controller、fetch/cache/batch/redirect/normalize/realtime方法、registry/genSources与sources可达实现、runtime secret严格读取/解密、GlobalExceptionFilter、Nest内存订阅/组织room和Socket.IO adapter、Go现有复用/接线。相对地图3cedce9a，本Nest来源链和Go ops无业务增量；storage专项曾增加infra能力，但未增加源getter。c70b0373到本基线只有上一批规划文档合并，没有新业务迁移。

未装依赖/运行build/test/Docker/服务，未调用真实站点或读取真实.env。provider可达性、Cookie/token、cf/限额、MySQL/Redis及多实例relay/部署未验证，不用已有CI替代。下一检查点为业务PR逐来源覆盖、独立两路装配、错误/缓存/通知副作用、精确head普通CI；共享地图由规划窗口集中回填，不关闭整个跨域GAP。
