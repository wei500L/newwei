module github.com/wei500L/newwei/apps/api-go

go 1.27

require (
	github.com/go-sql-driver/mysql v1.9.3
	// Go-批3A：NestJS access token 独立验签（HS256/iss/aud/exp）。
	// 成熟维护中的最小 JWT 库——不手写密码学。
	github.com/golang-jwt/jwt/v5 v5.2.3
	// Go-批3A：access-token blacklist 查询（与 NestJS 同一 Redis）。
	github.com/redis/go-redis/v9 v9.7.3
	// Go-批5A：dashboard stats 只读查询 ProcessedItem 与 TaskLog。
	go.mongodb.org/mongo-driver/v2 v2.9.2
	// Go-批4A：公开故事 slug 的 NFKD/NFC，对齐 JS String.normalize。
	golang.org/x/text v0.29.0
)

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
)
