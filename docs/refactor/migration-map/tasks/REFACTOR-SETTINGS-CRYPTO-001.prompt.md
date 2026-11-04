# 执行提示词 · REFACTOR-SETTINGS-CRYPTO-001 · 设置密文信封与密钥解析单一实现

你在仓库 `wei500L/newwei`（本地 `/Users/oo/project/newwei`）工作。先完整读 `docs/refactor/migration-map/tasks/REFACTOR-COMMON.md` 并遵守，再读 `tasks/REFACTOR-SETTINGS-CRYPTO-001.md`。worktree slug：`refactor-settings-crypto`。前置：无。

## 问题（规划基线 18c41879858d 已核实）

`SYSTEM_SETTINGS_ENCRYPTION_KEY` 加密的 v1 信封格式如下：

```
{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"<b64>","tag":"<b64>","data":"<b64>"}
```

AES-256-GCM，12 字节 IV，16 字节 tag 单独存放，无 AAD。这套逻辑被复制了 16 份。

| 文件 | 能力 |
|---|---|
| `internal/accountsecurity/crypto.go` | 解密 |
| `internal/authfactors/crypto.go` | 加 + 解 |
| `internal/crawlfrontierllm/llm_profile.go` | 解密 |
| `internal/dashboardwarmap/translate.go` | 解密 |
| `internal/dataruntimesettings/crypto.go` | 加 + 解 |
| `internal/economicdata/settings.go` | 解密 |
| `internal/graphqlread/history/secret.go` | 解密 |
| `internal/infrastructuresettings/crypto.go` | 加 + 解 |
| `internal/itemsreading/translation.go` | 解密 |
| `internal/llmembed/crypto.go` | 解密 |
| `internal/llmgatewayprofiles/crypto.go` | 加 + 解 |
| `internal/modelaccesssettings/crypto.go` | 加 + 解 |
| `internal/newsnowclusteringops/readiness.go` | 解密 |
| `internal/publicportal/gateway.go` | 解密 |
| `internal/situationsettings/crypto.go` | 加 + 解 |
| `internal/situationsignals/settings.go` | 解密 |

**已确认的缺陷：密钥解析不一致。**

- `accountsecurity/crypto.go:75` 和 `modelaccesssettings`（`nodeBase64Decode`）按 Node `Buffer.from(value, "base64")` 的宽松语义解析：兼容 URL-safe 字母表，忽略非法字符。
- `situationsettings/crypto.go:84-87` 先试 `StdEncoding`，再试 `RawStdEncoding`。
- `publicportal/gateway.go:766` 和 `dashboardwarmap/translate.go:527` 只接受 `StdEncoding`。

后果是：同一个无 padding 或 URL-safe 的 base64 密钥，在账户安全、模型接入等域能正常解密，在公开门户、战争地图翻译等域却会失败，相关功能被静默降级。

## 方案

### 1. 新增 `apps/api-go/internal/settingscrypto`

- `func ParseKey(raw string) ([]byte, error)`：
  - 先 TrimSpace；为空时返回 `ErrKeyEmpty`。
  - 去掉可选的 `0x`/`0X` 前缀后，如果正好是 64 个 hex 字符，按 hex 解码。
  - 否则按 Node `Buffer.from(raw, "base64")` 语义解码：标准与 URL-safe 字母表都接受，忽略其他字符，遇到 `=` 结束。实现直接搬现有的 `nodeBase64Decode` 及其测试，不要重写一份。
  - 结果必须正好 32 字节，否则返回 `ErrKeyLength`。
- `type Envelope struct`：字段按上面的 JSON 格式，`iv`/`tag`/`data` 用指针，以区分“缺失”和“空串”（参考 `authfactors` 的 `encryptedStringValueV1.valid()`）。
- `func IsEnvelope(raw json.RawMessage) bool`：只有 `__enc`/`alg` 精确匹配，且三个字段都是字符串时才为真。
- `func Encrypt(plain string, key []byte) (Envelope, error)`：每次使用新的随机 IV。
- `func Decrypt(env Envelope, key []byte) (string, error)`：所有失败统一返回 `ErrDecrypt`，不暴露底层原因。

### 2. 逐个替换 16 份副本

删除本地的 `decodeSettingsKey` / `decodeSystemSettingsKey` / `decryptStringValueV1` / `encryptStringValueV1` / `isHex` / `nodeBase64Decode` 等实现，改为调用共享包。

**各域的错误映射保留在各域**。例如 `authfactors` 注释说明“缺少 key 时是 500 而不是 400”；`graphqlread/history/secret.go` 有 `managedKeyState`；有的域在 key 为空时报 `"SYSTEM_SETTINGS_ENCRYPTION_KEY is empty"`。共享包只返回哨兵错误，由各域用 `errors.Is` 映射成原来的状态码和文案。

### 3. config 不动

`cmd/api` 和 `config` 继续把字符串传给各域，避免与 AUTH-CHAIN / RUNTIME-WIRING 任务冲突。各域在构造时调用一次 `ParseKey` 并缓存结果；如果原来就是每次调用都解析，可以顺手改成构造时解析一次，但要保留“key 缺失时什么时候报错”的时机。例如有些域在启动时不报错，只有真正读写密文时才报错，这个时机不能变。

## 有意行为变更

所有域都按 Node 宽松语义接受密钥，是原来最宽集合的并集。原来能用的密钥仍然能用；原来在部分域被拒绝的无 padding 或 URL-safe 密钥，现在在所有域都能用。在 PR 中写明这一点。

## 等价陷阱

1. 密文格式不变：输出 JSON 的字段顺序（`__enc, alg, iv, tag, data`）、`StdEncoding`（带 padding）编码。已有加密行由 Node 写入过，必须仍然可以解密。
2. 解密 tag 长度必须为 16、IV 长度必须为 12，否则视为失败（`modelaccesssettings` 已这样做）。确认其他副本是否有更宽松的行为；如果有，在差异表里记录。
3. 有的域通过 `IsEnvelope` 判断“这个值是明文还是密文”（明文兼容）。共享包的判定条件必须与这些域原来的判定完全一致，否则会把明文当密文，或者反过来。
4. `config` 里存在 `SettingsEncryptionKey`（已 trim）、`SettingsEncryptionKeyRaw`、`PlatformGovernanceEncryptionKeyRaw` 几种形态（`internal/config/config.go:288-341`）。不要改各域使用哪一个字段。

## 测试

- 把现有的 Node base64 解析测试与加解密往返测试迁到 `settingscrypto`。
- 加用例：hex（带或不带 `0x`）、标准 base64、无 padding、URL-safe、长度不足 32、空串。
- 各域原有测试的断言不改。

## 交付范围

允许修改：`internal/settingscrypto/**`（新增）和上表 16 个文件（以及它们同包的测试文件）。不改 `cmd/api`、`config`。
