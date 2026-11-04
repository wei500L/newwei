package dashboardstats

import (
	"context"
	"database/sql"
	"errors"
	"log"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
)

// itemCountSQL 按服务端确认的 orgId 计数。占位符绑定，不拼接 orgId。
const itemCountSQL = "SELECT COUNT(*) FROM ItemMeta WHERE orgId = ?"

// processedItemsCollection / taskLogsCollection 是 Mongoose 8 默认集合名
// （model 名小写后再走 legacy pluralize）：ProcessedItem → processeditems，
// TaskLog → tasklogs。schema 没有显式 collection。
const (
	processedItemsCollection = "processeditems"
	taskLogsCollection       = "tasklogs"
	recentLogLimit           = 10
)

// source 是 stats 的三个只读来源。orgID 由调用方传入，实现不得改读请求参数。
type source interface {
	CountItems(ctx context.Context, orgID string) (int64, error)
	CountProcessed(ctx context.Context, orgID string) (int64, error)
	RecentLogs(ctx context.Context, orgID string) ([]recentLog, error)
	QueueCounts(ctx context.Context, orgID string) (queueCounts, bool)
}

// Connect 把共享 Mongo 客户端与已有的 MySQL、Redis 组成只读 source。
func Connect(auth *authhttp.Authenticator, db *sql.DB, cache *redis.Client, client *mongodb.Client) *Handler {
	database := client.Database()
	return NewHandler(auth, &liveSource{
		db:         db,
		redis:      cache,
		mongoItems: database.Collection(processedItemsCollection),
		mongoLogs:  database.Collection(taskLogsCollection),
	})
}

// liveSource 把 MySQL、Mongo、Redis 拼成一个 source。Mongo 连接失败的
// 查询错误原样上抛；Redis 命令失败在 QueueCounts 内降级。
type liveSource struct {
	db         *sql.DB
	mongoItems *mongo.Collection
	mongoLogs  *mongo.Collection
	redis      redisHMGet
}

// redisHMGet 是 go-redis Client 上实际用到的那一个方法。
type redisHMGet interface {
	HMGet(ctx context.Context, key string, fields ...string) *redis.SliceCmd
}

func (s *liveSource) CountItems(ctx context.Context, orgID string) (int64, error) {
	if s == nil || s.db == nil {
		return 0, errors.New("mysql is not configured")
	}
	var count int64
	err := s.db.QueryRowContext(ctx, itemCountSQL, orgID).Scan(&count)
	return count, err
}

func (s *liveSource) CountProcessed(ctx context.Context, orgID string) (int64, error) {
	if s == nil || s.mongoItems == nil {
		return 0, errors.New("mongo is not configured")
	}
	count, err := s.mongoItems.CountDocuments(ctx, bson.D{{Key: "orgId", Value: orgID}})
	if err != nil {
		log.Printf("dashboard stats: processed item count failed")
		return 0, err
	}
	return count, nil
}

func (s *liveSource) RecentLogs(ctx context.Context, orgID string) ([]recentLog, error) {
	if s == nil || s.mongoLogs == nil {
		return nil, errors.New("mongo is not configured")
	}
	cursor, err := s.mongoLogs.Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "queue", Value: itemPipelineQueue},
	}, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(recentLogLimit).
		SetProjection(bson.D{
			{Key: "_id", Value: 0},
			{Key: "createdAt", Value: 1},
			{Key: "jobId", Value: 1},
			{Key: "message", Value: 1},
			{Key: "stage", Value: 1},
			{Key: "status", Value: 1},
		}))
	if err != nil {
		log.Printf("dashboard stats: task log query failed")
		return nil, err
	}
	defer cursor.Close(ctx)
	logs := make([]recentLog, 0)
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			log.Printf("dashboard stats: task log decode failed")
			return nil, err
		}
		logs = append(logs, recentLogFromDoc(doc))
	}
	if err := cursor.Err(); err != nil {
		log.Printf("dashboard stats: task log cursor failed")
		return nil, err
	}
	return logs, nil
}

func (s *liveSource) QueueCounts(ctx context.Context, orgID string) (queueCounts, bool) {
	if s == nil || s.redis == nil {
		log.Printf("dashboard stats: redis counts client missing")
		return zeroQueue(), false
	}
	vals, err := s.redis.HMGet(ctx, countsKey(orgID), trackedStatuses[:]...).Result()
	if err != nil {
		log.Printf("dashboard stats: redis org counts failed: %v", err)
		return zeroQueue(), false
	}
	return countsFromValues(vals, nil)
}
