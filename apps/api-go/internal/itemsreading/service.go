package itemsreading

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

// Options wires the item reading service. The database handles are required:
// the service never proxies NestJS for a route it claims to serve.
type Options struct {
	// DB is the MySQL pool shared with the rest of the gateway.
	DB *sql.DB
	// Mongo is the Mongo database handle.
	Mongo *mongo.Database
	// Redis is the shared Redis client (business caches and response caches).
	Redis *redis.Client
	// ReadModelEnabled mirrors ITEMS_READ_MODEL_ENABLED (default false).
	ReadModelEnabled bool
	// VectorHardFailEnabled mirrors ITEMS_VECTOR_HARD_FAIL_ENABLED (default
	// false).
	VectorHardFailEnabled bool
}

// service is the strongly typed read core of the migrated endpoints.
type Service struct {
	mysql            *mySQLStore
	mongo            *mongoStore
	cache            *redisCache
	search           *searchService
	readModel        *readModelService
	vector           *vectorRecall
	readModelEnabled bool
}

// NewService builds the read core.
func NewService(opts Options) *Service {
	mysql := newMySQLStore(opts.DB)
	mongoStore := newMongoStore(opts.Mongo)
	cache := newRedisCache(opts.Redis)
	elastic := newElasticsearchFromEnv()
	searcher := newVectorSearcherFromEnv()
	vector := newVectorRecall(
		searcher,
		mongoStore,
		cache,
		llmembed.NewClient(opts.DB),
		opts.VectorHardFailEnabled,
		opts.DB,
		opts.Redis,
	)
	readModel := newReadModelService(mysql, mongoStore)
	return &Service{
		mysql:            mysql,
		mongo:            mongoStore,
		cache:            cache,
		search:           &searchService{mysql: mysql, mongo: mongoStore, elastic: elastic, vector: vector, readModelEnabled: opts.ReadModelEnabled},
		readModel:        readModel,
		vector:           vector,
		readModelEnabled: opts.ReadModelEnabled,
	}
}

// ListQuery is the validated GET /api/items query contract.
type ListQuery struct {
	// Page is the raw page string (IsNumberString semantics).
	Page string
	// PageSize is the raw pageSize string (IsNumberString semantics).
	PageSize string
	// Search is the raw search string, possibly a historical filter payload.
	Search string
	// OrderBy is the raw orderBy value; only CREATED_DESC and PUBLISHED_DESC
	// are accepted.
	OrderBy string
}

// List ports ItemsController.list -> ItemsListService.list for the REST path
// (RECENCY ordering only).
func (s *Service) List(ctx context.Context, orgID string, query ListQuery) (ItemListResult, error) {
	orderBy := ItemsOrderByCreatedDesc
	switch query.OrderBy {
	case "":
		orderBy = ItemsOrderByCreatedDesc
	case string(ItemsOrderByCreatedDesc), string(ItemsOrderByPublishedDesc):
		orderBy = ItemsOrderBy(query.OrderBy)
	default:
		return ItemListResult{}, ErrInvalidQueryParameter
	}

	pagination, err := NormalizePagination(query.Page, query.PageSize, MaxCursorPageSize)
	if err != nil {
		return ItemListResult{}, err
	}

	parsed := ParseSearchPayload(query.Search)
	scopedIDs, restricted, err := s.search.ResolveScopedIDs(ctx, orgID, parsed.Search, parsed.Filters)
	if err != nil {
		return ItemListResult{}, err
	}
	if restricted && len(scopedIDs) == 0 {
		return ItemListResult{Items: []ItemMetaRow{}, Total: 0, Page: pagination.Page, PageSize: pagination.PageSize}, nil
	}
	var candidates []string
	if restricted {
		candidates = scopedIDs
	}

	if s.readModelEnabled {
		docs, err := s.mongo.ListReadModelMetaRows(ctx, orgID, candidates, orderBy, pagination.Offset, pagination.PageSize)
		if err != nil {
			return ItemListResult{}, err
		}
		total, err := s.mongo.CountReadModelMetaRows(ctx, orgID, candidates)
		if err != nil {
			return ItemListResult{}, err
		}
		items := make([]ItemMetaRow, 0, len(docs))
		for _, doc := range docs {
			items = append(items, ItemMetaRowFromReadModel(doc))
		}
		return ItemListResult{Items: items, Total: total, Page: pagination.Page, PageSize: pagination.PageSize}, nil
	}

	items, err := s.mysql.ListItemMeta(ctx, orgID, candidates, orderBy, pagination.Offset, pagination.PageSize)
	if err != nil {
		return ItemListResult{}, err
	}
	total, err := s.mysql.CountItemMeta(ctx, orgID, candidates)
	if err != nil {
		return ItemListResult{}, err
	}
	return ItemListResult{Items: items, Total: total, Page: pagination.Page, PageSize: pagination.PageSize}, nil
}

// Detail ports ItemsController.detail -> ItemsService.get. A missing or
// cross-organization id is ErrItemNotFound (the handler answers 404 with the
// exact "Item not found" message); the GraphQL item root deliberately answers
// null instead.
func (s *Service) Detail(ctx context.Context, orgID string, itemID string) (ItemDetail, error) {
	if s.readModelEnabled {
		doc, err := s.readModel.loadItemReadModel(ctx, orgID, itemID, true)
		if err != nil {
			return ItemDetail{}, err
		}
		if doc == nil {
			return ItemDetail{}, ErrItemNotFound
		}
		rawItem, err := marshalReadModelRaw(doc.Raw)
		if err != nil {
			return ItemDetail{}, err
		}
		processed, err := marshalReadModelProcessed(doc.Processed)
		if err != nil {
			return ItemDetail{}, err
		}
		return ItemDetail{
			ItemMeta:  ItemMetaRowFromReadModel(*doc),
			RawItem:   rawItem,
			Processed: processed,
		}, nil
	}

	meta, err := s.mysql.FindItemMeta(ctx, orgID, itemID)
	if err != nil {
		return ItemDetail{}, err
	}
	if meta == nil {
		return ItemDetail{}, ErrItemNotFound
	}
	rawEcho, err := s.mongo.FindRawItemEcho(ctx, meta.ID, meta.MongoRef)
	if err != nil {
		return ItemDetail{}, err
	}
	rawItem, err := marshalEcho(rawEcho)
	if err != nil {
		return ItemDetail{}, err
	}
	processedEcho, err := s.mongo.FindLatestProcessedEcho(ctx, orgID, meta.ID)
	if err != nil {
		return ItemDetail{}, err
	}
	processed, err := marshalEcho(processedEcho)
	if err != nil {
		return ItemDetail{}, err
	}
	return ItemDetail{ItemMeta: *meta, RawItem: rawItem, Processed: processed}, nil
}

// ItemMetaOrNull ports ItemsService.getItemMetaOrNull, the nullable lookup the
// GraphQL item root uses.
func (s *Service) ItemMetaOrNull(ctx context.Context, orgID string, itemID string) (*ItemMetaRow, error) {
	if s.readModelEnabled {
		doc, err := s.readModel.loadItemReadModel(ctx, orgID, itemID, true)
		if err != nil {
			return nil, err
		}
		if doc == nil {
			return nil, nil
		}
		row := ItemMetaRowFromReadModel(*doc)
		return &row, nil
	}
	return s.mysql.FindItemMeta(ctx, orgID, itemID)
}

// marshalReadModelRaw renders the read-model raw snapshot shape.
func marshalReadModelRaw(raw *ReadModelRawDoc) (json.RawMessage, error) {
	if raw == nil {
		return json.RawMessage("null"), nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(encoded), nil
}

// marshalReadModelProcessed renders the read-model processed snapshot shape
// with a non-nil tags array, mirroring `tags: readModel.processed.tags ?? []`.
func marshalReadModelProcessed(processed *ReadModelProcessedDoc) (json.RawMessage, error) {
	if processed == nil {
		return json.RawMessage("null"), nil
	}
	if processed.Tags == nil {
		processed.Tags = []string{}
	}
	encoded, err := json.Marshal(processed)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(encoded), nil
}
