// Package archivereading registers the three archive read roots on the shared
// GraphQL executor. The roots require items.read and expose exactly the SDL
// models: no rerankScore is added to ArchiveEventItemModel because the public
// contract does not have it.
package archivereading

import (
	"time"

	domain "github.com/wei500L/newwei/apps/api-go/internal/archivereading"
)

// ArchivePreparationStatusModel is the preparation projection.
type ArchivePreparationStatusModel struct {
	State        string    `graphql:"state"`
	ReadyCount   int       `graphql:"readyCount"`
	MissingCount int       `graphql:"missingCount"`
	UpdatedAt    time.Time `graphql:"updatedAt"`
	ErrorMessage *string   `graphql:"errorMessage"`
}

// ArchiveEventItemModel is one digest item.
type ArchiveEventItemModel struct {
	ProcessedArticleID string     `graphql:"processedArticleId"`
	EventID            *string    `graphql:"eventId"`
	Title              *string    `graphql:"title"`
	Summary            *string    `graphql:"summary"`
	CountryLabel       *string    `graphql:"countryLabel"`
	Region             string     `graphql:"region"`
	Vertical           string     `graphql:"vertical"`
	Weight             int        `graphql:"weight"`
	QualityScore       *float64   `graphql:"qualityScore"`
	PublishedAt        *time.Time `graphql:"publishedAt"`
	SortAt             time.Time  `graphql:"sortAt"`
	SourceLabel        *string    `graphql:"sourceLabel"`
	SourceURL          *string    `graphql:"sourceUrl"`
	EntityTags         []string   `graphql:"entityTags"`
	KeywordHighlights  []string   `graphql:"keywordHighlights"`
	MatchOrigin        *string    `graphql:"matchOrigin"`
	RelevanceScore     *float64   `graphql:"relevanceScore"`
}

// ArchiveVerticalPageInfoModel is the per-vertical cursor page info.
type ArchiveVerticalPageInfoModel struct {
	HasMore    bool    `graphql:"hasMore"`
	NextCursor *string `graphql:"nextCursor"`
}

// ArchiveVerticalGroupModel is one of the always-five digest groups.
type ArchiveVerticalGroupModel struct {
	Vertical    string                       `graphql:"vertical"`
	DisplayName string                       `graphql:"displayName"`
	TotalCount  int                          `graphql:"totalCount"`
	Items       []ArchiveEventItemModel      `graphql:"items"`
	PageInfo    ArchiveVerticalPageInfoModel `graphql:"pageInfo"`
}

// ArchiveDigestModel is the archiveDigest payload.
type ArchiveDigestModel struct {
	AnchorDate  time.Time                     `graphql:"anchorDate"`
	Region      string                        `graphql:"region"`
	TotalCount  int                           `graphql:"totalCount"`
	Groups      []ArchiveVerticalGroupModel   `graphql:"groups"`
	Preparation ArchivePreparationStatusModel `graphql:"preparation"`
}

// ArchiveCalendarDayModel is one non-zero calendar bucket.
type ArchiveCalendarDayModel struct {
	Date  string `graphql:"date"`
	Count int    `graphql:"count"`
}

// ArchiveTimelineEntryModel is one event timeline row.
type ArchiveTimelineEntryModel struct {
	ID          string    `graphql:"id"`
	BucketStart time.Time `graphql:"bucketStart"`
	Title       *string   `graphql:"title"`
	Summary     *string   `graphql:"summary"`
}

// ArchiveRelatedArticleModel is one related event article.
type ArchiveRelatedArticleModel struct {
	ProcessedArticleID string     `graphql:"processedArticleId"`
	Title              *string    `graphql:"title"`
	Summary            *string    `graphql:"summary"`
	PublishedAt        *time.Time `graphql:"publishedAt"`
	SourceLabel        *string    `graphql:"sourceLabel"`
	SourceURL          *string    `graphql:"sourceUrl"`
}

// ArchiveClassificationScoreEntryModel is one five-vertical score row.
type ArchiveClassificationScoreEntryModel struct {
	Vertical       string  `graphql:"vertical"`
	RuleScore      float64 `graphql:"ruleScore"`
	EmbeddingScore float64 `graphql:"embeddingScore"`
	RerankScore    float64 `graphql:"rerankScore"`
	FusedScore     float64 `graphql:"fusedScore"`
}

// ArchiveClassificationDetailModel is the stale-aware detail classification.
type ArchiveClassificationDetailModel struct {
	Region                string                                 `graphql:"region"`
	Vertical              string                                 `graphql:"vertical"`
	TaxonomyVersion       string                                 `graphql:"taxonomyVersion"`
	PipelineVersion       string                                 `graphql:"pipelineVersion"`
	EmbeddingModel        string                                 `graphql:"embeddingModel"`
	RerankModel           string                                 `graphql:"rerankModel"`
	DecisionReason        string                                 `graphql:"decisionReason"`
	DecisionReasonI18nKey string                                 `graphql:"decisionReasonI18nKey"`
	IsStale               bool                                   `graphql:"isStale"`
	StaleReasons          []string                               `graphql:"staleReasons"`
	StaleReasonI18nKeys   []string                               `graphql:"staleReasonI18nKeys"`
	RuleSignals           []string                               `graphql:"ruleSignals"`
	ScoreEntries          []ArchiveClassificationScoreEntryModel `graphql:"scoreEntries"`
}

// ArchiveDetailModel is the archiveDetail payload.
type ArchiveDetailModel struct {
	ProcessedArticleID string                            `graphql:"processedArticleId"`
	EventID            *string                           `graphql:"eventId"`
	Title              *string                           `graphql:"title"`
	Summary            *string                           `graphql:"summary"`
	FullEntities       []string                          `graphql:"fullEntities"`
	SourceURL          *string                           `graphql:"sourceUrl"`
	SourceLabel        *string                           `graphql:"sourceLabel"`
	Classification     *ArchiveClassificationDetailModel `graphql:"classification"`
	Timeline           []ArchiveTimelineEntryModel       `graphql:"timeline"`
	RelatedArticles    []ArchiveRelatedArticleModel      `graphql:"relatedArticles"`
}

func convertDigest(result domain.DigestResult) ArchiveDigestModel {
	groups := make([]ArchiveVerticalGroupModel, 0, len(result.Groups))
	for _, group := range result.Groups {
		items := make([]ArchiveEventItemModel, 0, len(group.Items))
		for _, item := range group.Items {
			items = append(items, convertItem(item))
		}
		groups = append(groups, ArchiveVerticalGroupModel{
			Vertical:    string(group.Vertical),
			DisplayName: group.DisplayName,
			TotalCount:  group.TotalCount,
			Items:       items,
			PageInfo:    ArchiveVerticalPageInfoModel{HasMore: group.PageInfo.HasMore, NextCursor: group.PageInfo.NextCursor},
		})
	}
	return ArchiveDigestModel{
		AnchorDate: result.AnchorDate,
		Region:     string(result.Region),
		TotalCount: result.TotalCount,
		Groups:     groups,
		Preparation: ArchivePreparationStatusModel{
			State:        string(result.Preparation.State),
			ReadyCount:   result.Preparation.ReadyCount,
			MissingCount: result.Preparation.MissingCount,
			UpdatedAt:    result.Preparation.UpdatedAt,
			ErrorMessage: result.Preparation.ErrorMessage,
		},
	}
}

func convertItem(item domain.DigestItem) ArchiveEventItemModel {
	model := ArchiveEventItemModel{
		ProcessedArticleID: item.ProcessedArticleID,
		EventID:            item.EventID,
		Title:              item.Title,
		Summary:            item.Summary,
		CountryLabel:       item.CountryLabel,
		Region:             string(item.Region),
		Vertical:           string(item.Vertical),
		Weight:             item.Weight,
		QualityScore:       item.QualityScore,
		PublishedAt:        item.PublishedAt,
		SortAt:             item.SortAt,
		SourceLabel:        item.SourceLabel,
		SourceURL:          item.SourceURL,
		EntityTags:         nonNil(item.EntityTags),
		KeywordHighlights:  nonNil(item.KeywordHighlights),
		RelevanceScore:     item.RelevanceScore,
	}
	if item.MatchOrigin != nil {
		origin := string(*item.MatchOrigin)
		model.MatchOrigin = &origin
	}
	return model
}

func convertDetail(result domain.DetailResult) ArchiveDetailModel {
	model := ArchiveDetailModel{
		ProcessedArticleID: result.ProcessedArticleID,
		EventID:            result.EventID,
		Title:              result.Title,
		Summary:            result.Summary,
		FullEntities:       nonNil(result.FullEntities),
		SourceURL:          result.SourceURL,
		SourceLabel:        result.SourceLabel,
		Timeline:           make([]ArchiveTimelineEntryModel, 0, len(result.Timeline)),
		RelatedArticles:    make([]ArchiveRelatedArticleModel, 0, len(result.RelatedArticles)),
	}
	for _, entry := range result.Timeline {
		model.Timeline = append(model.Timeline, ArchiveTimelineEntryModel{
			ID: entry.ID, BucketStart: entry.BucketStart, Title: entry.Title, Summary: entry.Summary,
		})
	}
	for _, article := range result.RelatedArticles {
		model.RelatedArticles = append(model.RelatedArticles, ArchiveRelatedArticleModel{
			ProcessedArticleID: article.ProcessedArticleID,
			Title:              article.Title,
			Summary:            article.Summary,
			PublishedAt:        article.PublishedAt,
			SourceLabel:        article.SourceLabel,
			SourceURL:          article.SourceURL,
		})
	}
	if result.Classification != nil {
		classification := result.Classification
		entries := make([]ArchiveClassificationScoreEntryModel, 0, len(classification.ScoreEntries))
		for _, entry := range classification.ScoreEntries {
			entries = append(entries, ArchiveClassificationScoreEntryModel{
				Vertical: string(entry.Vertical), RuleScore: entry.RuleScore,
				EmbeddingScore: entry.EmbeddingScore, RerankScore: entry.RerankScore, FusedScore: entry.FusedScore,
			})
		}
		reasons := make([]string, 0, len(classification.StaleReasons))
		for _, reason := range classification.StaleReasons {
			reasons = append(reasons, string(reason))
		}
		model.Classification = &ArchiveClassificationDetailModel{
			Region:                string(classification.Region),
			Vertical:              string(classification.Vertical),
			TaxonomyVersion:       classification.TaxonomyVersion,
			PipelineVersion:       classification.PipelineVersion,
			EmbeddingModel:        classification.EmbeddingModel,
			RerankModel:           classification.RerankModel,
			DecisionReason:        string(classification.DecisionReason),
			DecisionReasonI18nKey: classification.DecisionReasonI18nKey,
			IsStale:               classification.IsStale,
			StaleReasons:          reasons,
			StaleReasonI18nKeys:   nonNil(classification.StaleReasonI18nKeys),
			RuleSignals:           nonNil(classification.RuleSignals),
			ScoreEntries:          entries,
		}
	}
	return model
}

func nonNil(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	return values
}
