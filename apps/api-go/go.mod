module github.com/wei500L/newwei/apps/api-go

go 1.27

require (
	github.com/aws/aws-sdk-go-v2 v1.47.3
	github.com/aws/aws-sdk-go-v2/credentials v1.20.9
	github.com/aws/aws-sdk-go-v2/service/s3 v1.114.3
	github.com/aws/smithy-go v1.28.5
	github.com/go-sql-driver/mysql v1.9.3
	// Go-批3A：NestJS access token 独立验签（HS256/iss/aud/exp）。
	// 成熟维护中的最小 JWT 库——不手写密码学。
	github.com/golang-jwt/jwt/v5 v5.2.3
	// Go-批3A：access-token blacklist 查询（与 NestJS 同一 Redis）。
	github.com/redis/go-redis/v9 v9.7.3
	// GraphQL read pilot：完整 SDL 的解析、校验与变量强制。v2.5.62 是 2026-10-08 的正式 tag。
	github.com/vektah/gqlparser/v2 v2.5.62
	// Go-批5A：dashboard stats 只读查询 ProcessedItem 与 TaskLog。
	go.mongodb.org/mongo-driver/v2 v2.9.2
	// ANALYSIS-RUNS-001：BullMQ 5.63.2 的 Lua 参数与作业 opts 使用 MessagePack。
	// msgpackr 1.11.5（pnpm-lock 锁定）以 useRecords=false 编码，因此标准
	// MessagePack 的固定版本实现即可双向互通；不手写编码器。
	github.com/vmihailenco/msgpack/v5 v5.4.1
	// 账户安全批次：Node bcrypt@5.1.1 兼容的密码校验与生成（仅用 bcrypt 子包）。
	golang.org/x/crypto v0.53.0
	golang.org/x/net v0.55.0
	// Go-批4A：公开故事 slug 的 NFKD/NFC，对齐 JS String.normalize。
	golang.org/x/text v0.39.0
)

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	github.com/agnivade/levenshtein v1.2.1 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.7.22 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.5.6 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.8.6 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.5.6 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.21 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.11.7 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.14.6 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.20.6 // indirect
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/klauspost/compress v1.19.2 // indirect
	github.com/xdg-go/pbkdf2 v1.0.0 // indirect
	github.com/xdg-go/scram v1.2.0 // indirect
	github.com/xdg-go/stringprep v1.0.4 // indirect
	github.com/youmark/pkcs8 v0.0.0-20240726163527-a2c0da244d78 // indirect
	golang.org/x/sync v0.21.0 // indirect
)
