// Package analysis ports the pure situation-monitor analysis algorithms from
// apps/api/src/modules/situation-monitor/{classification,clustering,analysis,config}.
//
// The package has no database, Redis, HTTP or clock dependency: every function
// is a pure transformation of its inputs so the NestJS algorithms can be
// compared against fixtures without the application stack.
package analysis

// Category is the SituationMonitorCategory union. The declaration order is the
// NestJS SITUATION_MONITOR_CATEGORIES order and is significant: it drives
// headline flattening, coverage counts and the JSON buckets.
type Category string

const (
	CategoryPolitics Category = "politics"
	CategoryTech     Category = "tech"
	CategoryFinance  Category = "finance"
	CategoryGov      Category = "gov"
	CategoryAI       Category = "ai"
	CategoryIntel    Category = "intel"
)

// Categories mirrors SITUATION_MONITOR_CATEGORIES.
var Categories = []Category{
	CategoryPolitics,
	CategoryTech,
	CategoryFinance,
	CategoryGov,
	CategoryAI,
	CategoryIntel,
}

func (c Category) valid() bool {
	for _, candidate := range Categories {
		if candidate == c {
			return true
		}
	}
	return false
}

// NewsItem mirrors analysis/types.ts SituationNewsItem.
type NewsItem struct {
	Title     string   `json:"title"`
	TitleZh   string   `json:"titleZh,omitempty"`
	Link      string   `json:"link"`
	Source    string   `json:"source"`
	Timestamp int64    `json:"timestamp"`
	Origin    string   `json:"origin,omitempty"`
	ItemMeta  string   `json:"itemMetaId,omitempty"`
	Summary   string   `json:"summary,omitempty"`
	KeyPoints []string `json:"keyPoints,omitempty"`
	Topics    []string `json:"topics,omitempty"`
}

// Headline mirrors SituationMonitorHeadline. The optional fields are omitted
// from JSON exactly when NestJS leaves them undefined; an empty string is not
// equivalent to undefined for titleZh/summary and is therefore omitted too.
type Headline struct {
	ID                       string   `json:"id"`
	ItemMetaID               string   `json:"itemMetaId,omitempty"`
	DuplicateOf              string   `json:"duplicateOf,omitempty"`
	Title                    string   `json:"title"`
	TitleZh                  string   `json:"titleZh,omitempty"`
	Link                     string   `json:"link"`
	Source                   string   `json:"source"`
	Timestamp                int64    `json:"timestamp"`
	Category                 Category `json:"category"`
	Origin                   string   `json:"origin"`
	IsAlert                  bool     `json:"isAlert"`
	AlertKeyword             string   `json:"alertKeyword,omitempty"`
	Summary                  string   `json:"summary,omitempty"`
	SummaryZh                string   `json:"summaryZh,omitempty"`
	KeyPoints                []string `json:"keyPoints,omitempty"`
	KeyPointsZh              []string `json:"keyPointsZh,omitempty"`
	Topics                   []string `json:"topics,omitempty"`
	Entities                 []string `json:"entities,omitempty"`
	Location                 string   `json:"location,omitempty"`
	ClassificationSource     string   `json:"classificationSource,omitempty"`
	ClassificationConfidence *float64 `json:"classificationConfidence,omitempty"`
	ClassificationReason     string   `json:"classificationReason,omitempty"`
}

// EventCluster mirrors SituationMonitorEventCluster.
type EventCluster struct {
	ID                  string     `json:"id"`
	Category            Category   `json:"category"`
	Lead                Headline   `json:"lead"`
	Items               []Headline `json:"items"`
	InternalCount       int        `json:"internalCount"`
	ExternalCount       int        `json:"externalCount"`
	DistinctSourceCount int        `json:"distinctSourceCount"`
	LatestTimestamp     int64      `json:"latestTimestamp"`
	IsAlert             bool       `json:"isAlert"`
	MixedSource         bool       `json:"mixedSource"`
}

// AlertHeadline embeds Headline and adds the alert severity. Embedding keeps
// the JSON object flat, matching the TypeScript interface extension.
type AlertHeadline struct {
	Headline
	Severity string `json:"severity"`
}

// HeadlineRef is the headline projection used by world leaders and situation
// panels.
type HeadlineRef struct {
	Title     string `json:"title"`
	TitleZh   string `json:"titleZh,omitempty"`
	Link      string `json:"link"`
	Source    string `json:"source"`
	Timestamp int64  `json:"timestamp"`
}

// WorldLeader is the response shape of one configured leader.
type WorldLeader struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Title      string        `json:"title"`
	Country    string        `json:"country"`
	Flag       string        `json:"flag,omitempty"`
	Since      string        `json:"since,omitempty"`
	Party      string        `json:"party,omitempty"`
	Focus      []string      `json:"focus,omitempty"`
	MatchCount int           `json:"matchCount"`
	Headlines  []HeadlineRef `json:"headlines"`
}

// SituationPanel is the response shape of one configured situation panel.
type SituationPanel struct {
	ID         string        `json:"id"`
	Title      string        `json:"title"`
	TitleZh    string        `json:"titleZh,omitempty"`
	Subtitle   string        `json:"subtitle"`
	SubtitleZh string        `json:"subtitleZh,omitempty"`
	Level      string        `json:"level"`
	Status     string        `json:"status"`
	Headlines  []HeadlineRef `json:"headlines"`
}

// FeedbackStats mirrors CorrelationFeedbackStats.
type FeedbackStats struct {
	FalsePositive int `json:"falsePositive"`
	FalseNegative int `json:"falseNegative"`
}

// LearningSnapshot mirrors CorrelationLearningSnapshot.
type LearningSnapshot struct {
	BoostedTokens   []string `json:"boostedTokens"`
	BlockedTokens   []string `json:"blockedTokens"`
	SuppressedCount int      `json:"suppressedCount"`
}

// SignalHeadline is the correlation headline projection.
type SignalHeadline struct {
	Title    string `json:"title"`
	TitleZh  string `json:"titleZh,omitempty"`
	Link     string `json:"link"`
	Source   string `json:"source"`
	ItemMeta string `json:"itemMetaId,omitempty"`
}

// EmergingPattern mirrors EmergingPattern.
type EmergingPattern struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	NameZh    string            `json:"nameZh,omitempty"`
	Category  string            `json:"category"`
	Count     int               `json:"count"`
	Level     string            `json:"level"`
	Sources   []string          `json:"sources"`
	Headlines []SignalHeadline  `json:"headlines"`
	Feedback  *FeedbackStats    `json:"feedback,omitempty"`
	Learning  *LearningSnapshot `json:"learning,omitempty"`
}

// MomentumSignal mirrors MomentumSignal.
type MomentumSignal struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	NameZh    string            `json:"nameZh,omitempty"`
	Category  string            `json:"category"`
	Current   int               `json:"current"`
	Delta     int               `json:"delta"`
	Momentum  string            `json:"momentum"`
	Headlines []SignalHeadline  `json:"headlines"`
	Feedback  *FeedbackStats    `json:"feedback,omitempty"`
	Learning  *LearningSnapshot `json:"learning,omitempty"`
}

// CrossSourceCorrelation mirrors CrossSourceCorrelation.
type CrossSourceCorrelation struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	NameZh      string            `json:"nameZh,omitempty"`
	Category    string            `json:"category"`
	SourceCount int               `json:"sourceCount"`
	Sources     []string          `json:"sources"`
	Level       string            `json:"level"`
	Headlines   []SignalHeadline  `json:"headlines"`
	Feedback    *FeedbackStats    `json:"feedback,omitempty"`
	Learning    *LearningSnapshot `json:"learning,omitempty"`
}

// PredictiveSignal mirrors PredictiveSignal.
type PredictiveSignal struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	NameZh       string            `json:"nameZh,omitempty"`
	Category     string            `json:"category"`
	Score        float64           `json:"score"`
	Confidence   int               `json:"confidence"`
	Prediction   string            `json:"prediction"`
	PredictionZh string            `json:"predictionZh,omitempty"`
	Level        string            `json:"level"`
	Headlines    []SignalHeadline  `json:"headlines"`
	Feedback     *FeedbackStats    `json:"feedback,omitempty"`
	Learning     *LearningSnapshot `json:"learning,omitempty"`
}

// CorrelationResults mirrors CorrelationResults.
type CorrelationResults struct {
	EmergingPatterns        []EmergingPattern        `json:"emergingPatterns"`
	MomentumSignals         []MomentumSignal         `json:"momentumSignals"`
	CrossSourceCorrelations []CrossSourceCorrelation `json:"crossSourceCorrelations"`
	PredictiveSignals       []PredictiveSignal       `json:"predictiveSignals"`
}

// CorrelationSummary mirrors getCorrelationSummary.
type CorrelationSummary struct {
	TotalSignals int    `json:"totalSignals"`
	Status       string `json:"status"`
	StatusZh     string `json:"statusZh,omitempty"`
}

// CrossSourceRadarCluster mirrors CrossSourceRadarCluster.
type CrossSourceRadarCluster struct {
	ID        string     `json:"id"`
	ItemCount int        `json:"itemCount"`
	Sources   []string   `json:"sources"`
	Samples   []NewsItem `json:"samples"`
}

// CrossSourceRadar mirrors CrossSourceRadar.
type CrossSourceRadar struct {
	Consistency    float64                   `json:"consistency"`
	Divergence     float64                   `json:"divergence"`
	ClusterCount   int                       `json:"clusterCount"`
	Clusters       []CrossSourceRadarCluster `json:"clusters"`
	OutlierSources []string                  `json:"outlierSources"`
}

// FringeMainstreamPathStep mirrors FringeMainstreamPathStep.
type FringeMainstreamPathStep struct {
	Tier        string   `json:"tier"`
	FirstSeenAt int64    `json:"firstSeenAt"`
	LastSeenAt  int64    `json:"lastSeenAt"`
	Count       int      `json:"count"`
	Sources     []string `json:"sources"`
}

// FringeMainstreamPath mirrors FringeMainstreamPath.
type FringeMainstreamPath struct {
	Steps             []FringeMainstreamPathStep `json:"steps"`
	LagToMainstreamMs *int64                     `json:"lagToMainstreamMs,omitempty"`
}

// CitationLink mirrors CitationLink.
type CitationLink struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Weight int    `json:"weight"`
}

// CitationChain mirrors CitationChain.
type CitationChain struct {
	Nodes    []string       `json:"nodes"`
	Links    []CitationLink `json:"links"`
	TopCited []struct {
		Source string `json:"source"`
		Weight int    `json:"weight"`
	} `json:"topCited"`
	CitedByCount int `json:"citedByCount"`
}

// CredibilityComponents mirrors CredibilityAssessment.components.
type CredibilityComponents struct {
	SourceReliability float64 `json:"sourceReliability"`
	Corroboration     float64 `json:"corroboration"`
	CitationSupport   float64 `json:"citationSupport"`
	Divergence        float64 `json:"divergence"`
	FeedbackPenalty   float64 `json:"feedbackPenalty"`
}

// CredibilityAssessment mirrors CredibilityAssessment.
type CredibilityAssessment struct {
	Score      int                   `json:"score"`
	Level      string                `json:"level"`
	Reasons    []string              `json:"reasons"`
	Components CredibilityComponents `json:"components"`
}

// NarrativePropagationModel mirrors NarrativePropagationModel.
type NarrativePropagationModel struct {
	CrossSourceRadar       CrossSourceRadar      `json:"crossSourceRadar"`
	FringeToMainstreamPath FringeMainstreamPath  `json:"fringeToMainstreamPath"`
	Credibility            CredibilityAssessment `json:"credibility"`
	CitationChain          CitationChain         `json:"citationChain"`
}

// NarrativeData mirrors NarrativeData.
type NarrativeData struct {
	ID               string                     `json:"id"`
	Name             string                     `json:"name"`
	NameZh           string                     `json:"nameZh,omitempty"`
	Category         string                     `json:"category"`
	Severity         string                     `json:"severity"`
	Count            int                        `json:"count"`
	FringeCount      int                        `json:"fringeCount"`
	AlternativeCount int                        `json:"alternativeCount"`
	MainstreamCount  int                        `json:"mainstreamCount"`
	Sources          []string                   `json:"sources"`
	Headlines        []NewsItem                 `json:"headlines"`
	Keywords         []string                   `json:"keywords"`
	Feedback         *FeedbackStats             `json:"feedback,omitempty"`
	Model            *NarrativePropagationModel `json:"model,omitempty"`
	Learning         *LearningSnapshot          `json:"learning,omitempty"`
}

// EmergingFringe mirrors EmergingFringe.
type EmergingFringe struct {
	NarrativeData
	Status string `json:"status"`
}

// FringeToMainstream mirrors FringeToMainstream.
type FringeToMainstream struct {
	NarrativeData
	Status         string  `json:"status"`
	CrossoverLevel float64 `json:"crossoverLevel"`
}

// NarrativeResults mirrors NarrativeResults.
type NarrativeResults struct {
	EmergingFringe     []EmergingFringe     `json:"emergingFringe"`
	FringeToMainstream []FringeToMainstream `json:"fringeToMainstream"`
	NarrativeWatch     []NarrativeData      `json:"narrativeWatch"`
	DisinfoSignals     []NarrativeData      `json:"disinfoSignals"`
}

// NarrativeSummary mirrors getNarrativeSummary.
type NarrativeSummary struct {
	Total    int    `json:"total"`
	Status   string `json:"status"`
	StatusZh string `json:"statusZh,omitempty"`
}

// MainCharacterEntry mirrors MainCharacterEntry.
type MainCharacterEntry struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
	Rank  int    `json:"rank"`
}

// MainCharacterResults mirrors MainCharacterResults.
type MainCharacterResults struct {
	Characters   []MainCharacterEntry `json:"characters"`
	TopCharacter *MainCharacterEntry  `json:"topCharacter"`
}

// MainCharacterSummary mirrors getMainCharacterSummary.
type MainCharacterSummary struct {
	Name     string `json:"name"`
	Count    int    `json:"count"`
	Status   string `json:"status"`
	StatusZh string `json:"statusZh,omitempty"`
}

// ClustersByCategory mirrors Record<SituationMonitorCategory, Cluster[]>.
type ClustersByCategory struct {
	Politics []EventCluster `json:"politics"`
	Tech     []EventCluster `json:"tech"`
	Finance  []EventCluster `json:"finance"`
	Gov      []EventCluster `json:"gov"`
	AI       []EventCluster `json:"ai"`
	Intel    []EventCluster `json:"intel"`
}

// Bucket returns the slice for one category. The returned pointer aliases the
// struct field so callers can append in place.
func (b *ClustersByCategory) Bucket(category Category) *[]EventCluster {
	switch category {
	case CategoryPolitics:
		return &b.Politics
	case CategoryTech:
		return &b.Tech
	case CategoryFinance:
		return &b.Finance
	case CategoryGov:
		return &b.Gov
	case CategoryAI:
		return &b.AI
	case CategoryIntel:
		return &b.Intel
	default:
		return nil
	}
}

// HeadlinesByCategory is the core pipeline's mutable per-category buckets.
type HeadlinesByCategory struct {
	Politics []Headline `json:"politics"`
	Tech     []Headline `json:"tech"`
	Finance  []Headline `json:"finance"`
	Gov      []Headline `json:"gov"`
	AI       []Headline `json:"ai"`
	Intel    []Headline `json:"intel"`
}

// Bucket returns the slice for one category.
func (b *HeadlinesByCategory) Bucket(category Category) *[]Headline {
	switch category {
	case CategoryPolitics:
		return &b.Politics
	case CategoryTech:
		return &b.Tech
	case CategoryFinance:
		return &b.Finance
	case CategoryGov:
		return &b.Gov
	case CategoryAI:
		return &b.AI
	case CategoryIntel:
		return &b.Intel
	default:
		return nil
	}
}

// All returns the buckets in declaration order without copying their items.
func (b *HeadlinesByCategory) All() [][]Headline {
	return [][]Headline{b.Politics, b.Tech, b.Finance, b.Gov, b.AI, b.Intel}
}

// Flatten concatenates the buckets in declaration order.
func (b *HeadlinesByCategory) Flatten() []Headline {
	out := make([]Headline, 0, len(b.Politics)+len(b.Tech)+len(b.Finance)+len(b.Gov)+len(b.AI)+len(b.Intel))
	out = append(out, b.Politics...)
	out = append(out, b.Tech...)
	out = append(out, b.Finance...)
	out = append(out, b.Gov...)
	out = append(out, b.AI...)
	out = append(out, b.Intel...)
	return out
}
