// Package personalnews 是 Go-批7 三个域之间的单向调用面。
//
// 本包不连数据库、不读配置、不注册路由。newsbehavior、contentcatalog、
// contentsubscriptions、userdigest、llmembed 都只依赖这里的类型，
// 避免包循环。HTTP 开关不在这些类型里：内部服务由 main 按依赖装配，
// 不因另一个域的 HTTP 模式是 legacy 就改走 NestJS。
package personalnews

import "context"

// 订阅种类与 Prisma ContentSubscriptionKind 的存储值一致。
const (
	KindTopic   = "topic"
	KindEntity  = "entity"
	KindSource  = "source"
	KindKeyword = "keyword"
	KindGeo     = "geo"
)

// 订阅来源与 Prisma ContentSubscriptionSource 的存储值一致。
const (
	SourceManual         = "manual"
	SourceRecommendation = "recommendation"
	SourceRelated        = "related"
	SourceLegacy         = "legacy"
)

// LimitPerKind 是每种订阅的上限。批量写入必须在跨实例原子保护下守住它。
const LimitPerKind = 50

// SubscriptionKey 是 (kind, normalizedValue) 复合身份。
type SubscriptionKey struct {
	Kind            string
	NormalizedValue string
}

// EntryInput 是尚未解析目录的一条订阅输入。Value 是调用方原始字符串；
// NormalizedValue 为空时由目录/订阅规范化填写。
type EntryInput struct {
	Kind            string
	Value           string
	NormalizedValue string
	DisplayValue    string
	Source          string
}

// CatalogResolution 是目录命中或 ad-hoc 解析结果。TaxonomyPath 为 nil
// 表示未分类。Metadata 为 nil 表示没有 metadata 对象。
type CatalogResolution struct {
	Kind            string
	NormalizedValue string
	DisplayValue    string
	TaxonomyPath    *string
	TaxonomyVersion *string
	EmbeddingModel  *string
	EmbeddingVector []float64
	Metadata        map[string]any
	Count           int
	LastSeenAt      string
}

// TaxonomyNode 是新闻分类树上的一个节点，供订阅列表补充分支展示名。
type TaxonomyNode struct {
	Path        string
	DisplayName string
	Labels      []string
}

// TaxonomyView 是某组织当前分类配置的只读视图。
type TaxonomyView struct {
	Version string
	ByPath  map[string]TaxonomyNode
}

// ScoreMap 是画像一个维度的 signalKey → score。JSON 对象，空时为 {}。
type ScoreMap map[string]float64

// ScoreDimensions 是七个画像维度。字段名与 NestJS profile JSON 一致。
type ScoreDimensions struct {
	Actions  ScoreMap `json:"actions"`
	Sources  ScoreMap `json:"sources"`
	Topics   ScoreMap `json:"topics"`
	Entities ScoreMap `json:"entities"`
	Items    ScoreMap `json:"items"`
	Events   ScoreMap `json:"events"`
	Domains  ScoreMap `json:"domains"`
}

// PersonalizationProfile 是推荐使用的画像切片。Meta 保持 NestJS
// getPersonalizationProfile 返回的 meta 对象，不缩成 topic 列表。
type PersonalizationProfile struct {
	Positive ScoreDimensions
	Negative ScoreDimensions
	Net      ScoreDimensions
	Meta     map[string]any
}

// DigestSource 是摘要订阅里的来源项。
type DigestSource struct {
	SourceID     string
	DisplayValue string
}

// DigestGeo 是摘要订阅里的地理项。CountryCodeAlpha2 为空则 JSON 省略。
type DigestGeo struct {
	NormalizedValue   string
	DisplayValue      string
	CountryCodeAlpha2 string
}

// DigestSubscriptionValues 与 NestJS DigestSubscriptionValues 对应。
// 切片为空时是空数组，不是 null。
type DigestSubscriptionValues struct {
	FocusTopics   []string
	FocusEntities []string
	FocusKeywords []string
	FocusSources  []DigestSource
	FocusGeos     []DigestGeo
}

// BehaviorAPI 是行为画像对目录推荐暴露的最小能力。
type BehaviorAPI interface {
	GetPersonalizationProfile(ctx context.Context, orgID, userID string) (PersonalizationProfile, error)
}

// CatalogAPI 是订阅写入、推荐和摘要替换订阅时需要的目录能力。
// 推荐与相关主题的已订阅集合由调用方传入，目录包不反向读取订阅表。
type CatalogAPI interface {
	EnsureFresh(ctx context.Context, orgID string) error
	LoadTaxonomy(ctx context.Context, orgID string) (TaxonomyView, error)
	Resolve(ctx context.Context, orgID string, entries []EntryInput) ([]CatalogResolution, error)
	List(ctx context.Context, orgID string, kind, query, taxonomyPath string, limit int) ([]byte, error)
	Lookup(ctx context.Context, orgID string, entries []EntryInput) ([]byte, error)
	Recommend(ctx context.Context, orgID string, limit int, subscribed []SubscriptionKey, profile PersonalizationProfile) ([]byte, error)
	RelatedTopics(ctx context.Context, orgID, topic string, limit int, subscribedTopics []string) ([]byte, error)
}

// SubscriptionAPI 是摘要偏好读写订阅表的能力。实现必须跑旧数据迁移。
type SubscriptionAPI interface {
	GetDigestPreferenceValues(ctx context.Context, orgID, userID string) (topics, entities []string, err error)
	GetDigestSubscriptionValues(ctx context.Context, orgID, userID string) (DigestSubscriptionValues, error)
	ReplaceSubscriptionsFromDigestPreference(ctx context.Context, orgID, userID string, topics, entities *[]string) error
}
