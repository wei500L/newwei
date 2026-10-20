package newsnowhottest

import (
	"bytes"
	"encoding/json"
	"errors"
)

// ContentKind is the coarse content class the model assigns to a cluster.
type ContentKind string

const (
	// ContentArticle is a crawlable news report.
	ContentArticle ContentKind = "article"
	// ContentDiscussion is a forum/thread discussion.
	ContentDiscussion ContentKind = "discussion"
	// ContentVideo is a short-video or streaming entry.
	ContentVideo ContentKind = "video"
	// ContentMixed mixes several content classes.
	ContentMixed ContentKind = "mixed"
	// ContentUnknown is the default when the model gave no usable value.
	ContentUnknown ContentKind = "unknown"
)

// EmptyReason explains why an analysis response has no candidates. The values
// are the NestJS enum members and are part of the HTTP contract.
type EmptyReason string

const (
	// EmptyNoHottestSourcesConfigured means the registry has no hottest column.
	EmptyNoHottestSourcesConfigured EmptyReason = "no_hottest_sources_configured"
	// EmptyAllSourcesFailed means every requested source failed.
	EmptyAllSourcesFailed EmptyReason = "all_sources_failed"
	// EmptyNoSourceItems means the sources returned no items.
	EmptyNoSourceItems EmptyReason = "no_source_items"
	// EmptyNoHotSignals means every returned item was unusable.
	EmptyNoHotSignals EmptyReason = "no_hot_signals"
	// EmptyNoCandidates means signals existed but no cluster passed the threshold.
	EmptyNoCandidates EmptyReason = "no_candidates"
)

// DataState is the two-value readiness marker shared with the domestic opinion
// index response.
type DataState string

const (
	// DataStateReady means the response carries candidates.
	DataStateReady DataState = "ready"
	// DataStateEmpty means the response carries no candidates.
	DataStateEmpty DataState = "empty"
)

// BridgeStatus is the item-bridge state of one analyzed signal.
type BridgeStatus string

const (
	// BridgeStatusExisting means the caller's organization already has the item.
	BridgeStatusExisting BridgeStatus = "existing"
	// BridgeStatusQueued means the auto-bridge created an ItemMeta.
	BridgeStatusQueued BridgeStatus = "queued"
	// BridgeStatusEligible means the signal could be imported by a writer.
	BridgeStatusEligible BridgeStatus = "eligible"
	// BridgeStatusNotSupported means the source/content kind is not importable.
	BridgeStatusNotSupported BridgeStatus = "not_supported"
)

// Diagnostics is the fetch counters payload. Property order is the NestJS
// object-literal order because the analysis document is cached as JSON.
type Diagnostics struct {
	SourcesRequested   int `json:"sourcesRequested"`
	SourcesSucceeded   int `json:"sourcesSucceeded"`
	SourcesFailed      int `json:"sourcesFailed"`
	SourceItemsFetched int `json:"sourceItemsFetched"`
}

// SourceError is one failed source fetch.
type SourceError struct {
	SourceID string `json:"sourceId"`
	Message  string `json:"message"`
}

// SignalState is the per-organization signal history document. LastRank is
// nullable exactly like the NestJS interface.
type SignalState struct {
	FirstSeenAt string      `json:"firstSeenAt"`
	LastSeenAt  string      `json:"lastSeenAt"`
	LastRank    nullableInt `json:"lastRank"`
}

// SignalSeed is one normalized hot-list entry before the organization sees it.
// It is embedded in the global snapshot cache document, so the member order and
// the nullable members are part of the cross-process contract.
type SignalSeed struct {
	SignalKey         string         `json:"signalKey"`
	SourceID          string         `json:"sourceId"`
	SourceName        string         `json:"sourceName"`
	SourceHome        nullableString `json:"sourceHome"`
	SourceUpdatedTime nullableString `json:"sourceUpdatedTime"`
	ItemID            string         `json:"itemId"`
	Title             string         `json:"title"`
	URL               string         `json:"url"`
	MobileURL         nullableString `json:"mobileUrl"`
	HoverSummary      nullableString `json:"hoverSummary"`
	HeatText          nullableString `json:"heatText"`
	HeatValue         nullableNumber `json:"heatValue"`
	Rank              int            `json:"rank"`
	NormalizedTitle   string         `json:"normalizedTitle"`
	Authority         float64        `json:"authority"`
}

// Signal is a seed enriched with the caller organization's freshness state. It
// is never serialized; it feeds the projection only.
type Signal struct {
	SignalSeed
	CapturedAt     string       `json:"capturedAt"`
	State          *SignalState `json:"state"`
	IsNew          bool         `json:"isNew"`
	IsRising       bool         `json:"isRising"`
	FreshnessScore float64      `json:"freshnessScore"`
}

// SignalCluster is one heuristic cluster of seeds.
type SignalCluster struct {
	ClusterID           string   `json:"clusterId"`
	ItemKeys            []string `json:"itemKeys"`
	SourceIDs           []string `json:"sourceIds"`
	RepresentativeTitle string   `json:"representativeTitle"`
	TotalHeatValue      float64  `json:"totalHeatValue"`
	MaxHeatValue        float64  `json:"maxHeatValue"`
	AvgRank             float64  `json:"avgRank"`
}

// InsightEntity is one named entity of a cluster insight.
type InsightEntity struct {
	Name string         `json:"name"`
	Type nullableString `json:"type"`
}

// ClusterInsight is the model-generated label of one cluster. Property order and
// the nullable members keep the cached snapshot readable by NestJS.
type ClusterInsight struct {
	ClusterID                string          `json:"clusterId"`
	Theme                    string          `json:"theme"`
	Label                    string          `json:"label"`
	Summary                  nullableString  `json:"summary"`
	Reason                   nullableString  `json:"reason"`
	Topics                   []string        `json:"topics"`
	Entities                 []InsightEntity `json:"entities"`
	ContentKind              ContentKind     `json:"contentKind"`
	BridgeEligibleSuggestion bool            `json:"bridgeEligibleSuggestion"`
	Confidence               float64         `json:"confidence"`
}

// GlobalSnapshot is the cross-organization hot snapshot cached under
// newsnow:hottest:global:v1:fresh|stale.
type GlobalSnapshot struct {
	Signature                string           `json:"signature"`
	GeneratedAt              string           `json:"generatedAt"`
	Diagnostics              Diagnostics      `json:"diagnostics"`
	Errors                   []SourceError    `json:"errors"`
	TotalDomesticSourceCount int              `json:"totalDomesticSourceCount"`
	GlobalMaxHeatValue       float64          `json:"globalMaxHeatValue"`
	SignalSeeds              []SignalSeed     `json:"signalSeeds"`
	Clusters                 []SignalCluster  `json:"clusters"`
	ClusterInsights          []ClusterInsight `json:"clusterInsights"`
}

// AnalyzedItem is one per-organization signal projection inside bySource.
// Optional match members are omitted when absent, exactly like the NestJS
// spread `...(matched ? {matchedItemId} : {})`.
type AnalyzedItem struct {
	SourceID         string         `json:"sourceId"`
	ItemID           string         `json:"itemId"`
	ClusterID        string         `json:"clusterId"`
	Theme            string         `json:"theme"`
	CandidateLabel   string         `json:"candidateLabel"`
	CandidateSummary nullableString `json:"candidateSummary"`
	Reason           nullableString `json:"reason"`
	Topics           []string       `json:"topics"`
	Entities         []string       `json:"entities"`
	ContentKind      ContentKind    `json:"contentKind"`
	SourceCount      int            `json:"sourceCount"`
	HeatScore        float64        `json:"heatScore"`
	FreshnessScore   float64        `json:"freshnessScore"`
	CandidateScore   float64        `json:"candidateScore"`
	IsNew            bool           `json:"isNew"`
	IsRising         bool           `json:"isRising"`
	BridgeEligible   bool           `json:"bridgeEligible"`
	BridgeStatus     BridgeStatus   `json:"bridgeStatus"`
	MatchedItemID    *string        `json:"matchedItemId,omitempty"`
	MatchedEventID   *string        `json:"matchedEventId,omitempty"`
}

// ItemRef is one signal reference of a candidate.
type ItemRef struct {
	SourceID       string  `json:"sourceId"`
	ItemID         string  `json:"itemId"`
	Title          string  `json:"title"`
	MatchedItemID  *string `json:"matchedItemId,omitempty"`
	MatchedEventID *string `json:"matchedEventId,omitempty"`
}

// EventCandidate is one importable event candidate of the response.
type EventCandidate struct {
	CandidateID    string         `json:"candidateId"`
	Label          string         `json:"label"`
	Summary        nullableString `json:"summary"`
	Reason         nullableString `json:"reason"`
	Themes         []string       `json:"themes"`
	Entities       []string       `json:"entities"`
	SourceIDs      []string       `json:"sourceIds"`
	SourceCount    int            `json:"sourceCount"`
	ItemCount      int            `json:"itemCount"`
	HeatScore      float64        `json:"heatScore"`
	FreshnessScore float64        `json:"freshnessScore"`
	CandidateScore float64        `json:"candidateScore"`
	ItemRefs       []ItemRef      `json:"itemRefs"`
}

// AnalysisResponse is the cached and returned hottest-analysis payload.
type AnalysisResponse struct {
	GeneratedAt     string           `json:"generatedAt"`
	Cached          bool             `json:"cached"`
	DataState       DataState        `json:"dataState"`
	EmptyReason     nullableString   `json:"emptyReason"`
	Diagnostics     Diagnostics      `json:"diagnostics"`
	SourcesAnalyzed int              `json:"sourcesAnalyzed"`
	ItemsAnalyzed   int              `json:"itemsAnalyzed"`
	BySource        BySource         `json:"bySource"`
	Candidates      []EventCandidate `json:"candidates"`
	Errors          []SourceError    `json:"errors"`
}

// BySource is the ordered `bySource` object. Go maps do not preserve insertion
// order, and the cached document must keep the signal order the NestJS code
// produced, so both levels are explicit slices with a custom JSON codec.
type BySource struct {
	Groups []bySourceGroup
}

type bySourceGroup struct {
	SourceID string
	Items    []bySourceItem
}

type bySourceItem struct {
	ItemID string
	Item   AnalyzedItem
}

// Add appends one analyzed item. A repeated item id keeps its first position
// and takes the newest value, which is what assigning to a JavaScript object
// property does. A repeated source id keeps its first position too.
func (b *BySource) Add(sourceID, itemID string, item AnalyzedItem) {
	for index := range b.Groups {
		if b.Groups[index].SourceID != sourceID {
			continue
		}
		group := &b.Groups[index]
		for itemIndex := range group.Items {
			if group.Items[itemIndex].ItemID == itemID {
				group.Items[itemIndex].Item = item
				return
			}
		}
		group.Items = append(group.Items, bySourceItem{ItemID: itemID, Item: item})
		return
	}
	b.Groups = append(b.Groups, bySourceGroup{
		SourceID: sourceID,
		Items:    []bySourceItem{{ItemID: itemID, Item: item}},
	})
}

// IsEmpty reports whether the object has no source keys.
func (b BySource) IsEmpty() bool { return len(b.Groups) == 0 }

// MarshalJSON writes the nested object in insertion order.
func (b BySource) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for groupIndex, group := range b.Groups {
		if groupIndex > 0 {
			buffer.WriteByte(',')
		}
		buffer.Write(encodeJSONString(group.SourceID))
		buffer.WriteString(":{")
		for itemIndex, item := range group.Items {
			if itemIndex > 0 {
				buffer.WriteByte(',')
			}
			buffer.Write(encodeJSONString(item.ItemID))
			buffer.WriteByte(':')
			encoded, err := marshalJSON(item.Item)
			if err != nil {
				return nil, err
			}
			buffer.Write(encoded)
		}
		buffer.WriteByte('}')
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// UnmarshalJSON walks the nested object while preserving key order. The
// documented duplicate-key behaviour of JavaScript objects is reproduced:
// the first position wins and the last value is kept.
func (b *BySource) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	opening, err := decoder.Token()
	if err != nil {
		return err
	}
	if opening != json.Delim('{') {
		return errors.New("newsnowhottest: bySource must be a JSON object")
	}
	groups := make([]bySourceGroup, 0, 8)
	groupIndex := make(map[string]int, 8)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return err
		}
		sourceID, ok := keyToken.(string)
		if !ok {
			return errors.New("newsnowhottest: bySource key must be a string")
		}
		innerOpening, err := decoder.Token()
		if err != nil {
			return err
		}
		if innerOpening != json.Delim('{') {
			return errors.New("newsnowhottest: bySource value must be a JSON object")
		}
		items := make([]bySourceItem, 0, 8)
		itemIndex := make(map[string]int, 8)
		for decoder.More() {
			itemToken, err := decoder.Token()
			if err != nil {
				return err
			}
			itemID, ok := itemToken.(string)
			if !ok {
				return errors.New("newsnowhottest: bySource item key must be a string")
			}
			var item AnalyzedItem
			if err := decoder.Decode(&item); err != nil {
				return err
			}
			if position, exists := itemIndex[itemID]; exists {
				items[position].Item = item
				continue
			}
			itemIndex[itemID] = len(items)
			items = append(items, bySourceItem{ItemID: itemID, Item: item})
		}
		if _, err := decoder.Token(); err != nil {
			return err
		}
		if position, exists := groupIndex[sourceID]; exists {
			groups[position].Items = items
			continue
		}
		groupIndex[sourceID] = len(groups)
		groups = append(groups, bySourceGroup{SourceID: sourceID, Items: items})
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	b.Groups = groups
	return nil
}

// ScoreBreakdown is the four-dimension score detail of a recommendation.
type ScoreBreakdown struct {
	Content       float64 `json:"content"`
	Collaborative float64 `json:"collaborative"`
	Source        float64 `json:"source"`
	Hotness       float64 `json:"hotness"`
	Final         float64 `json:"final"`
}

// RecommendedItem is one recommended feed entry.
type RecommendedItem struct {
	ID             string         `json:"id"`
	SourceID       string         `json:"sourceId"`
	SourceName     string         `json:"sourceName"`
	Title          string         `json:"title"`
	URL            string         `json:"url"`
	MobileURL      nullableString `json:"mobileUrl"`
	PubDate        nullableDate   `json:"pubDate"`
	Topics         []string       `json:"topics"`
	Entities       []string       `json:"entities"`
	MatchedItemID  *string        `json:"matchedItemId,omitempty"`
	MatchedEventID *string        `json:"matchedEventId,omitempty"`
	ReasonLabel    string         `json:"reasonLabel"`
	Score          float64        `json:"score"`
	ScoreBreakdown ScoreBreakdown `json:"scoreBreakdown"`
}

// RecommendedResponse is the GET /recommended payload.
type RecommendedResponse struct {
	Scope       string            `json:"scope"`
	GeneratedAt string            `json:"generatedAt"`
	Degraded    bool              `json:"degraded"`
	Items       []RecommendedItem `json:"items"`
}

// candidate is the in-memory scored recommendation before dedupe/sort. It keeps
// both optional matches so the dedupe key and the response can use them.
type candidate struct {
	ID                 string
	SourceID           string
	SourceName         string
	Title              string
	URL                string
	MobileURL          nullableString
	PubDate            nullableDate
	Domain             *string
	Topics             []string
	Entities           []string
	MatchedItemID      *string
	MatchedEventID     *string
	ContentScore       float64
	CollaborativeScore float64
	SourceScore        float64
	HotnessScore       float64
	FinalScore         float64
	ReasonLabel        string
}

// Lookup returns one analyzed item by source and item id.
func (b BySource) Lookup(sourceID, itemID string) (AnalyzedItem, bool) {
	for _, group := range b.Groups {
		if group.SourceID != sourceID {
			continue
		}
		for _, item := range group.Items {
			if item.ItemID == itemID {
				return item.Item, true
			}
		}
	}
	return AnalyzedItem{}, false
}
