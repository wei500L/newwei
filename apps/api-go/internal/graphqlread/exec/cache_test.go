package exec

import (
	"testing"

	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/parser"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// planForTest parses a document and returns the Plan fields ResponseCacheable
// and cacheKey read. It needs no schema and no registry: both functions only look
// at the operation AST, the operation name, the raw variables and the query text.
func planForTest(t *testing.T, query, operationName string, rawVariables map[string]any) Plan {
	t.Helper()
	doc, err := parser.ParseQuery(&ast.Source{Name: "query", Input: query})
	if err != nil {
		t.Fatalf("parse %q: %v", query, err)
	}
	plan := Plan{Doc: doc, Query: query, OperationName: operationName, RawVariables: rawVariables}
	if operationName != "" {
		plan.Op = doc.Operations.ForName(operationName)
	} else if len(doc.Operations) == 1 {
		plan.Op = doc.Operations[0]
	}
	if plan.Op == nil {
		t.Fatalf("no operation selected for %q", query)
	}
	return plan
}

// TestResponseCacheableMatchesNestWhitelist pins the response-cache decision
// against isCacheableGraphqlRequest (apps/api/src/graphql/graphql.module.ts).
// The important case is the root __typename: getRootFieldNames counts every FIELD
// selection, so Apollo Client's default __typename makes a document that is
// otherwise allowlisted non-cacheable. Go must make the same decision, otherwise
// it serves a cached economic/graph payload for 30s where Nest re-executes.
func TestResponseCacheableMatchesNestWhitelist(t *testing.T) {
	const economicRoot = `query Picked { getEconomicData(category: "fx") { value } }`
	cases := []struct {
		name      string
		query     string
		opName    string
		variables map[string]any
		maxAge    int
		want      bool
	}{
		{
			name:   "operation name in the allowlist",
			query:  `query EconomicData { getEconomicData(category: "fx") { value } }`,
			opName: "EconomicData",
			maxAge: 30,
			want:   true,
		},
		{
			name:   "operation name allowlist wins over root fields",
			query:  `query EconomicData { getEconomicData(category: "fx") { value } __typename }`,
			opName: "EconomicData",
			maxAge: 30,
			want:   true,
		},
		{
			name:   "every root field in the field allowlist",
			query:  economicRoot,
			opName: "Picked",
			maxAge: 30,
			want:   true,
		},
		{
			name:   "root __typename breaks the field allowlist",
			query:  `query Picked { getEconomicData(category: "fx") { value } __typename }`,
			opName: "Picked",
			maxAge: 30,
			want:   false,
		},
		{
			name:   "root __typename only",
			query:  `query Picked { __typename }`,
			opName: "Picked",
			maxAge: 30,
			want:   false,
		},
		{
			name:   "a non-allowlisted root field",
			query:  `query Picked { getEconomicData(category: "fx") { value } alertChannels { id } }`,
			opName: "Picked",
			maxAge: 30,
			want:   false,
		},
		{
			name:   "fragment spread roots are not FIELD selections for Nest",
			query:  `query Picked { ...Econ } fragment Econ on Query { getEconomicData(category: "fx") { value } }`,
			opName: "Picked",
			maxAge: 30,
			want:   false,
		},
		{
			name:      "forceRefresh skips read and write",
			query:     economicRoot,
			opName:    "Picked",
			variables: map[string]any{"forceRefresh": true},
			maxAge:    30,
			want:      false,
		},
		{
			name:   "mutations are never cacheable",
			query:  `mutation M { markAllNotificationsRead }`,
			opName: "M",
			maxAge: 30,
			want:   false,
		},
		{
			name:   "disabled maxAge",
			query:  economicRoot,
			opName: "Picked",
			maxAge: 0,
			want:   false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			plan := planForTest(t, testCase.query, testCase.opName, testCase.variables)
			if got := ResponseCacheable(plan, testCase.maxAge); got != testCase.want {
				t.Fatalf("ResponseCacheable = %v, want %v", got, testCase.want)
			}
		})
	}
}

// TestCacheKeySeparatesDocumentsAndIdentities documents why the root __typename
// difference is a freshness question, not a cache-key collision: the key hashes
// the whole query text, the operation name and the raw variables, so the two
// documents can never share an entry. Organization and user still split entries.
func TestCacheKeySeparatesDocumentsAndIdentities(t *testing.T) {
	identity := contract.Identity{UserID: "user-1", OrgID: "org-1"}
	without := planForTest(t, `query Picked { getEconomicData(category: "fx") { value } }`, "Picked", nil)
	with := planForTest(t, `query Picked { getEconomicData(category: "fx") { value } __typename }`, "Picked", nil)

	if cacheKey("schema", identity, without) == cacheKey("schema", identity, with) {
		t.Fatal("documents that differ by a root __typename must not share a cache key")
	}
	otherOrg := contract.Identity{UserID: "user-1", OrgID: "org-2"}
	if cacheKey("schema", identity, without) == cacheKey("schema", otherOrg, without) {
		t.Fatal("cache keys must be scoped per organization")
	}
	otherUser := contract.Identity{UserID: "user-2", OrgID: "org-1"}
	if cacheKey("schema", identity, without) == cacheKey("schema", otherUser, without) {
		t.Fatal("cache keys must be scoped per user")
	}
	otherSchema := cacheKey("schema-2", identity, without)
	if cacheKey("schema", identity, without) == otherSchema {
		t.Fatal("cache keys must include the schema version")
	}
}
