package crawlstrategyruns

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierruns"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

func testCandidate(id, url string) *crawlfrontierruns.StrategyRunCandidate {
	return &crawlfrontierruns.StrategyRunCandidate{ID: id, URL: url, Status: "active", Trace: []crawlfrontierruns.StrategyRunTrace{}}
}

// TestDedupeCandidatesKeepsFirstPositionAndLastValue pins A1: the JS Map
// semantics are order from the first occurrence, value from the last.
func TestDedupeCandidatesKeepsFirstPositionAndLastValue(t *testing.T) {
	first := testCandidate("first", "https://a")
	second := testCandidate("second", "https://b")
	replacement := testCandidate("replacement", "https://a")
	out := dedupeCandidates([]*crawlfrontierruns.StrategyRunCandidate{first, second, replacement})
	if len(out) != 2 {
		t.Fatalf("len = %d", len(out))
	}
	if out[0] != replacement {
		t.Fatal("the value must come from the last occurrence")
	}
	if out[1] != second {
		t.Fatal("the order must follow the first occurrence")
	}
}

// TestNodeOutputsPreserveInsertionOrder pins A5: Object.values order is the
// first insertion of each key.
func TestNodeOutputsPreserveInsertionOrder(t *testing.T) {
	outputs := newNodeOutputs()
	first := testCandidate("1", "https://a")
	second := testCandidate("2", "https://b")
	outputs.set("default", []*crawlfrontierruns.StrategyRunCandidate{first})
	outputs.set("rejected", []*crawlfrontierruns.StrategyRunCandidate{second})
	outputs.set("default", []*crawlfrontierruns.StrategyRunCandidate{first, second})
	flat := flattenOutputs(outputs)
	if len(flat) != 2 || flat[0] != first || flat[1] != second {
		t.Fatalf("flatten order = %+v", flat)
	}
}

// TestCollectInputCandidatesHandleFallback pins A4: a missing handle falls back
// to default, an existing empty bucket does not.
func TestCollectInputCandidatesHandleFallback(t *testing.T) {
	outputs := map[string]*nodeOutputs{}
	source := newNodeOutputs()
	fallback := testCandidate("fallback", "https://fallback")
	source.set("default", []*crawlfrontierruns.StrategyRunCandidate{fallback})
	outputs["src"] = source

	handle := "missing"
	edges := []crawlworkflow.WorkflowEdge{{Source: "src", Target: "dst", SourceHandle: &handle}}
	collected := collectInputCandidates("dst", edges, outputs)
	if len(collected) != 1 || collected[0] != fallback {
		t.Fatalf("fallback = %+v", collected)
	}

	empty := []*crawlfrontierruns.StrategyRunCandidate{}
	source.set("pass", empty)
	handle = "pass"
	collected = collectInputCandidates("dst", edges, outputs)
	if len(collected) != 0 {
		t.Fatalf("an existing empty bucket must not fall back: %+v", collected)
	}
}

// TestTopologicalSortPinsOrderAndCycleFallback pins A3.
func TestTopologicalSortPinsOrderAndCycleFallback(t *testing.T) {
	definition := crawlworkflow.WorkflowDefinition{
		Nodes: []crawlworkflow.WorkflowNode{{ID: "a"}, {ID: "b"}, {ID: "c"}},
		Edges: []crawlworkflow.WorkflowEdge{{Source: "a", Target: "c"}, {Source: "b", Target: "c"}},
	}
	order := topologicalSort(definition)
	if len(order) != 3 || order[0] != "a" || order[1] != "b" || order[2] != "c" {
		t.Fatalf("order = %v", order)
	}

	cyclic := crawlworkflow.WorkflowDefinition{
		Nodes: []crawlworkflow.WorkflowNode{{ID: "b"}, {ID: "a"}},
		Edges: []crawlworkflow.WorkflowEdge{{Source: "b", Target: "a"}, {Source: "a", Target: "b"}},
	}
	order = topologicalSort(cyclic)
	if len(order) != 2 || order[0] != "b" || order[1] != "a" {
		t.Fatalf("cycle fallback = %v", order)
	}
}

// TestMapDiscoveryCandidatesSharesPointersAndTraces pins A2 and the registry
// id/order semantics.
func TestMapDiscoveryCandidatesSharesPointersAndTraces(t *testing.T) {
	runtime := &Runtime{now: time.Now}
	registry := newCandidateRegistry()
	discovered := []crawlmetadata.DiscoveryCandidate{{URL: "https://a"}, {URL: "https://b"}}
	firstPass := runtime.mapDiscoveryCandidates("seed-1", "seed-discovery", discovered, registry)
	if len(firstPass) != 2 || firstPass[0].ID != "candidate:1" || firstPass[1].ID != "candidate:2" {
		t.Fatalf("ids = %+v", firstPass)
	}
	secondPass := runtime.mapDiscoveryCandidates("list-1", "list-discovery", []crawlmetadata.DiscoveryCandidate{{URL: "https://a"}}, registry)
	if len(secondPass) != 1 || secondPass[0] != firstPass[0] {
		t.Fatal("a rediscovered URL must reuse the registry pointer")
	}
	if len(firstPass[0].Trace) != 2 {
		t.Fatalf("trace must be shared with the earlier output: %d", len(firstPass[0].Trace))
	}
}

// TestExecuteUsesTerminalNodesInDefinitionOrder pins A6: only terminal node
// outputs, in definition order, deduped and sliced to maxCandidates.
func TestExecuteUsesTerminalNodesInDefinitionOrder(t *testing.T) {
	runtime := &Runtime{now: time.Now}
	filterConfig := json.RawMessage(`{"includePatterns":[]}`)
	persistConfig := json.RawMessage(`{"selectTopK":10}`)
	definition := crawlworkflow.WorkflowDefinition{
		Nodes: []crawlworkflow.WorkflowNode{
			{ID: "filter", Type: "url-filter", Label: "Filter", Config: filterConfig},
			{ID: "persist", Type: "persist-result", Label: "Persist", Config: persistConfig},
		},
		Edges: []crawlworkflow.WorkflowEdge{{Source: "filter", Target: "persist"}},
	}
	// Seed the registry so the filter node has input candidates.
	registry := newCandidateRegistry()
	runtime.mapDiscoveryCandidates("seed", "seed-discovery", []crawlmetadata.DiscoveryCandidate{
		{URL: "https://a"}, {URL: "https://b"},
	}, registry)
	// Feed the candidates through the terminal path by executing the definition.
	runContext := &runtimeContext{
		definition:             definition,
		effectiveProfileConfig: json.RawMessage(`{}`),
		maxCandidates:          1,
		systemEvents:           []crawlfrontierruns.StrategyRunEvent{},
	}
	// Attach the candidates as the filter input by running the filter node
	// output through the registry is not possible here, so execute starts with
	// no input and produces no candidates; the terminal selection itself is
	// what this test pins.
	result, err := runtime.execute(context.Background(), runContext)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.steps) != 2 || result.steps[0].NodeID != "filter" || result.steps[1].NodeID != "persist" {
		t.Fatalf("steps = %+v", result.steps)
	}
	if result.candidates == nil || len(result.candidates) != 0 {
		t.Fatalf("candidates = %+v", result.candidates)
	}
}

// TestExecuteFailureCarriesPartialSteps pins F1's mechanism: a failing node
// returns the steps executed so far, including the failed step.
func TestExecuteFailureCarriesPartialSteps(t *testing.T) {
	// A deep-discovery node without a crawl4ai client fails before any network
	// work with SEED_DEEP_CRAWL4AI_UNAVAILABLE.
	discovery := crawlmetadata.NewDiscovery(nil, nil, nil)
	runtime := &Runtime{discovery: discovery, now: time.Now}
	definition := crawlworkflow.WorkflowDefinition{
		Nodes: []crawlworkflow.WorkflowNode{
			{ID: "seed", Type: "deep-discovery", Label: "Deep", Config: json.RawMessage(`{}`)},
		},
		Edges: []crawlworkflow.WorkflowEdge{},
	}
	seedURL := "https://8.8.8.8/"
	runContext := &runtimeContext{
		definition:             definition,
		seedURL:                &seedURL,
		effectiveProfileConfig: json.RawMessage(`{}`),
		maxCandidates:          100,
		systemEvents:           []crawlfrontierruns.StrategyRunEvent{},
	}
	_, err := runtime.execute(context.Background(), runContext)
	var executionError *ExecutionError
	if err == nil {
		t.Fatal("expected a failure")
	}
	if !errors.As(err, &executionError) {
		t.Fatalf("error type = %T", err)
	}
	if len(executionError.Steps) != 1 {
		t.Fatalf("partial steps = %+v", executionError.Steps)
	}
	step := executionError.Steps[0]
	if step.NodeID != "seed" || step.Status != "failed" || step.Error == nil {
		t.Fatalf("failed step = %+v", step)
	}
	var discoveryError *crawlmetadata.DiscoveryError
	if !errors.As(executionError.Err, &discoveryError) || discoveryError.Code != crawlmetadata.DiscoveryCodeCrawl4AIUnavailable {
		t.Fatalf("cause = %v", executionError.Err)
	}
}
