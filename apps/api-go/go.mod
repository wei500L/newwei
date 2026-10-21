module github.com/wei500L/newwei/apps/api-go

go 1.27

require (
	github.com/aws/aws-sdk-go-v2 v1.47.3
	github.com/aws/aws-sdk-go-v2/credentials v1.20.9
	github.com/aws/aws-sdk-go-v2/service/s3 v1.114.3
	github.com/aws/smithy-go v1.28.5
	// GraphQL realtime subscriptions: maintained RFC6455 client/server with
	// context cancellation, used instead of a hand-written frame layer.
	github.com/coder/websocket v1.8.15
	github.com/go-sql-driver/mysql v1.9.3
	// Go-批3A：NestJS access token 独立验签（HS256/iss/aud/exp）。
	// 成熟维护中的最小 JWT 库——不手写密码学。
	github.com/golang-jwt/jwt/v5 v5.2.3
	// Situation monitor Telegram worker/login: maintained MTProto client with
	// GramJS-compatible session import/export, DC migration and SRP 2FA,
	// instead of hand-writing the crypto and session layer. v0.162.0 is the
	// 2026-09-18 stable tag (MIT).
	github.com/gotd/td v0.162.0
	// Go-批3A：access-token blacklist 查询（与 NestJS 同一 Redis）。
	github.com/redis/go-redis/v9 v9.7.3
	// GraphQL read pilot：完整 SDL 的解析、校验与变量强制。v2.5.62 是 2026-10-08 的正式 tag。
	github.com/vektah/gqlparser/v2 v2.5.62
	// BullMQ 5.63.2 msgpack wire format shared by the items-ingest,
	// archive-preparation, alert-rules, crawl-task, news-backfill,
	// classification-quality, assistant and analysis producers/consumers.
	// v5.4.1 is the fixed tag.
	github.com/vmihailenco/msgpack/v5 v5.4.1
	// Go-批5A：dashboard stats 只读查询 ProcessedItem 与 TaskLog。
	go.mongodb.org/mongo-driver/v2 v2.9.2
	// 账户安全批次：Node bcrypt@5.1.1 兼容的密码校验与生成（仅用 bcrypt 子包）。
	golang.org/x/crypto v0.54.0
	golang.org/x/net v0.57.0
	// Go-批4A：公开故事 slug 的 NFKD/NFC，对齐 JS String.normalize。
	golang.org/x/text v0.40.0
)

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	github.com/agnivade/levenshtein v1.2.1 // indirect
	github.com/andybalholm/brotli v1.2.1 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.7.22 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.5.6 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.8.6 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.5.6 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.21 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.11.7 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.14.6 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.20.6 // indirect
	github.com/cenkalti/backoff/v4 v4.3.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/dlclark/regexp2 v1.12.0 // indirect
	github.com/fatih/color v1.19.0 // indirect
	github.com/ghodss/yaml v1.0.0 // indirect
	github.com/go-faster/errors v0.8.0 // indirect
	github.com/go-faster/jx v1.2.0 // indirect
	github.com/go-faster/xor v1.0.0 // indirect
	github.com/go-faster/yaml v0.4.6 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/gotd/ige v0.3.0 // indirect
	github.com/gotd/log v0.1.0 // indirect
	github.com/gotd/neo v0.1.5 // indirect
	github.com/klauspost/compress v1.19.2 // indirect
	github.com/mattn/go-colorable v0.1.15 // indirect
	github.com/mattn/go-isatty v0.0.22 // indirect
	github.com/ogen-go/ogen v1.23.0 // indirect
	github.com/refraction-networking/utls v1.8.2 // indirect
	github.com/segmentio/asm v1.2.1 // indirect
	github.com/shopspring/decimal v1.4.0 // indirect
	github.com/vmihailenco/tagparser/v2 v2.0.0 // indirect
	github.com/xdg-go/pbkdf2 v1.0.0 // indirect
	github.com/xdg-go/scram v1.2.0 // indirect
	github.com/xdg-go/stringprep v1.0.4 // indirect
	github.com/youmark/pkcs8 v0.0.0-20240726163527-a2c0da244d78 // indirect
	github.com/yuin/goldmark v1.8.5 // indirect
	go.opentelemetry.io/otel v1.44.0 // indirect
	go.opentelemetry.io/otel/metric v1.44.0 // indirect
	go.opentelemetry.io/otel/trace v1.44.0 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.uber.org/zap v1.28.0 // indirect
	golang.org/x/exp v0.0.0-20230725093048-515e97ebf090 // indirect
	golang.org/x/mod v0.38.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/tools v0.48.0 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
	rsc.io/qr v0.2.0 // indirect
)
