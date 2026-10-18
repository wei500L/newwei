# 任务认领与历史恢复索引

main 结构/指定业务分支核对：2026-10-18 14:37–14:42 MSK；任务/worktree 再核14:56；main：`3cedce9aa3200436aba3596f63b559de5490cec8`。返回[入口](../README.md)。

## 当前占用与已合并历史

| ID | 状态 | 精确范围 | 是否已有业务 PR / 推送 |
|---|---|---|---|
| [SETTINGS-WRITE-001](SETTINGS-WRITE-001.md) | merged | 13 个设置写已合入；独立开关接线有剩余缺口 | [PR #68](https://github.com/wei500L/newwei/pull/68) → 3cedce9a；PR/main CI 均成功（main14:22复核） |
| [WORKSPACE-WRITE-001](WORKSPACE-WRITE-001.md) | pr_open | 8 个通知/看板/告警交互写 | Ready [#70](https://github.com/wei500L/newwei/pull/70)，head adb765d0；worktree 干净；尚未合 main，保留占用 |
| [ITEMS-LIST-001](ITEMS-LIST-001.md) | pr_open | Query `items` 完整分页/RECENCY/RELEVANCE/PERSONALIZED/批量嵌套投影 | 分支 `refactor/go-graphql-items-list`，worktree `/Users/oo/project/newwei-go-graphql-items-list`；Ready PR 见本批推送；未合 main |

原始认领/发出时间未提供；原始执行器活动未核实。状态定义见 [PLANNING](../PLANNING.md)。本次没有新业务任务。当前地图文档首版已提交/推送（4e37f285），通过 [Ready PR #69](https://github.com/wei500L/newwei/pull/69) 发布，业务分支状态与文档发布分开；PR URL 见[证据](../EVIDENCE.md)。

## 其他历史任务与本机 worktree

下表于14:49全部只读刷新（工作台写14:56再核） HEAD/状态/祖先关系，不是运行中代理列表。历史 PR 实际 merge SHA 和业务覆盖以域页证据/当前源码为准；分支 HEAD 为 main 祖先只能证明该提交可达，不能证明工作目录后来没有增量。非祖先也不证明未合入（可能 integration/补充同步）。创建任务前重新查 diff、PR、认领；不自动删除或归档旧 worktree。

| 分支 | 本机 worktree | HEAD | 提交关系 | 工作目录快照 | 任务/历史 PR |
|---|---|---|---|---|---|
| `refactor/go-crawl-templates` | `/Users/oo/project/newwei` | `33cbc8866742` | main 祖先 | 1 条状态（只读，不干预） | [#38](https://github.com/wei500L/newwei/pull/38) |
| `refactor/go-account-security` | `/Users/oo/project/newwei-go-account-security` | `c447d7408a57` | main 祖先 | 干净 | [#60](https://github.com/wei500L/newwei/pull/60) |
| `refactor/go-admin-logs` | `/Users/oo/project/newwei-go-admin-logs` | `786d44b2aeab` | main 祖先 | 干净 | [#40](https://github.com/wei500L/newwei/pull/40) |
| `refactor/go-auth-factors` | `/Users/oo/project/newwei-go-auth-factors` | `8d1b59a2d828` | main 祖先 | 干净 | [#62](https://github.com/wei500L/newwei/pull/62) |
| `refactor/go-classification-rss-ops` | `/Users/oo/project/newwei-go-classification-rss-ops` | `723ebd944faa` | main 祖先 | 干净 | [#51](https://github.com/wei500L/newwei/pull/51) |
| `refactor/go-crawl-frontier-runs` | `/Users/oo/project/newwei-go-crawl-frontier-runs` | `9f5c277e1dac` | main 祖先 | 干净 | [#53](https://github.com/wei500L/newwei/pull/53) |
| `refactor/go-crawl-read-telemetry` | `/Users/oo/project/newwei-go-crawl-read-telemetry` | `38e75c7890c9` | main 祖先 | 干净 | [#50](https://github.com/wei500L/newwei/pull/50) |
| `refactor/go-data-runtime-settings` | `/Users/oo/project/newwei-go-data-runtime-settings` | `1c970f8e32d3` | main 祖先 | 干净 | [#61](https://github.com/wei500L/newwei/pull/61) |
| `refactor/go-exception-ingest-diagnostics` | `/Users/oo/project/newwei-go-exception-ingest-diagnostics` | `380593e004b3` | main 祖先 | 干净 | [#64](https://github.com/wei500L/newwei/pull/64) |
| `refactor/go-graphql-org-access-write` | `/Users/oo/project/newwei-go-graphql-org-access-write` | `132fba4493c0` | main 祖先 | 干净 | [#63](https://github.com/wei500L/newwei/pull/63) |
| `refactor/go-graphql-settings-crawl-read` | `/Users/oo/project/newwei-go-graphql-settings-crawl-read` | `f5655cfe9df0` | main 祖先 | 干净 | [#52](https://github.com/wei500L/newwei/pull/52) |
| `refactor/go-graphql-settings-write` | `/Users/oo/project/newwei-go-graphql-settings-write` | `a1c96172b7eb` | main 祖先 | 干净 | [SETTINGS-WRITE-001](SETTINGS-WRITE-001.md)；已合并 PR #68（14:18核对） |
| `refactor/go-graphql-workspace-read` | `/Users/oo/project/newwei-go-graphql-workspace-read` | `48e939a3d260` | main 祖先 | 干净 | [#48](https://github.com/wei500L/newwei/pull/48) |
| `refactor/go-graphql-workspace-write` | `/Users/oo/project/newwei-go-graphql-workspace-write` | `adb765d0180e` | 非 main 祖先；PR 未合入 | 干净 | [#70](https://github.com/wei500L/newwei/pull/70)；pr_open |
| `refactor/go-graphql-items-list` | `/Users/oo/project/newwei-go-graphql-items-list` | 见 PR head | 从 main 9d0462e1 创建 | 本批改动 | [ITEMS-LIST-001](ITEMS-LIST-001.md)；pr_open |
| `refactor/go-infrastructure-settings` | `/Users/oo/project/newwei-go-infrastructure-settings` | `709dfbcffcc8` | main 祖先 | 干净 | [#55](https://github.com/wei500L/newwei/pull/55) |
| `refactor/go-items-reading` | `/Users/oo/project/newwei-go-items-reading` | `52dadb0af794` | main 祖先 | 干净 | [#58](https://github.com/wei500L/newwei/pull/58) |
| `refactor/go-kg-impact-read` | `/Users/oo/project/newwei-go-kg-impact-read` | `9c21455555c1` | 仅合并后报告提交不在 main；#46 已 merged | 干净 | [#46](https://github.com/wei500L/newwei/pull/46) |
| `refactor/go-knowledge-graph-read` | `/Users/oo/project/newwei-go-knowledge-graph-read` | `34d26c86412c` | main 祖先 | 干净 | [#44](https://github.com/wei500L/newwei/pull/44) |
| `refactor/go-llm-gateway-profiles` | `/Users/oo/project/newwei-go-llm-gateway-profiles` | `268ec60fcb60` | main 祖先 | 干净 | [#59](https://github.com/wei500L/newwei/pull/59) |
| `refactor/go-llm-logs` | `/Users/oo/project/newwei-go-llm-logs` | `2323ec869e6c` | main 祖先 | 干净 | [#41](https://github.com/wei500L/newwei/pull/41)、[#42](https://github.com/wei500L/newwei/pull/42) |
| `refactor/go-model-access-settings` | `/Users/oo/project/newwei-go-model-access-settings` | `62db46a3198b` | main 祖先 | 干净 | [#56](https://github.com/wei500L/newwei/pull/56) |
| `refactor/go-news-indicators` | `/Users/oo/project/newwei-go-news-indicators` | `f7d1486dc69f` | main 祖先 | 干净 | [#45](https://github.com/wei500L/newwei/pull/45) |
| `refactor/go-newsnow-clustering-ops` | `/Users/oo/project/newwei-go-newsnow-clustering-ops` | `0f0ae3779a4e` | main 祖先 | 干净 | [#49](https://github.com/wei500L/newwei/pull/49) |
| `refactor/go-platform-governance-settings` | `/Users/oo/project/newwei-go-platform-governance-settings` | `71a65af468c7` | main 祖先 | 干净 | [#54](https://github.com/wei500L/newwei/pull/54) |
| `refactor/go-proxy-load-balancing` | `/Users/oo/project/newwei-go-proxy-load-balancing` | `269d1513981a` | main 祖先 | 干净 | [#66](https://github.com/wei500L/newwei/pull/66) |
| `refactor/go-quality-overview` | `/Users/oo/project/newwei-go-quality-overview` | `b287f815e248` | main 祖先 | 干净 | [#43](https://github.com/wei500L/newwei/pull/43) |
| `refactor/go-rbac` | `/Users/oo/project/newwei-go-rbac` | `6230915996d0` | main 祖先 | 干净 | [#39](https://github.com/wei500L/newwei/pull/39) |
| `refactor/go-runtime-settings` | `/Users/oo/project/newwei-go-runtime-settings` | `91790b405429` | main 祖先 | 1 条状态（只读，不干预） | [#47](https://github.com/wei500L/newwei/pull/47) |
| `refactor/go-search-reindex-ops` | `/Users/oo/project/newwei-go-search-reindex-ops` | `6a8bd5802d7a` | main 祖先 | 干净 | [#65](https://github.com/wei500L/newwei/pull/65) |
| `refactor/go-situation-monitor-signals` | `/Users/oo/project/newwei-go-situation-monitor-signals` | `536817f6e52d` | main 祖先 | 干净 | [#57](https://github.com/wei500L/newwei/pull/57) |

已合并任务无需重建全部历史提示词：按 [模块入口](../README.md) 找域页的 PR/实际 merge SHA/现有报告。最新 #67 集成合入 #59/#62/#63/#65/#66，主线已有网关配置、MFA 管理、组织访问写、索引重建与代理负载均衡；不可因为旧分支/旧报告而重复派发。

kg-impact 的HEAD 9c214555不是main祖先，但 `origin/main..HEAD` 仅一条报告提交，三点diff仅go-kg-impact-read.md；#46实际merge `a80d394539c3ff84174b7d8db239016847e7e99c` 已在main，不是未交付业务，不重复派发。

当前唯一开放业务 PR 是 #70；#69 是地图文档 PR。新合并仍止于 #68，#67 integration 的原批次历史归属不变。设置写主体 merged 与 GAP-GQL-001 同时成立；候选 BL-01 不自动取得 #70 的公共文件所有权。

每次新认领需创建独立 task 文件并保存精确接口/文件所有权。对未提交/未推送的本地记录明确写“其他机器不可见”；正式发出前发布认领记录并再次核对，冲突范围按已有认领或依赖顺序处理。
