package settingscrawl

import (
	"encoding/json"
	"time"
)

// NewsEventSourcePolicyDeltaModel is the GraphQL
// NewsEventSourcePolicyDeltaModel object: the eight add/remove lists of one
// persisted delta snapshot.
type NewsEventSourcePolicyDeltaModel struct {
	AuthoritativeDomainsAdd    []string `graphql:"authoritativeDomainsAdd"`
	AuthoritativeDomainsRemove []string `graphql:"authoritativeDomainsRemove"`
	AuthoritativeLabelsAdd     []string `graphql:"authoritativeLabelsAdd"`
	AuthoritativeLabelsRemove  []string `graphql:"authoritativeLabelsRemove"`
	BlogDomainsAdd             []string `graphql:"blogDomainsAdd"`
	BlogDomainsRemove          []string `graphql:"blogDomainsRemove"`
	BlogLabelsAdd              []string `graphql:"blogLabelsAdd"`
	BlogLabelsRemove           []string `graphql:"blogLabelsRemove"`
}

// NewsEventSourcePolicyConflictModel is the GraphQL
// NewsEventSourcePolicyConflictModel object. domainConflicts and labelConflicts
// keep the blog-side spelling and blog-list order, exactly like NestJS.
type NewsEventSourcePolicyConflictModel struct {
	DomainConflicts []string `graphql:"domainConflicts"`
	HasConflicts    bool     `graphql:"hasConflicts"`
	LabelConflicts  []string `graphql:"labelConflicts"`
}

// NewsEventSourceCategoryAuthorityDomainBoostModel is the GraphQL
// NewsEventSourceCategoryAuthorityDomainBoostModel object.
type NewsEventSourceCategoryAuthorityDomainBoostModel struct {
	Delta  float64 `graphql:"delta"`
	Domain string  `graphql:"domain"`
}

// NewsEventSourceCategoryAuthorityRuleModel is the GraphQL
// NewsEventSourceCategoryAuthorityRuleModel object.
type NewsEventSourceCategoryAuthorityRuleModel struct {
	AuthoritativeBoost float64                                            `graphql:"authoritativeBoost"`
	BlogPenalty        float64                                            `graphql:"blogPenalty"`
	CategoryPrefix     string                                             `graphql:"categoryPrefix"`
	DomainBoosts       []NewsEventSourceCategoryAuthorityDomainBoostModel `graphql:"domainBoosts"`
	MinConfidenceFloor float64                                            `graphql:"minConfidenceFloor"`
	MismatchPenalty    float64                                            `graphql:"mismatchPenalty"`
	UnknownPenalty     float64                                            `graphql:"unknownPenalty"`
}

// NewsEventSourcePolicyRevisionModel is the GraphQL
// NewsEventSourcePolicyRevisionModel object. Each revision carries its own full
// delta snapshot, so a diff never chains revisions.
type NewsEventSourcePolicyRevisionModel struct {
	ActorID   *string                                `graphql:"actorId"`
	CreatedAt time.Time                              `graphql:"createdAt"`
	Delta     NewsEventSourcePolicyDeltaModel        `graphql:"delta"`
	Note      *string                                `graphql:"note"`
	Operation NewsEventSourcePolicyRevisionOperation `graphql:"operation"`
	Revision  int                                    `graphql:"revision"`
}

// NewsEventSourcePolicySettingsModel is the GraphQL
// NewsEventSourcePolicySettingsModel object.
type NewsEventSourcePolicySettingsModel struct {
	ActiveRevision       int                                         `graphql:"activeRevision"`
	AuthoritativeDomains []string                                    `graphql:"authoritativeDomains"`
	AuthoritativeLabels  []string                                    `graphql:"authoritativeLabels"`
	BlogDomains          []string                                    `graphql:"blogDomains"`
	BlogLabels           []string                                    `graphql:"blogLabels"`
	CategoryAuthority    []NewsEventSourceCategoryAuthorityRuleModel `graphql:"categoryAuthority"`
	Overrides            NewsEventSourcePolicyDeltaModel             `graphql:"overrides"`
	Revisions            []NewsEventSourcePolicyRevisionModel        `graphql:"revisions"`
	SyncWarnings         []string                                    `graphql:"syncWarnings"`
	UpdatedAt            *time.Time                                  `graphql:"updatedAt"`
	Warnings             NewsEventSourcePolicyConflictModel          `graphql:"warnings"`
}

// NewsEventSourcePolicyPresetSettingsModel is the GraphQL
// NewsEventSourcePolicyPresetSettingsModel object. A preset keeps no revision
// history.
type NewsEventSourcePolicyPresetSettingsModel struct {
	AuthoritativeDomains []string                                    `graphql:"authoritativeDomains"`
	AuthoritativeLabels  []string                                    `graphql:"authoritativeLabels"`
	BlogDomains          []string                                    `graphql:"blogDomains"`
	BlogLabels           []string                                    `graphql:"blogLabels"`
	CategoryAuthority    []NewsEventSourceCategoryAuthorityRuleModel `graphql:"categoryAuthority"`
	SyncWarnings         []string                                    `graphql:"syncWarnings"`
	UpdatedAt            *time.Time                                  `graphql:"updatedAt"`
}

// NewsEventSourcePolicyRevisionDiffModel is the GraphQL
// NewsEventSourcePolicyRevisionDiffModel object: the effective-list add/remove
// diff between two revision snapshots.
type NewsEventSourcePolicyRevisionDiffModel struct {
	AuthoritativeDomainsAdd    []string `graphql:"authoritativeDomainsAdd"`
	AuthoritativeDomainsRemove []string `graphql:"authoritativeDomainsRemove"`
	AuthoritativeLabelsAdd     []string `graphql:"authoritativeLabelsAdd"`
	AuthoritativeLabelsRemove  []string `graphql:"authoritativeLabelsRemove"`
	BaseRevision               int      `graphql:"baseRevision"`
	BlogDomainsAdd             []string `graphql:"blogDomainsAdd"`
	BlogDomainsRemove          []string `graphql:"blogDomainsRemove"`
	BlogLabelsAdd              []string `graphql:"blogLabelsAdd"`
	BlogLabelsRemove           []string `graphql:"blogLabelsRemove"`
	TargetRevision             int      `graphql:"targetRevision"`
}

// NewsEventSourcePolicySyncStatusModel is the GraphQL
// NewsEventSourcePolicySyncStatusModel object.
type NewsEventSourcePolicySyncStatusModel struct {
	Degraded                     bool     `graphql:"degraded"`
	ForceAuthoritativeMode       bool     `graphql:"forceAuthoritativeMode"`
	ForceMinAuthoritativeSources int      `graphql:"forceMinAuthoritativeSources"`
	PolicyCacheStale             bool     `graphql:"policyCacheStale"`
	PresetCacheStale             bool     `graphql:"presetCacheStale"`
	WarningCodes                 []string `graphql:"warningCodes"`
}

// KnowledgeGraphReviewArticleModel is the GraphQL
// KnowledgeGraphReviewArticleModel object.
type KnowledgeGraphReviewArticleModel struct {
	CrawlAt  time.Time `graphql:"crawlAt"`
	ID       string    `graphql:"id"`
	Language *string   `graphql:"language"`
	Summary  *string   `graphql:"summary"`
	Title    *string   `graphql:"title"`
	URL      string    `graphql:"url"`
}

// KnowledgeGraphNodeModel is the GraphQL KnowledgeGraphNodeModel object. The
// name comes from the canonicalName column; properties stays a raw JSON scalar.
type KnowledgeGraphNodeModel struct {
	ID         string           `graphql:"id"`
	Name       string           `graphql:"name"`
	Properties *json.RawMessage `graphql:"properties"`
	Type       string           `graphql:"type"`
}

// KnowledgeGraphReviewEdgeModel is the GraphQL
// KnowledgeGraphReviewEdgeModel object.
type KnowledgeGraphReviewEdgeModel struct {
	Confidence float64                 `graphql:"confidence"`
	FromEntity KnowledgeGraphNodeModel `graphql:"fromEntity"`
	ID         string                  `graphql:"id"`
	Properties *json.RawMessage        `graphql:"properties"`
	ToEntity   KnowledgeGraphNodeModel `graphql:"toEntity"`
	Type       string                  `graphql:"type"`
	Weight     float64                 `graphql:"weight"`
}

// KnowledgeGraphEvidenceReviewItemModel is the GraphQL
// KnowledgeGraphEvidenceReviewItemModel object.
type KnowledgeGraphEvidenceReviewItemModel struct {
	Article          KnowledgeGraphReviewArticleModel `graphql:"article"`
	Confidence       *float64                         `graphql:"confidence"`
	CreatedAt        time.Time                        `graphql:"createdAt"`
	Edge             KnowledgeGraphReviewEdgeModel    `graphql:"edge"`
	Evidence         *json.RawMessage                 `graphql:"evidence"`
	ExtractorVersion *string                          `graphql:"extractorVersion"`
	ID               string                           `graphql:"id"`
}
