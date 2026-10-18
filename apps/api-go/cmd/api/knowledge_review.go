package main

import (
	"database/sql"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgereview"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// registerKnowledgeReview registers the single knowledge-graph evidence review
// mutation. It reuses the shared MySQL pool, JWT authenticator and Redis client
// the caller already assembled; it opens no second pool, starts no worker and
// requires no Mongo handle, so a write-only deployment never initializes a read
// domain.
//
// modelsRegistered is true when the settings/crawl read registration already
// recorded the four review object types. Registering them twice is harmless but
// the write-only path must not depend on that read switch being go.
func registerKnowledgeReview(reg *contract.Registry, db *sql.DB, redisClient *redis.Client, modelsRegistered bool) {
	if !modelsRegistered {
		settingscrawl.RegisterReviewModelTypes(reg)
	}
	knowledgereview.Register(reg, db, redisClient, knowledgereview.Options{})
}
