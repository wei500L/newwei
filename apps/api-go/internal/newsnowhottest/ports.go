package newsnowhottest

import (
	"context"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowsources"
)

// SourceFetcher is the NewsNow source fetch surface reused by both the global
// snapshot and the recommended feed. production wires *newsnowsources.Service,
// which owns the compatible fresh/stale cache and the physical refresh lock.
type SourceFetcher interface {
	FetchSource(ctx context.Context, sourceID string, forceRefresh bool) (newsnowsources.SourceResponse, error)
	FetchBatch(ctx context.Context, ids []string, forceRefresh bool) newsnowsources.BatchResponse
}

// SourceDescriptor is the read-only registry projection the analysis needs.
type SourceDescriptor struct {
	ID     string
	Name   string
	Title  string
	Home   string
	Column string
}

// Catalog is the generated NewsNow registry read port.
type Catalog interface {
	// HottestSourceIDs returns the hottest column in registry order.
	HottestSourceIDs() []string
	// Source resolves one source descriptor.
	Source(sourceID string) (SourceDescriptor, bool)
}

// ClusterInsightCompleter performs the real model call. production wires the
// public portal gateway, which also writes one llmrequestlogs row per attempt.
type ClusterInsightCompleter interface {
	CompleteClusterInsights(ctx context.Context, orgID, system, user string, clusterCount int) (string, error)
}

// OrgMatch is the organization-scoped item/event match of one URL.
type OrgMatch struct {
	ItemID  string
	EventID string
}

// OrgMatcher resolves comparable URLs inside one organization only. The public
// /resolve endpoint keeps its global semantics; this port is the H1 fix.
type OrgMatcher interface {
	ResolveOrgMatches(ctx context.Context, orgID string, rawURLs []string) (map[string]OrgMatch, error)
}

// ItemBridge creates the ItemMeta/raw_item pair of an auto-bridged signal. It
// reuses the items-ingest write path, which is equivalent to ItemsService.create.
type ItemBridge interface {
	CreateItem(ctx context.Context, orgID, userID string, input itemsingest.CreateItemInput) (itemsingest.CreateItemResult, error)
}

// OpinionStore persists the domestic opinion snapshot bucket (O4).
type OpinionStore interface {
	PersistSnapshots(ctx context.Context, input OpinionSnapshotInput) error
}

// OpinionSnapshotInput is the persistSnapshots argument.
type OpinionSnapshotInput struct {
	OrgID                    string
	GeneratedAt              time.Time
	TotalDomesticSourceCount int
	Candidates               []CandidatePersistenceInput
}

// CandidatePersistenceInput is one candidate row of the opinion snapshot.
type CandidatePersistenceInput struct {
	CandidateHash       string
	Label               string
	Summary             *string
	RepresentativeTitle string
	Themes              []string
	Topics              []string
	Entities            []string
	SourceIDs           []string
	DomesticSourceIDs   []string
	SourceCount         int
	ItemCount           int
	HeatScore           float64
	FreshnessScore      float64
	CandidateScore      float64
	AuthorityScore      float64
	DomesticSourceCount int
	DomesticItemCount   int
	MatchedItemIDs      []string
}

// ScoreMap is one profile dimension: signal key to score. It is a typed map
// rather than a schema-less container; the service only performs lookups.
type ScoreMap map[string]float64

// ScoringProfile is the resolved behavior profile the recommendation scores
// against: the clamped net dimensions plus the negative dimensions used by the
// feedback filter.
type ScoringProfile struct {
	Sources  ScoreMap
	Topics   ScoreMap
	Entities ScoreMap
	Items    ScoreMap
	Events   ScoreMap
	Domains  ScoreMap
	Negative NegativeScores
}

// NegativeScores is the negative half of the behavior profile.
type NegativeScores struct {
	Sources  ScoreMap
	Topics   ScoreMap
	Entities ScoreMap
	Items    ScoreMap
	Events   ScoreMap
	Domains  ScoreMap
}

// CollaborativeProfile is the collaborative-filtering slice of the profile.
type CollaborativeProfile struct {
	Sources  ScoreMap
	Topics   ScoreMap
	Entities ScoreMap
	Items    ScoreMap
	Events   ScoreMap
	Domains  ScoreMap
	Degraded bool
}

// PersonalizationReader is the news-behavior read port.
type PersonalizationReader interface {
	GetScoringProfile(ctx context.Context, orgID, userID string) (ScoringProfile, error)
	GetCollaborativeProfile(ctx context.Context, orgID, userID string) (CollaborativeProfile, error)
}

// NewsnowUISettings is the subset of ui:newsnow:settings:v1 the recommendation
// consults.
type NewsnowUISettings struct {
	FocusSources   []string
	SourceAffinity map[string]float64
}

// UserSettingsReader resolves the NewsNow UI settings of one user. found is
// false when the row is absent, which makes the caller use the default settings
// exactly like `settingsResponse?.settings ?? createDefaultNewsnowUiSettings()`.
type UserSettingsReader interface {
	NewsnowSettings(ctx context.Context, orgID, userID string) (NewsnowUISettings, bool, error)
}
