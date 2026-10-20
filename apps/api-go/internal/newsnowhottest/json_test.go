package newsnowhottest

import (
	"encoding/json"
	"testing"
)

// Analysis fixture: the exact document JSON.stringify produces for the current
// NestJS response shape. Re-encoding it must be byte-identical so a cache entry
// written by either process keeps the same property order and omission rules.
const analysisFixture = `{"generatedAt":"2026-10-20T12:00:00.000Z","cached":false,"dataState":"ready","emptyReason":null,"diagnostics":{"sourcesRequested":2,"sourcesSucceeded":1,"sourcesFailed":1,"sourceItemsFetched":3},"sourcesAnalyzed":1,"itemsAnalyzed":1,"bySource":{"s1":{"i1":{"sourceId":"s1","itemId":"i1","clusterId":"c1","theme":"主题","candidateLabel":"标签","candidateSummary":null,"reason":"理由","topics":["a","b"],"entities":["实体"],"contentKind":"article","sourceCount":1,"heatScore":0.5,"freshnessScore":1,"candidateScore":0.6,"isNew":true,"isRising":false,"bridgeEligible":true,"bridgeStatus":"eligible","matchedItemId":"m1"}}},"candidates":[{"candidateId":"c1","label":"标签","summary":null,"reason":null,"themes":["主题"],"entities":["实体"],"sourceIds":["s1"],"sourceCount":1,"itemCount":1,"heatScore":0.5,"freshnessScore":1,"candidateScore":0.6,"itemRefs":[{"sourceId":"s1","itemId":"i1","title":"标题","matchedItemId":"m1"}]}],"errors":[{"sourceId":"s2","message":"boom"}]}`

const snapshotFixture = `{"signature":"sig","generatedAt":"2026-10-20T12:00:00.000Z","diagnostics":{"sourcesRequested":1,"sourcesSucceeded":1,"sourcesFailed":0,"sourceItemsFetched":1},"errors":[],"totalDomesticSourceCount":1,"globalMaxHeatValue":12000,"signalSeeds":[{"signalKey":"k1","sourceId":"s1","sourceName":"来源","sourceHome":"https://example.com","sourceUpdatedTime":"2026-10-20T11:59:00.000Z","itemId":"i1","title":"标题","url":"https://example.com/a","mobileUrl":null,"hoverSummary":"摘要","heatText":"1.2万","heatValue":12000,"rank":1,"normalizedTitle":"标题","authority":1}],"clusters":[{"clusterId":"c1","itemKeys":["k1"],"sourceIds":["s1"],"representativeTitle":"标题","totalHeatValue":12000,"maxHeatValue":12000,"avgRank":1}],"clusterInsights":[{"clusterId":"c1","theme":"主题","label":"标签","summary":"摘要","reason":null,"topics":["话题"],"entities":[{"name":"实体","type":null}],"contentKind":"article","bridgeEligibleSuggestion":true,"confidence":0.85}]}`

func TestAnalysisResponseJSONRoundTrip(t *testing.T) {
	var response AnalysisResponse
	if err := json.Unmarshal([]byte(analysisFixture), &response); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if response.EmptyReason.Valid {
		t.Fatal("emptyReason null must decode as absent")
	}
	item, ok := response.BySource.Lookup("s1", "i1")
	if !ok {
		t.Fatal("bySource lookup failed")
	}
	if item.MatchedItemID == nil || *item.MatchedItemID != "m1" {
		t.Fatalf("matchedItemId = %v", item.MatchedItemID)
	}
	if item.MatchedEventID != nil {
		t.Fatalf("matchedEventId must stay omitted: %v", item.MatchedEventID)
	}
	encoded, err := marshalJSON(response)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if string(encoded) != analysisFixture {
		t.Fatalf("round trip mismatch\n got: %s\nwant: %s", encoded, analysisFixture)
	}
}

func TestGlobalSnapshotJSONRoundTrip(t *testing.T) {
	var snapshot GlobalSnapshot
	if err := json.Unmarshal([]byte(snapshotFixture), &snapshot); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if len(snapshot.SignalSeeds) != 1 || snapshot.SignalSeeds[0].MobileURL.Valid {
		t.Fatalf("signal seed nulls decoded incorrectly: %+v", snapshot.SignalSeeds)
	}
	if len(snapshot.ClusterInsights) != 1 || snapshot.ClusterInsights[0].Summary.Value != "摘要" {
		t.Fatalf("insight decoded incorrectly: %+v", snapshot.ClusterInsights)
	}
	encoded, err := marshalJSON(snapshot)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if string(encoded) != snapshotFixture {
		t.Fatalf("round trip mismatch\n got: %s\nwant: %s", encoded, snapshotFixture)
	}
}

func TestSignalStateJSONRoundTrip(t *testing.T) {
	withRank := `{"firstSeenAt":"2026-10-20T10:00:00.000Z","lastSeenAt":"2026-10-20T12:00:00.000Z","lastRank":3}`
	var state SignalState
	if err := json.Unmarshal([]byte(withRank), &state); err != nil {
		t.Fatalf("decode: %v", err)
	}
	encoded, err := marshalJSON(state)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if string(encoded) != withRank {
		t.Fatalf("state round trip = %s", encoded)
	}
	nullRank := `{"firstSeenAt":"2026-10-20T10:00:00.000Z","lastSeenAt":"2026-10-20T12:00:00.000Z","lastRank":null}`
	var nullState SignalState
	if err := json.Unmarshal([]byte(nullRank), &nullState); err != nil {
		t.Fatalf("decode null rank: %v", err)
	}
	encoded, err = marshalJSON(nullState)
	if err != nil {
		t.Fatalf("encode null rank: %v", err)
	}
	if string(encoded) != nullRank {
		t.Fatalf("null rank round trip = %s", encoded)
	}
}

func TestBySourceKeepsFirstPositionAndLastValue(t *testing.T) {
	fixture := `{"s1":{"i1":{"sourceId":"s1","itemId":"i1","clusterId":"a","theme":"t","candidateLabel":"l","candidateSummary":null,"reason":null,"topics":[],"entities":[],"contentKind":"unknown","sourceCount":1,"heatScore":0.1,"freshnessScore":0.1,"candidateScore":0.1,"isNew":false,"isRising":false,"bridgeEligible":false,"bridgeStatus":"not_supported"},"i2":{"sourceId":"s1","itemId":"i2","clusterId":"b","theme":"t","candidateLabel":"l","candidateSummary":null,"reason":null,"topics":[],"entities":[],"contentKind":"unknown","sourceCount":1,"heatScore":0.1,"freshnessScore":0.1,"candidateScore":0.1,"isNew":false,"isRising":false,"bridgeEligible":false,"bridgeStatus":"not_supported"},"i1":{"sourceId":"s1","itemId":"i1","clusterId":"c","theme":"t","candidateLabel":"l","candidateSummary":null,"reason":null,"topics":[],"entities":[],"contentKind":"unknown","sourceCount":1,"heatScore":0.1,"freshnessScore":0.1,"candidateScore":0.1,"isNew":false,"isRising":false,"bridgeEligible":false,"bridgeStatus":"not_supported"}}}`
	var bySource BySource
	if err := json.Unmarshal([]byte(fixture), &bySource); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(bySource.Groups) != 1 || len(bySource.Groups[0].Items) != 2 {
		t.Fatalf("groups = %+v", bySource.Groups)
	}
	if bySource.Groups[0].Items[0].ItemID != "i1" || bySource.Groups[0].Items[1].ItemID != "i2" {
		t.Fatalf("order = %+v", bySource.Groups[0].Items)
	}
	if bySource.Groups[0].Items[0].Item.ClusterID != "c" {
		t.Fatalf("last value must win: %+v", bySource.Groups[0].Items[0].Item)
	}
}

func TestNullableDatePreservesLiteral(t *testing.T) {
	var date nullableDate
	if err := json.Unmarshal([]byte(`1699999999999`), &date); err != nil {
		t.Fatalf("decode number: %v", err)
	}
	encoded, err := marshalJSON(date)
	if err != nil || string(encoded) != `1699999999999` {
		t.Fatalf("number date = %s (%v)", encoded, err)
	}
	if err := json.Unmarshal([]byte(`"刚刚"`), &date); err != nil {
		t.Fatalf("decode string: %v", err)
	}
	encoded, err = marshalJSON(date)
	if err != nil || string(encoded) != `"刚刚"` {
		t.Fatalf("string date = %s (%v)", encoded, err)
	}
	var missing nullableDate
	encoded, err = marshalJSON(missing)
	if err != nil || string(encoded) != "null" {
		t.Fatalf("missing date = %s (%v)", encoded, err)
	}
}
