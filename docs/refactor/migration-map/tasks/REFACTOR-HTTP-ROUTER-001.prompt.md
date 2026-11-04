# 执行提示词 · REFACTOR-HTTP-ROUTER-001 · 路由预编译、包改名与迁移期注释清理

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-HTTP-ROUTER-001.md`。worktree slug：`refactor-http-router`。

**前置**：REFACTOR-RUNTIME-WIRING-001 已实际合入 main，并且 CI 成功。可以与 REFACTOR-BULLMQ-PRODUCER-001 并行进行，两者在 `cmd/api` 中只有构造参数级别的交集，冲突时用 merge 保留双方改动。

## 问题（规划基线 18c41879858d 已核实）

### 1. 每个请求都在排序路由表

`internal/legacyproxy/proxy.go`：

- `matchRule`（约第 165 行）在**每个请求**中都会复制整张规则表，再做一次 `sort.SliceStable`。这张表约有几百条规则，由 82 个 `With*` 构建函数组成，见 `all_routes.go`。
- `matchGoHandler`（约第 135 行）在完整键找不到 handler 时，会把**所有 handler 键**复制出来做一次 `sort.Slice`，再逐个做前缀匹配。

结果是：每个请求都有 O(n log n) 的计算和多次内存分配，而规则表和 handler 表在启动后其实是只读的。

### 2. 包名与注释仍是迁移期叙事

- 包名 `legacyproxy`、`nestnotfound` 与实际职责不符：现在这里就是纯 Go 路由器加上 404 契约。
- 全仓库约有 1136 个文件提到 NestJS，约 1473 处提到 shadow/legacy。其中路由文件的注释大量已经失效，例如：
  - `rbac_routes.go:9-22` 写着“只在 mode 为 go 时接管……继续回落 NestJS……默认（空 / legacy）不追加规则”；
  - 各 handler 中也有“只服务开关为 go 时接管的……”这类说法（例如 `internal/rbacapi/handler.go:35`）。
- `apps/api-go/README.md:295` 起的段落仍在描述 `DefaultRules(onboardingMode, readMode)` 和 shadow 差分，这些都已经不存在了。

## 方案

### A. 预编译路由器（保持现有匹配语义，不换成 `http.ServeMux`）

> **为什么不换 ServeMux**：现有 Rule 有 `TailSegment`/`TailSuffix` 这类段内后缀匹配；ServeMux 会自动做路径清理和尾斜杠重定向（301）；它对方法不匹配返回 405。这些都与当前的 Nest 404 契约不兼容，由 `cutover_coverage_test.go` 的 `TestAllGoUnknownPathAnswers404WithoutUpstream` / `TestAllGoUnclaimedMethodsAnswer404` 守护。

1. `New(rules)` 时只排序一次（按 Prefix 长度降序，稳定排序），并保存排好序的副本。
2. 把 handler 解析从“请求时”挪到“注册完成时”：
   - 增加 `Freeze()`（或者在 `SetNotFound` 时）把每条规则的 handler 解析好，存进规则内的字段。
   - 解析规则与现在的 `matchGoHandler` 完全一致：先找完整的 HandlerKey/Prefix；找不到时，用最长的已注册键作为前缀。
   - 请求时只做线性匹配加直接调用。
   - `Freeze` 之后再调用 `RegisterGoHandler` 就 panic（编程错误）。确认 `cmd/api` 在 listener 启动前已经完成所有注册。
3. 可选的进一步优化：精确规则（`Exact`）用 `map[path][]rule` 做 O(1) 预筛选，其余规则仍然线性匹配。**前提**是匹配结果与线性扫描完全相同，包括 Methods 白名单不命中时继续尝试下一条规则的行为。
4. 保留 `httpx.SetRouteLabel(r.Context(), httpx.RouteFamily(path))` 的调用时机与取值。

### B. 改名

- `internal/legacyproxy` → `internal/httproute`，`Gateway` → `Router`，`RegisterGoHandler` → `Handle`，`SetGoHandler` → 按用途命名（例如 `HandleProcessHealth`）。
- `internal/nestnotfound` → `internal/notfound`。404 响应体保持 Nest 形状，这是对外契约；但是代码中的命名和注释描述成“当前 404 契约”。
- 同步更新：
  - `.github/workflows/ci.yml:132`（`go test ./internal/legacyproxy/ -run ...` 的路径）；
  - `AGENTS.md` 第 32 行；
  - `apps/api-go/README.md` 中的相关段落（重写为当前事实，删除 shadow/DefaultRules 描述）；
  - `apps/api-go/contracts/PROVENANCE.md`、`internal/apidocs/PROVENANCE.md` 中的路径引用。
- 在 `cmd/api` 和各包中，约有 146 处引用这两个包，全部更新。测试文件随包一起移动，测试名保持不变。

### C. 清理迁移期注释（只限路由层和 handler 头注释）

- `internal/httproute/*_routes.go` 中的每个 `With*` 函数，注释改为一句英文：列出路由和方法。删除 “mode/go/legacy/回落 NestJS/默认不追加” 一类说法。
- 各业务包的 `Handler` 类型注释中，凡是“只服务开关为 go 时接管的……”这类说法，都改成当前事实。
- 只改注释，不改代码。不要扩展到 service、store 等文件的全量注释重写，范围太大，后续再说。
- 用 `grep -rn -i "mode 为 go\|开关为 go\|回落 NestJS\|legacy 不追加\|shadow" apps/api-go/internal/httproute apps/api-go/internal/*/handler.go` 自查，PR 中给出清理前后的数量。

## 等价陷阱

1. 排序必须是**稳定**的（同样长度的 Prefix 保持声明顺序），这是现有语义。
2. Methods 白名单不命中时要继续匹配下一条规则，而不是立即返回 404。
3. OPTIONS 预检：哪些规则把 OPTIONS 交给 handler（由 handler 内部的 CORS 逻辑处理），哪些规则由 Router 的 `Reject` 处理，保持不变。
4. handler 前缀回退要取“最长的、作为前缀的已注册键”。注意现有实现对 `keys` 按长度排序时**没有**稳定的次序；如果两个键长度相同，并且都是同一个规则键的前缀（理论上不会发生），在 PR 中说明你确认过不存在这种情况。
5. 未匹配的请求保持 `"unmatched"` 路由标签（由 metrics 中间件的默认值提供），不能用路径生成新的标签值。
6. 契约测试 `TestEveryDocumentedHTTPOperationIsOwnedByGo` 等必须原样通过，只能改包路径。

## 测试

- 新增一个测试：同一张 `AllRoutes()` 表，预编译 Router 与一个在测试中保留的“参考线性实现”（把旧算法拷进 `_test.go`）对一组路径/方法（包括所有契约路由、随机未知路径、方法不匹配）给出相同的结果（命中规则与 handler）。这是等价性的核心证据。
- 可以加一个简单的 benchmark，但不作为 CI 门槛。

## 交付范围

允许修改：`internal/legacyproxy/**` → `internal/httproute/**`、`internal/nestnotfound/**` → `internal/notfound/**`、所有引用这两个包的文件（只改 import 和调用名）、各业务包 `handler.go` 的类型/包注释、`cmd/api/**` 中的路由注册调用、`.github/workflows/ci.yml`、`AGENTS.md`、`apps/api-go/README.md`、两个 `PROVENANCE.md`。
