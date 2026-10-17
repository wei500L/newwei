package knowledgegraph

import "time"

// GraphQL object fields use the SDL names. Pointers are nullable.
// A non-nil empty slice is an empty list; a nil slice of a non-null list is
// projected as [].

type KnowledgeGraphNodeModel struct {
	ID         string `graphql:"id"`
	Name       string `graphql:"name"`
	Type       string `graphql:"type"`
	Properties any    `graphql:"properties"`
}

type KnowledgeGraphEdgeModel struct {
	ID         string  `graphql:"id"`
	From       string  `graphql:"from"`
	To         string  `graphql:"to"`
	Type       string  `graphql:"type"`
	Weight     float64 `graphql:"weight"`
	Confidence float64 `graphql:"confidence"`
	Properties any     `graphql:"properties"`
}

type KnowledgeGraphMetadataModel struct {
	TotalNodes  int       `graphql:"totalNodes"`
	TotalEdges  int       `graphql:"totalEdges"`
	GeneratedAt time.Time `graphql:"generatedAt"`
}

type KnowledgeGraphModel struct {
	Seed     KnowledgeGraphNodeModel     `graphql:"seed"`
	Nodes    []KnowledgeGraphNodeModel   `graphql:"nodes"`
	Edges    []KnowledgeGraphEdgeModel   `graphql:"edges"`
	Metadata KnowledgeGraphMetadataModel `graphql:"metadata"`
}

type ArticleEntityLinkModel struct {
	ArticleID  string                  `graphql:"articleId"`
	Entity     KnowledgeGraphNodeModel `graphql:"entity"`
	Mention    *string                 `graphql:"mention"`
	Confidence *float64                `graphql:"confidence"`
	CreatedAt  time.Time               `graphql:"createdAt"`
}

type KnowledgeGraphEdgeEvidenceArticleModel struct {
	ID       string    `graphql:"id"`
	URL      string    `graphql:"url"`
	Title    *string   `graphql:"title"`
	Summary  *string   `graphql:"summary"`
	Language *string   `graphql:"language"`
	CrawlAt  time.Time `graphql:"crawlAt"`
}

type KnowledgeGraphEdgeEvidenceItemModel struct {
	ID               string                                 `graphql:"id"`
	Confidence       *float64                               `graphql:"confidence"`
	ExtractorVersion *string                                `graphql:"extractorVersion"`
	CreatedAt        time.Time                              `graphql:"createdAt"`
	Evidence         any                                    `graphql:"evidence"`
	Article          KnowledgeGraphEdgeEvidenceArticleModel `graphql:"article"`
}

type EntityIntelligenceMetricsModel struct {
	RelationshipCount     int        `graphql:"relationshipCount"`
	IncomingEdgeCount     int        `graphql:"incomingEdgeCount"`
	OutgoingEdgeCount     int        `graphql:"outgoingEdgeCount"`
	MentionedArticleCount int        `graphql:"mentionedArticleCount"`
	RecentEventCount      int        `graphql:"recentEventCount"`
	AvgSentiment          *float64   `graphql:"avgSentiment"`
	NegativeRatio         *float64   `graphql:"negativeRatio"`
	LatestMentionAt       *time.Time `graphql:"latestMentionAt"`
}

type EntityIntelligenceRelationshipModel struct {
	Direction        string                  `graphql:"direction"`
	Edge             KnowledgeGraphEdgeModel `graphql:"edge"`
	Neighbor         KnowledgeGraphNodeModel `graphql:"neighbor"`
	EvidenceCount    int                     `graphql:"evidenceCount"`
	LatestEvidenceAt *time.Time              `graphql:"latestEvidenceAt"`
}

type EntitySentimentSnapshotModel struct {
	EntityName               string    `graphql:"entityName"`
	EntityType               string    `graphql:"entityType"`
	BucketStart              time.Time `graphql:"bucketStart"`
	TotalDocs                int       `graphql:"totalDocs"`
	NegativeDocs             int       `graphql:"negativeDocs"`
	PositiveDocs             int       `graphql:"positiveDocs"`
	NeutralDocs              int       `graphql:"neutralDocs"`
	ScoreSum                 int       `graphql:"scoreSum"`
	AvgScore                 float64   `graphql:"avgScore"`
	NegativeRatio            float64   `graphql:"negativeRatio"`
	EvidenceProcessedItemIDs any       `graphql:"evidenceProcessedItemIds"`
}

type EntityIntelligenceCardModel struct {
	Entity          KnowledgeGraphNodeModel               `graphql:"entity"`
	Aliases         []string                              `graphql:"aliases"`
	Metrics         EntityIntelligenceMetricsModel        `graphql:"metrics"`
	Relationships   []EntityIntelligenceRelationshipModel `graphql:"relationships"`
	SentimentSeries []EntitySentimentSnapshotModel        `graphql:"sentimentSeries"`
	Neighborhood    KnowledgeGraphModel                   `graphql:"neighborhood"`
	GeneratedAt     time.Time                             `graphql:"generatedAt"`
}

type EntityIntelligenceEventModel struct {
	ID            string    `graphql:"id"`
	Status        string    `graphql:"status"`
	Title         *string   `graphql:"title"`
	Summary       *string   `graphql:"summary"`
	PrimaryTopic  *string   `graphql:"primaryTopic"`
	PrimaryEntity *string   `graphql:"primaryEntity"`
	StartAt       time.Time `graphql:"startAt"`
	LastAt        time.Time `graphql:"lastAt"`
	ItemCount     int       `graphql:"itemCount"`
}

type EntityIntelligenceArticleModel struct {
	ID          string    `graphql:"id"`
	URL         string    `graphql:"url"`
	SourceLabel *string   `graphql:"sourceLabel"`
	Title       *string   `graphql:"title"`
	Summary     *string   `graphql:"summary"`
	Language    *string   `graphql:"language"`
	CrawlAt     time.Time `graphql:"crawlAt"`
}

type EntityIntelligenceEvidenceArticleModel struct {
	Article    EntityIntelligenceArticleModel `graphql:"article"`
	Mention    *string                        `graphql:"mention"`
	Confidence *float64                       `graphql:"confidence"`
	LinkedAt   time.Time                      `graphql:"linkedAt"`
}

type EntityIntelligenceEvidenceModel struct {
	Restricted  bool                                     `graphql:"restricted"`
	Events      []EntityIntelligenceEventModel           `graphql:"events"`
	Articles    []EntityIntelligenceEvidenceArticleModel `graphql:"articles"`
	GeneratedAt time.Time                                `graphql:"generatedAt"`
}
