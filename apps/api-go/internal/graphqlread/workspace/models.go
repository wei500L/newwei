package workspace

import (
	"encoding/json"
	"time"
)

// GraphQL object fields use the SDL names. Pointers are nullable, a nil
// slice of a non-null list projects as an empty list, and time.Time projects
// as DateTime. Fields declared as the JSON scalar carry json.RawMessage so
// the executor re-encodes them without an untyped map.

// UserModel is the GraphQL UserModel object. planTier and subscriptionStatus
// are populated only by the me root, which derives them from the caller's
// current organization.
type UserModel struct {
	AvatarURL          *string    `graphql:"avatarUrl"`
	Email              string     `graphql:"email"`
	EmailVerified      *time.Time `graphql:"emailVerified"`
	FirstName          string     `graphql:"firstName"`
	ID                 string     `graphql:"id"`
	IsActive           bool       `graphql:"isActive"`
	LastLoginAt        *time.Time `graphql:"lastLoginAt"`
	LastName           string     `graphql:"lastName"`
	OrgID              string     `graphql:"orgId"`
	Permissions        []string   `graphql:"permissions"`
	PlanTier           *string    `graphql:"planTier"`
	PrimaryRoleID      *string    `graphql:"primaryRoleId"`
	RoleIDs            []string   `graphql:"roleIds"`
	SubscriptionStatus *string    `graphql:"subscriptionStatus"`
}

// UserLoginRecordModel is the GraphQL UserLoginRecordModel object.
type UserLoginRecordModel struct {
	CreatedAt time.Time `graphql:"createdAt"`
	ID        string    `graphql:"id"`
	IPAddress *string   `graphql:"ipAddress"`
	Method    string    `graphql:"method"`
	UserAgent *string   `graphql:"userAgent"`
}

// OrgModel is the GraphQL OrgModel object.
type OrgModel struct {
	CreatedAt   time.Time `graphql:"createdAt"`
	Description *string   `graphql:"description"`
	ID          string    `graphql:"id"`
	IsActive    bool      `graphql:"isActive"`
	Name        string    `graphql:"name"`
	Slug        string    `graphql:"slug"`
	UpdatedAt   time.Time `graphql:"updatedAt"`
}

// PermissionModel is the GraphQL PermissionModel object.
type PermissionModel struct {
	Description *string `graphql:"description"`
	ID          string  `graphql:"id"`
	Name        string  `graphql:"name"`
}

// RoleModel is the GraphQL RoleModel object. Selecting permissions requires
// roles.read through a registered field permission.
type RoleModel struct {
	Description *string           `graphql:"description"`
	ID          string            `graphql:"id"`
	IsSystem    bool              `graphql:"isSystem"`
	Name        string            `graphql:"name"`
	Permissions []PermissionModel `graphql:"permissions"`
}

// MembershipModel is the GraphQL MembershipModel object. role, roles, and
// user are guarded by users.read.
type MembershipModel struct {
	ID    string      `graphql:"id"`
	OrgID string      `graphql:"orgId"`
	Role  RoleModel   `graphql:"role"`
	Roles []RoleModel `graphql:"roles"`
	User  UserModel   `graphql:"user"`
}

// DashboardWidgetModel is the GraphQL DashboardWidgetModel object. dataConfig
// and options are JSON scalars.
type DashboardWidgetModel struct {
	DataConfig *json.RawMessage `graphql:"dataConfig"`
	DataSource string           `graphql:"dataSource"`
	ID         string           `graphql:"id"`
	LayoutH    float64          `graphql:"layoutH"`
	LayoutW    float64          `graphql:"layoutW"`
	LayoutX    float64          `graphql:"layoutX"`
	LayoutY    float64          `graphql:"layoutY"`
	Options    *json.RawMessage `graphql:"options"`
	SortOrder  float64          `graphql:"sortOrder"`
	Title      *string          `graphql:"title"`
	Type       string           `graphql:"type"`
}

// DashboardModel is the GraphQL DashboardModel object. config is a JSON scalar.
type DashboardModel struct {
	Config      *json.RawMessage       `graphql:"config"`
	CreatedAt   time.Time              `graphql:"createdAt"`
	Description *string                `graphql:"description"`
	ID          string                 `graphql:"id"`
	Name        string                 `graphql:"name"`
	Slug        string                 `graphql:"slug"`
	Theme       *string                `graphql:"theme"`
	UpdatedAt   time.Time              `graphql:"updatedAt"`
	Version     int                    `graphql:"version"`
	Widgets     []DashboardWidgetModel `graphql:"widgets"`
}

// QueueCountsModel is the GraphQL QueueCountsModel object.
type QueueCountsModel struct {
	Active    int `graphql:"active"`
	Completed int `graphql:"completed"`
	Delayed   int `graphql:"delayed"`
	Failed    int `graphql:"failed"`
	Waiting   int `graphql:"waiting"`
}

// QueueEventModel is the GraphQL QueueEventModel object.
type QueueEventModel struct {
	Data      *string `graphql:"data"`
	Event     string  `graphql:"event"`
	JobID     string  `graphql:"jobId"`
	Timestamp string  `graphql:"timestamp"`
}

// QueueStatsModel is the GraphQL QueueStatsModel object.
type QueueStatsModel struct {
	Counts          QueueCountsModel  `graphql:"counts"`
	CountsAvailable bool              `graphql:"countsAvailable"`
	ItemCount       int               `graphql:"itemCount"`
	ProcessedCount  int               `graphql:"processedCount"`
	RecentLogs      []QueueEventModel `graphql:"recentLogs"`
}

// EntitySentimentSnapshotModel is the GraphQL EntitySentimentSnapshotModel
// object. evidenceProcessedItemIds is a JSON scalar.
type EntitySentimentSnapshotModel struct {
	AvgScore                 float64          `graphql:"avgScore"`
	BucketStart              time.Time        `graphql:"bucketStart"`
	EntityName               string           `graphql:"entityName"`
	EntityType               string           `graphql:"entityType"`
	EvidenceProcessedItemIDs *json.RawMessage `graphql:"evidenceProcessedItemIds"`
	NegativeDocs             int              `graphql:"negativeDocs"`
	NegativeRatio            float64          `graphql:"negativeRatio"`
	NeutralDocs              int              `graphql:"neutralDocs"`
	PositiveDocs             int              `graphql:"positiveDocs"`
	ScoreSum                 int              `graphql:"scoreSum"`
	TotalDocs                int              `graphql:"totalDocs"`
}

// TopicSentimentSnapshotModel is the GraphQL TopicSentimentSnapshotModel
// object. evidenceProcessedItemIds is a JSON scalar.
type TopicSentimentSnapshotModel struct {
	AvgScore                 float64          `graphql:"avgScore"`
	BucketStart              time.Time        `graphql:"bucketStart"`
	EvidenceProcessedItemIDs *json.RawMessage `graphql:"evidenceProcessedItemIds"`
	NegativeDocs             int              `graphql:"negativeDocs"`
	NegativeRatio            float64          `graphql:"negativeRatio"`
	NeutralDocs              int              `graphql:"neutralDocs"`
	PositiveDocs             int              `graphql:"positiveDocs"`
	ScoreSum                 int              `graphql:"scoreSum"`
	Topic                    string           `graphql:"topic"`
	TotalDocs                int              `graphql:"totalDocs"`
}

// ProcessedItemErrorModelGraph is the GraphQL ProcessedItemErrorModelGraph
// object.
type ProcessedItemErrorModelGraph struct {
	Message string  `graphql:"message"`
	Name    *string `graphql:"name"`
}

// ProcessedItemLlmModel is the GraphQL ProcessedItemLlmModel object. Every
// field is nullable because a stored llm document may be partial or carry
// non-finite numbers.
type ProcessedItemLlmModel struct {
	CompletionTokens *float64 `graphql:"completionTokens"`
	CostUSD          *float64 `graphql:"costUsd"`
	LatencyMs        *float64 `graphql:"latencyMs"`
	Model            *string  `graphql:"model"`
	PromptTokens     *float64 `graphql:"promptTokens"`
	PromptVersion    *string  `graphql:"promptVersion"`
	TotalTokens      *float64 `graphql:"totalTokens"`
}

// ProcessedItemModelGraph is the GraphQL ProcessedItemModelGraph object.
// result is the JSON string form of the normalized result and resultJson the
// normalized object form; duplicateOf is the target's ItemMeta id, not the
// target's Mongo _id.
type ProcessedItemModelGraph struct {
	CreatedAt                  time.Time                     `graphql:"createdAt"`
	DuplicateOf                *string                       `graphql:"duplicateOf"`
	DuplicateSimilarity        *float64                      `graphql:"duplicateSimilarity"`
	Error                      *ProcessedItemErrorModelGraph `graphql:"error"`
	EventID                    *string                       `graphql:"eventId"`
	ID                         string                        `graphql:"id"`
	ItemMetaID                 string                        `graphql:"itemMetaId"`
	LLM                        *ProcessedItemLlmModel        `graphql:"llm"`
	Result                     *string                       `graphql:"result"`
	ResultJSON                 *json.RawMessage              `graphql:"resultJson"`
	Status                     string                        `graphql:"status"`
	SummaryEmbeddingDimensions *int                          `graphql:"summaryEmbeddingDimensions"`
	SummaryEmbeddingModel      *string                       `graphql:"summaryEmbeddingModel"`
	Tags                       []string                      `graphql:"tags"`
}
