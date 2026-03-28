# GDELT IPv4 Fallback（本地 Docker / WSL 网络兼容说明）

## 背景

`situation-monitor` 和 `realtime-signals` 都会访问 `api.gdeltproject.org`。在部分本地开发环境里，尤其是 Docker Desktop、WSL、双栈 DNS 或宿主机出口网络组合比较复杂时，Node.js 默认 `fetch()` 访问 GDELT 可能出现下面这类问题：

- `fetch failed`
- `UND_ERR_CONNECT_TIMEOUT`
- `ETIMEDOUT`
- 首轮请求在内部超时后被中止

这类问题在浏览器里不一定能稳定复现，但在容器里的 Node runtime 上比较常见。

## “只对 GDELT 主机生效的 IPv4 fallback” 是什么

当前 API 提供了一个很窄的网络兼容兜底：

- 先按正常路径执行一次标准 `fetch()`
- 只有当首轮请求失败，并且目标主机命中 allowlist 时，才会追加一次 IPv4 请求
- 当前 allowlist 只包含 `api.gdeltproject.org`
- 重试时使用 `node:http` / `node:https` 并显式指定 `{ family: 4 }`

这意味着它不是：

- 不是全局关闭 IPv6
- 不是给所有第三方 API 强制走 IPv4
- 不是修改 Docker 或宿主机的 DNS 配置
- 不是绕过 GDELT 限流

它只是一个面向 `api.gdeltproject.org` 的、失败后才触发的一次性兼容重试。

## 触发条件

只有下面条件同时满足时，才会进入 IPv4 fallback：

1. 首轮标准 `fetch()` 失败
2. 请求目标是 `api.gdeltproject.org`（或其子域名）
3. 错误属于网络失败或超时场景，例如：
   - `TypeError: fetch failed`
   - `UND_ERR_CONNECT_TIMEOUT`
   - `ETIMEDOUT`
   - 内部超时导致的 `AbortError`，且不是调用方主动取消

如果目标不是 GDELT 主机，或者错误并非网络失败/超时，代码会直接抛出原始错误，不会自动切到 IPv4。

## 为什么只对 GDELT 做

这里刻意把范围收得很窄，原因很直接：

- 问题是在本地环境访问 GDELT 时观察到的，不是整套系统所有外部 provider 都有同样现象
- 全局强制 IPv4 会改变其他上游的默认网络行为，副作用太大
- 只对白名单主机做失败后重试，能把兼容性收益和行为风险都控制在最小范围内

当前实现更像“面向单个上游的网络补丁”，不是平台层网络策略。

## 它不能解决什么

这个 fallback 不能解决下面这些情况：

- `HTTP 429 Too Many Requests`
  - 这是 GDELT 限流，IPv4 重试也一样可能被限流
- `No internal Situation Monitor items are available yet`
  - 这通常表示当前 workspace 没有启用任何 `NewsSource`
- `No completed processed items matched the current time window`
  - 这说明内部处理链路在当前时间窗内没有完成数据，不是 GDELT 网络协议问题

也就是说，GDELT 外部 headlines 能否返回，和内部 `INT` 数据是否存在，是两条不同链路。

## 生产环境是否需要

通常不应把它视为生产环境的必需能力。

更准确地说：

- 稳定的生产机房、云主机或容器平台，如果 IPv4/IPv6 出口和 DNS 都正常，首轮 `fetch()` 就会成功
- 在这种情况下，这个 fallback 虽然保留在代码里，但基本不会实际触发
- 如果你的生产网络本身存在双栈连通性不稳定、IPv6 出口黑洞、或特定运营商链路问题，它仍然可能有价值

所以更合理的判断标准不是“生产一定不需要”，而是：

- 大多数生产环境不应依赖它
- 但是否删除或保留，应该以真实出口网络验证结果为准

## 实现位置

- 通用 helper：`apps/api/src/common/http/fetch-with-ipv4-fallback.ts`
- Situation Monitor 外部 headlines：`apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts`
- Realtime signals 的部分 GDELT 拉取：`apps/api/src/modules/realtime-signals/realtime-signals.service.ts`

相关回归测试：

- `apps/api/src/common/http/fetch-with-ipv4-fallback.spec.ts`

## 运维建议

如果你在本地 Docker / WSL 里看到如下错误：

- `GDELT fallback request failed`
- `fetch failed`
- `UND_ERR_CONNECT_TIMEOUT`

建议按下面顺序判断：

1. 先区分是网络失败还是 `429` 限流
2. 如果是网络失败，确认当前容器访问 `api.gdeltproject.org` 是否存在 IPv6 或双栈异常
3. 如果是 `429`，不要把问题归因到 IPv4/IPv6；那是上游限流，需要降低请求频率或等待恢复
4. 如果页面同时提示没有内部 items，再单独检查 `NewsSource` 是否启用

## 设计结论

这项实现的定位是：

- 对本地开发环境有效的 GDELT 网络兼容兜底
- 默认不影响其他 provider
- 在健康的生产网络里通常处于“存在但不触发”的状态
