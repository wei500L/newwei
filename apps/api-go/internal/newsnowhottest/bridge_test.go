package newsnowhottest

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

func TestIsBridgeEligible(t *testing.T) {
	service := &Service{}
	signal := Signal{SignalSeed: SignalSeed{SourceID: "cls-hot", URL: "https://example.com/a"}}
	if !service.isBridgeEligible(signal, ContentArticle, 0.52, false) {
		t.Fatal("eligible signal rejected")
	}
	if service.isBridgeEligible(signal, ContentArticle, 0.51, false) {
		t.Fatal("score below threshold accepted")
	}
	if !service.isBridgeEligible(signal, ContentMixed, 0.2, true) {
		t.Fatal("model suggestion must allow a low score")
	}
	if service.isBridgeEligible(signal, ContentDiscussion, 1, true) {
		t.Fatal("discussion must never be eligible")
	}
	if service.isBridgeEligible(signal, ContentVideo, 1, true) {
		t.Fatal("video must never be eligible")
	}
	other := Signal{SignalSeed: SignalSeed{SourceID: "not-whitelisted", URL: "https://example.com/a"}}
	if service.isBridgeEligible(other, ContentArticle, 1, true) {
		t.Fatal("non-whitelisted source must be rejected")
	}
	noScheme := Signal{SignalSeed: SignalSeed{SourceID: "cls-hot", URL: "ftp://example.com/a"}}
	if service.isBridgeEligible(noScheme, ContentArticle, 1, true) {
		t.Fatal("non-http URL must be rejected")
	}
}

type recordingBridge struct {
	mu     sync.Mutex
	inputs []itemsingest.CreateItemInput
	orgID  string
	userID string
}

func (b *recordingBridge) CreateItem(_ context.Context, orgID, userID string, input itemsingest.CreateItemInput) (itemsingest.CreateItemResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.orgID = orgID
	b.userID = userID
	b.inputs = append(b.inputs, input)
	meta := itemsreading.ItemMetaRow{ID: fmt.Sprintf("item-%d", len(b.inputs))}
	return itemsingest.CreateItemResult{Meta: meta, RawItemID: "raw"}, nil
}

func TestBridgeEligibleItemsFiltersAndWritesBack(t *testing.T) {
	bridge := &recordingBridge{}
	service := NewService(Options{Bridge: bridge})
	signals := make([]Signal, 0, 4)
	for index, rank := range []int{1, 2, 4, 3} {
		signals = append(signals, Signal{
			SignalSeed: SignalSeed{
				SignalKey:         fmt.Sprintf("k%d", index),
				SourceID:          "cls-hot",
				SourceName:        "财联社",
				ItemID:            fmt.Sprintf("i%d", index),
				Title:             fmt.Sprintf("标题%d", index),
				URL:               fmt.Sprintf("https://example.com/%d", index),
				Rank:              rank,
				HeatText:          stringOrNull("1.2万"),
				SourceUpdatedTime: nullableString{},
			},
			CapturedAt: "2026-10-20T12:00:00.000Z",
		})
	}
	analysis := map[string]AnalyzedItem{
		"k0": {BridgeEligible: true, CandidateScore: 0.7, Theme: "主题", CandidateLabel: "标签"},
		"k1": {BridgeEligible: true, CandidateScore: 0.6, Theme: "主题", CandidateLabel: "标签"},
		// Rank above the threshold.
		"k2": {BridgeEligible: true, CandidateScore: 0.9, Theme: "主题", CandidateLabel: "标签"},
		// Below the candidate threshold.
		"k3": {BridgeEligible: true, CandidateScore: 0.4, Theme: "主题", CandidateLabel: "标签"},
	}
	service.bridgeEligibleItems(context.Background(), "org-1", "user-1", signals, analysis)
	if len(bridge.inputs) != 2 {
		t.Fatalf("bridged = %d, want 2", len(bridge.inputs))
	}
	if bridge.orgID != "org-1" || bridge.userID != "user-1" {
		t.Fatalf("identity = %s/%s", bridge.orgID, bridge.userID)
	}
	first := bridge.inputs[0]
	for _, input := range bridge.inputs {
		if input.Name == "财联社: 标题0" {
			first = input
			break
		}
	}
	if first.Name != "财联社: 标题0" || len(first.Name) > 255 {
		t.Fatalf("name = %q", first.Name)
	}
	if first.ExternalID != buildBridgeExternalId("cls-hot", "https://example.com/0") {
		t.Fatalf("external id = %q", first.ExternalID)
	}
	var payload struct {
		URL          string   `json:"url"`
		SourceName   string   `json:"sourceName"`
		Tags         []string `json:"tags"`
		SummaryHints []string `json:"summaryHints"`
		ForceRefresh bool     `json:"forceRefresh"`
		Metadata     struct {
			Newsnow struct {
				SourceID   string         `json:"sourceId"`
				ItemID     string         `json:"itemId"`
				Rank       int            `json:"rank"`
				HeatText   nullableString `json:"heatText"`
				CapturedAt string         `json:"capturedAt"`
			} `json:"newsnow"`
			HottestAnalysis struct {
				Theme          string  `json:"theme"`
				CandidateLabel string  `json:"candidateLabel"`
				CandidateScore float64 `json:"candidateScore"`
			} `json:"hottestAnalysis"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(first.Payload, &payload); err != nil {
		t.Fatalf("payload decode: %v (%s)", err, first.Payload)
	}
	if payload.URL != "https://example.com/0" || payload.SourceName != "财联社" || payload.ForceRefresh {
		t.Fatalf("payload = %+v", payload)
	}
	if len(payload.Tags) != 3 || payload.Tags[0] != "newsnow" || payload.Tags[1] != "hottest" || payload.Tags[2] != "cls-hot" {
		t.Fatalf("tags = %v", payload.Tags)
	}
	if len(payload.SummaryHints) == 0 || payload.SummaryHints[0] != "主题" {
		t.Fatalf("hints = %v", payload.SummaryHints)
	}
	if payload.Metadata.Newsnow.SourceID != "cls-hot" || payload.Metadata.Newsnow.ItemID != "i0" ||
		payload.Metadata.Newsnow.Rank != 1 || payload.Metadata.Newsnow.HeatText.Value != "1.2万" {
		t.Fatalf("newsnow metadata = %+v", payload.Metadata.Newsnow)
	}
	if payload.Metadata.HottestAnalysis.CandidateScore != 0.7 {
		t.Fatalf("hottest metadata = %+v", payload.Metadata.HottestAnalysis)
	}
	updated := analysis["k0"]
	if updated.MatchedItemID == nil || len(*updated.MatchedItemID) == 0 || updated.BridgeStatus != BridgeStatusQueued {
		t.Fatalf("analysis write-back = %+v", updated)
	}
	// The two creates run concurrently, so only membership is deterministic.
	createdIDs := map[string]struct{}{"item-1": {}, "item-2": {}}
	if _, ok := createdIDs[*updated.MatchedItemID]; !ok {
		t.Fatalf("unexpected created id %q", *updated.MatchedItemID)
	}
}
