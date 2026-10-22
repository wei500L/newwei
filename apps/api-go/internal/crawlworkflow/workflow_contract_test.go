package crawlworkflow

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// This file pins the pure (no MySQL) contracts of the crawl strategy workflow
// unit: the class-validator message lists the DTO layer must reproduce, the
// normalizeWorkflowDefinition defaults, the draftDefinition policy guard and the
// three version-diff builders. Reference implementation:
// apps/api/src/modules/crawl/crawl-strategy-workflow.service.ts
// (normalizeWorkflowDefinition / buildSettingsDiff / buildNodeDiff /
// buildEdgeDiff) and apps/api/src/modules/crawl/crawl-strategy.dto.ts.

func rawField(key, value string) orderedField {
	return orderedField{Key: key, Value: json.RawMessage(value)}
}

func inputMessage(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected a validation error, got nil")
	}
	var input *inputError
	if !errors.As(err, &input) {
		t.Fatalf("expected *inputError, got %T: %v", err, err)
	}
	return input.Message
}

// TestValidateCreateWorkflowMessages pins the message list and its order: the
// decorator application order is reversed by class-validator, so a missing name
// reports MaxLength, IsNotEmpty and IsString in that sequence.
func TestValidateCreateWorkflowMessages(t *testing.T) {
	cases := []struct {
		name   string
		fields []orderedField
		want   string
	}{
		{
			name:   "missing name",
			fields: nil,
			want: "name must be shorter than or equal to 200 characters; " +
				"name should not be empty; name must be a string",
		},
		{
			name:   "non string name",
			fields: []orderedField{rawField("name", "42")},
			want: "name must be shorter than or equal to 200 characters; " +
				"name must be a string",
		},
		{
			name:   "empty name",
			fields: []orderedField{rawField("name", `""`)},
			want:   "name should not be empty",
		},
		{
			name:   "too long name",
			fields: []orderedField{rawField("name", `"`+strings.Repeat("a", 201)+`"`)},
			want:   "name must be shorter than or equal to 200 characters",
		},
		{
			name:   "unknown field",
			fields: []orderedField{rawField("name", `"ok"`), rawField("extra", `1`)},
			want:   "property extra should not exist",
		},
		{
			name:   "description must be a string",
			fields: []orderedField{rawField("name", `"ok"`), rawField("description", `3`)},
			want: "description must be shorter than or equal to 500 characters; " +
				"description must be a string",
		},
		{
			name:   "draftDefinition must be an object",
			fields: []orderedField{rawField("name", `"ok"`), rawField("draftDefinition", `[]`)},
			want:   "draftDefinition must be an object",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := validateCreateWorkflow(testCase.fields)
			if got := inputMessage(t, err); got != testCase.want {
				t.Fatalf("message = %q, want %q", got, testCase.want)
			}
		})
	}

	input, err := validateCreateWorkflow([]orderedField{
		rawField("name", `"  Keep me  "`),
		rawField("description", `"  hello  "`),
		rawField("draftDefinition", `{"nodes":[]}`),
	})
	if err != nil {
		t.Fatalf("valid body rejected: %v", err)
	}
	// The DTO layer keeps name verbatim (the service trims it, defect 2) while
	// description is already normalized to its trimmed form.
	if input.Name != "  Keep me  " {
		t.Fatalf("name = %q, want the untrimmed raw value", input.Name)
	}
	if input.Description == nil || *input.Description != "hello" {
		t.Fatalf("description = %v, want the trimmed value", input.Description)
	}
	if len(input.DraftDefinition) == 0 {
		t.Fatal("draftDefinition should be forwarded to the service")
	}
}

// TestValidateUpdateDraftRequiresDefinitionAndFlagsNullName pins the update
// draft rules: draftDefinition is mandatory (@IsObject without @IsOptional) and
// a null name is carried as a flag so the service can mirror the NestJS
// `null.trim()` TypeError as a 500 instead of a 400.
func TestValidateUpdateDraftRequiresDefinitionAndFlagsNullName(t *testing.T) {
	_, err := validateUpdateDraft([]orderedField{rawField("draftDefinition", `{"nodes":[]}`)})
	if err != nil {
		t.Fatalf("valid body rejected: %v", err)
	}

	_, err = validateUpdateDraft([]orderedField{rawField("name", `"x"`)})
	if got := inputMessage(t, err); got != "draftDefinition must be an object" {
		t.Fatalf("missing draftDefinition message = %q", got)
	}

	input, err := validateUpdateDraft([]orderedField{
		rawField("name", `null`),
		rawField("draftDefinition", `{}`),
	})
	if err != nil {
		t.Fatalf("null name should pass the DTO layer: %v", err)
	}
	if !input.NameIsNull || input.NamePresent {
		t.Fatalf("null name flags = present:%v null:%v", input.NamePresent, input.NameIsNull)
	}

	// A blank name passes @IsNotEmpty ("   " is non-empty) and must be caught by
	// the service-side trim, so the DTO layer only forwards it.
	blank, err := validateUpdateDraft([]orderedField{
		rawField("name", `"   "`),
		rawField("draftDefinition", `{}`),
	})
	if err != nil {
		t.Fatalf("blank name must reach the service: %v", err)
	}
	if !blank.NamePresent || blank.Name != "   " {
		t.Fatalf("blank name flags = present:%v value:%q", blank.NamePresent, blank.Name)
	}
}

// TestValidatePublishAndCompare messages.
func TestValidatePublishAndCompare(t *testing.T) {
	if _, err := validatePublish([]orderedField{rawField("versionName", `""`)}); inputMessage(t, err) != "versionName should not be empty" {
		t.Fatalf("versionName message = %q", inputMessage(t, err))
	}
	published, err := validatePublish([]orderedField{rawField("description", `null`)})
	if err != nil {
		t.Fatalf("null description rejected: %v", err)
	}
	if !published.DescriptionSet || published.Description != nil {
		t.Fatalf("description flags = set:%v value:%v", published.DescriptionSet, published.Description)
	}
	if published.VersionName != nil {
		t.Fatalf("absent versionName must stay nil, got %v", *published.VersionName)
	}

	_, err = validateCompare([]orderedField{rawField("leftVersionId", `"a"`)})
	want := "rightVersionId must be shorter than or equal to 191 characters; " +
		"rightVersionId should not be empty; rightVersionId must be a string"
	if got := inputMessage(t, err); got != want {
		t.Fatalf("compare message = %q, want %q", got, want)
	}
}

// TestValidateListQuery pins the query-string rules: only `search` is whitelisted
// and a repeated parameter is an array (so @IsString fails).
func TestValidateListQuery(t *testing.T) {
	search, err := validateListQuery("search=%20abc%20")
	if err != nil {
		t.Fatalf("valid query rejected: %v", err)
	}
	if search != " abc " {
		t.Fatalf("search = %q, want the raw decoded value", search)
	}
	if _, err := validateListQuery("other=1"); inputMessage(t, err) != "property other should not exist" {
		t.Fatalf("unknown query message = %q", inputMessage(t, err))
	}
	if _, err := validateListQuery("search=a&search=b"); inputMessage(t, err) != "search must be a string" {
		t.Fatalf("repeated query message = %q", inputMessage(t, err))
	}
}

// TestNormalizeDefinitionDefaults pins createEmptyWorkflowDefinition and the
// normalization of a partial definition: the seven default nodes and six edges
// stay when the input omits them, an unknown executionMode falls back to hybrid
// and edge entries without a source or target are dropped.
func TestNormalizeDefinitionDefaults(t *testing.T) {
	base := createEmptyWorkflowDefinition("")
	if len(base.Nodes) != 7 || len(base.Edges) != 6 {
		t.Fatalf("empty definition nodes/edges = %d/%d, want 7/6", len(base.Nodes), len(base.Edges))
	}
	if base.Settings.ExecutionMode != "hybrid" || base.Settings.RobotsPolicy != "respect" ||
		base.Settings.DomainScope != "registrable_domain" || base.Version != 1 {
		t.Fatalf("unexpected empty settings: %+v", base.Settings)
	}

	empty := normalizeDefinition(nil)
	if len(empty.Nodes) != 7 || len(empty.Edges) != 6 {
		t.Fatalf("nil definition nodes/edges = %d/%d, want the 7/6 defaults", len(empty.Nodes), len(empty.Edges))
	}

	normalized := normalizeDefinition([]byte(`{
		"settings":{"executionMode":"nonsense","robotsPolicy":"ignore","domainScope":"strict_hosts","maxDepth":9},
		"nodes":[{"type":"url-filter"},{"id":" custom ","label":"  L  "}],
		"edges":[{"source":"a"},{"source":"a","target":"b"}]
	}`))
	if normalized.Settings.ExecutionMode != "hybrid" {
		t.Fatalf("executionMode = %q, want hybrid", normalized.Settings.ExecutionMode)
	}
	if normalized.Settings.RobotsPolicy != "ignore" || normalized.Settings.DomainScope != "strict_hosts" {
		t.Fatalf("settings overrides lost: %+v", normalized.Settings)
	}
	if normalized.Settings.MaxDepth != 9 {
		t.Fatalf("maxDepth = %v, want 9", normalized.Settings.MaxDepth)
	}
	if len(normalized.Nodes) != 2 || normalized.Nodes[0].ID != "url-filter-1" ||
		normalized.Nodes[0].Label != "URL Filter" {
		t.Fatalf("schema defaults not applied: %+v", normalized.Nodes[0])
	}
	if normalized.Nodes[1].ID != "custom" || normalized.Nodes[1].Label != "L" {
		t.Fatalf("id/label not trimmed: %+v", normalized.Nodes[1])
	}
	if len(normalized.Edges) != 1 || normalized.Edges[0].ID != "edge-2" {
		t.Fatalf("edge without a target must be dropped: %+v", normalized.Edges)
	}
}

// TestAssertSupportedWorkflowDefinitionRejectsProxy pins the draftDefinition
// guard: the message path is built from the caller-supplied prefix.
func TestAssertSupportedWorkflowDefinitionRejectsProxy(t *testing.T) {
	definition := WorkflowDefinition{
		Nodes: []WorkflowNode{
			{ID: "n1", Type: "url-filter", Config: json.RawMessage(`{"crawlOptions":{"proxyUrl":"http://x"}}`)},
			{ID: "n2", Type: "url-filter", Config: json.RawMessage(`{"crawlOptions":{"proxyConfig":{"host":"x"}}}`)},
			{ID: "n3", Type: "url-filter", Config: json.RawMessage(`{"crawlOptions":{"check_robots_txt":true}}`)},
		},
	}
	err := assertSupportedWorkflowDefinition(definition, "draftDefinition")
	if got := inputMessage(t, err); got != "Unsupported crawl config: "+
		"draftDefinition.nodes[0].config.crawlOptions.proxyUrl: custom upstream proxies are not supported; "+
		"draftDefinition.nodes[1].config.crawlOptions.proxyConfig: custom upstream proxies are not supported" {
		t.Fatalf("policy message = %q", got)
	}
	if err := assertSupportedWorkflowDefinition(createEmptyWorkflowDefinition(""), "draftDefinition"); err != nil {
		t.Fatalf("the empty definition must pass the guard: %v", err)
	}
}

// TestBuildSettingsDiff pins the union/sort/changed-only rules of
// buildSettingsDiff.
func TestBuildSettingsDiff(t *testing.T) {
	left := createEmptyWorkflowDefinition("").Settings
	right := left
	if diff := buildSettingsDiff(left, right); len(diff) != 0 {
		t.Fatalf("identical settings diffed: %+v", diff)
	}
	right.MaxDepth = 5
	diff := buildSettingsDiff(left, right)
	if len(diff) != 1 || diff[0].Key != "maxDepth" {
		t.Fatalf("diff = %+v, want only maxDepth", diff)
	}
	if diff[0].Left == nil || diff[0].Right == nil {
		t.Fatalf("both sides must carry the value: %+v", diff[0])
	}
}

// TestBuildNodeAndEdgeDiff pins the identity rules: nodes match by id, edges by
// their JSON signature.
func TestBuildNodeAndEdgeDiff(t *testing.T) {
	leftNodes := []WorkflowNode{
		{ID: "a", Type: "url-filter", Label: "A", Config: json.RawMessage(`{}`)},
		{ID: "gone", Type: "url-filter", Label: "Gone"},
	}
	rightNodes := []WorkflowNode{
		{ID: "a", Type: "url-filter", Label: "A2", Config: json.RawMessage(`{}`)},
		{ID: "new", Type: "url-filter", Label: "New"},
	}
	diff := buildNodeDiff(leftNodes, rightNodes)
	if len(diff.Added) != 1 || diff.Added[0].ID != "new" {
		t.Fatalf("added = %+v", diff.Added)
	}
	if len(diff.Removed) != 1 || diff.Removed[0].ID != "gone" {
		t.Fatalf("removed = %+v", diff.Removed)
	}
	if len(diff.Changed) != 1 || diff.Changed[0].ID != "a" ||
		len(diff.Changed[0].ChangedFields) != 1 || diff.Changed[0].ChangedFields[0] != "label" {
		t.Fatalf("changed = %+v", diff.Changed)
	}

	edge := WorkflowEdge{ID: "e1", Source: "a", Target: "b"}
	edgeDiffResult := buildEdgeDiff([]WorkflowEdge{edge}, []WorkflowEdge{edge})
	if len(edgeDiffResult.Added) != 0 || len(edgeDiffResult.Removed) != 0 {
		t.Fatalf("identical edges diffed: %+v", edgeDiffResult)
	}
	moved := WorkflowEdge{ID: "e2", Source: "a", Target: "c"}
	edgeDiffResult = buildEdgeDiff([]WorkflowEdge{edge}, []WorkflowEdge{moved})
	if len(edgeDiffResult.Added) != 1 || len(edgeDiffResult.Removed) != 1 {
		t.Fatalf("edge diff = %+v", edgeDiffResult)
	}
}

// TestNodeSchemaRegistryIsParsable pins that the embedded registry (the
// node-schemas response body) stays a JSON array of schemas and that
// getNodeSchema indexes the same twelve types.
func TestNodeSchemaRegistryIsParsable(t *testing.T) {
	var entries []nodeSchemaInfo
	if err := json.Unmarshal([]byte(nodeSchemasJSON), &entries); err != nil {
		t.Fatalf("registry is not valid JSON: %v", err)
	}
	if len(entries) != 12 {
		t.Fatalf("registry entries = %d, want 12", len(entries))
	}
	for _, entry := range entries {
		schema, ok := getNodeSchema(entry.Type)
		if !ok || schema.DefaultLabel != entry.DefaultLabel {
			t.Fatalf("schema not indexed: %+v", entry)
		}
	}
	if _, ok := getNodeSchema("nope"); ok {
		t.Fatal("unknown node types must not resolve")
	}
	if len(CRAWL_STRATEGY_NODE_SCHEMAS) == 0 || CRAWL_STRATEGY_NODE_SCHEMAS[0] != '[' {
		t.Fatal("node-schemas response body must be a JSON array")
	}
}
