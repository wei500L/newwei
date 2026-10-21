// Package graphqlread_test holds the cutover gate that proves every NestJS
// GraphQL root field has a Go registration point.
//
// Why an external test package: the gate needs only the exported production
// surface (contract.Registry, the per-domain Register functions, schema.Load,
// and graphqlsubscriptions.New), so graphqlread_test keeps it from depending on
// unexported state of the HTTP package under test.
//
// Why a real Registry: scanning source for resolver names would not catch a
// duplicate, renamed, or panicking registration. The test therefore assembles
// the same registry cmd/api/main.go assembles when every API_GO_* switch is go
// and asks contract.Registry.Query/Mutation whether each SDL root exists.
//
// Why no external service: every Register function only captures its MySQL,
// Mongo, Redis, and queue handles inside resolver closures, and no resolver
// runs here. The two packages that reject a nil service at registration time
// (economicdata, assistantwrite) receive a zero-value service pointer. The
// realtime subscription runtime is constructed with in-memory stubs, so it
// never opens Redis or a network connection.
//
// Known limitation: graphqlsubscriptions.New creates its own private registry
// (handler.go:113) and never exposes it, so the four Subscription roots cannot
// be asserted through Registry.Subscription from another package. They are
// covered by (a) the real construction of that runtime, (b) a bidirectional
// comparison of the production subscriptionRoots table with this fixture, and
// (c) an AST assertion that New ranges over that table and calls
// registry.RegisterSubscription with spec.name. See
// assertSubscriptionRootsCovered.
package graphqlread_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	gqlast "github.com/vektah/gqlparser/v2/ast"

	"github.com/wei500L/newwei/apps/api-go/internal/assistantruns"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	econdomain "github.com/wei500L/newwei/apps/api-go/internal/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	analysisrunsgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/analysisruns"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/assistantwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economic"
	economicdatagraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	itemsingestgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/kgimpact"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgereview"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsindicators"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsindicatorwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/orgaccesswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/policy"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/rsstranslation"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspacewrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
)

const (
	// rootManifestPath is the T1.2 A-class root list. It is test data, not a
	// second source of truth: TestCutoverGraphQLRootFixtureMatchesSDL keeps it
	// equal to the embedded SDL.
	rootManifestPath = "testdata/nest-graphql-roots.txt"

	kindQuery        = "Query"
	kindMutation     = "Mutation"
	kindSubscription = "Subscription"

	// baselineTotal is the T1.2 A-class total at dcbe563b: 77 + 57 + 4.
	baselineTotal = 138
)

var (
	rootKinds = []string{kindQuery, kindMutation, kindSubscription}

	baselineRootCounts = map[string]int{
		kindQuery:        77,
		kindMutation:     57,
		kindSubscription: 4,
	}
)

// graphqlRoot is one fixture row: the SDL root field, the switch whose "go"
// value makes cmd/api/main.go register it, and the Go package that owns the
// registration call.
type graphqlRoot struct {
	kind        string
	name        string
	switchName  string
	packageName string
}

// loadGraphQLRootManifest parses testdata/nest-graphql-roots.txt. A malformed
// row, an unknown kind, a non-API_GO_* switch, or a duplicate kind+name fails
// the gate instead of being skipped, so a stale or hand-edited fixture cannot
// silently weaken the coverage claim.
func loadGraphQLRootManifest(t *testing.T) []graphqlRoot {
	t.Helper()
	file, err := os.Open(rootManifestPath)
	if err != nil {
		t.Fatalf("open %s: %v", rootManifestPath, err)
	}
	defer file.Close()

	var roots []graphqlRoot
	seen := map[string]bool{}
	lineNumber := 0
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 4 {
			t.Fatalf("%s:%d: want 4 columns (kind rootName switch package), got %d: %q", rootManifestPath, lineNumber, len(fields), line)
		}
		root := graphqlRoot{
			kind:        fields[0],
			name:        fields[1],
			switchName:  fields[2],
			packageName: fields[3],
		}
		if _, known := baselineRootCounts[root.kind]; !known {
			t.Fatalf("%s:%d: unknown kind %q, want Query, Mutation or Subscription", rootManifestPath, lineNumber, root.kind)
		}
		if !strings.HasPrefix(root.switchName, "API_GO_") {
			t.Fatalf("%s:%d: %s.%s switch %q is not an API_GO_* switch", rootManifestPath, lineNumber, root.kind, root.name, root.switchName)
		}
		if root.packageName == "" {
			t.Fatalf("%s:%d: %s.%s has an empty package column", rootManifestPath, lineNumber, root.kind, root.name)
		}
		key := root.kind + " " + root.name
		if seen[key] {
			t.Fatalf("%s:%d: duplicate fixture row %q", rootManifestPath, lineNumber, key)
		}
		seen[key] = true
		roots = append(roots, root)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan %s: %v", rootManifestPath, err)
	}
	if len(roots) == 0 {
		t.Fatalf("%s contains no root rows", rootManifestPath)
	}
	return roots
}

func countRootsByKind(roots []graphqlRoot) map[string]int {
	counts := make(map[string]int, len(rootKinds))
	for _, root := range roots {
		counts[root.kind]++
	}
	return counts
}

func groupRootsByKind(roots []graphqlRoot) map[string]map[string]graphqlRoot {
	grouped := make(map[string]map[string]graphqlRoot, len(rootKinds))
	for _, root := range roots {
		if grouped[root.kind] == nil {
			grouped[root.kind] = map[string]graphqlRoot{}
		}
		grouped[root.kind][root.name] = root
	}
	return grouped
}

// assertBaselineRootCounts pins the T1.2 denominators. The failure message
// reports every kind separately so a schema change shows up as one concrete
// number instead of a generic "fixture is stale".
func assertBaselineRootCounts(t *testing.T, roots []graphqlRoot) {
	t.Helper()
	counts := countRootsByKind(roots)
	total := 0
	for _, kind := range rootKinds {
		total += counts[kind]
		if counts[kind] != baselineRootCounts[kind] {
			t.Errorf("%s root count = %d, want %d (T1.2 A-class baseline at dcbe563b)", kind, counts[kind], baselineRootCounts[kind])
		}
	}
	if total != baselineTotal {
		t.Errorf("fixture root count = %d, want %d (77 Query + 57 Mutation + 4 Subscription)", total, baselineTotal)
	}
}

// sdlRootFields returns the Query, Mutation, and Subscription field names of the
// embedded SDL. schema.Load is the same loader the production executor uses, so
// this comparison cannot drift to a reduced test schema.
func sdlRootFields(t *testing.T) map[string]map[string]bool {
	t.Helper()
	loaded, err := schema.Load()
	if err != nil {
		t.Fatalf("schema.Load(): %v", err)
	}
	definitions := map[string]*gqlast.Definition{
		kindQuery:        loaded.Query,
		kindMutation:     loaded.Mutation,
		kindSubscription: loaded.Subscription,
	}
	fields := make(map[string]map[string]bool, len(rootKinds))
	for _, kind := range rootKinds {
		definition := definitions[kind]
		if definition == nil {
			t.Fatalf("embedded schema.gql has no %s root type", kind)
		}
		names := make(map[string]bool, len(definition.Fields))
		for _, field := range definition.Fields {
			names[field.Name] = true
		}
		fields[kind] = names
	}
	return fields
}

// TestCutoverGraphQLRootFixtureMatchesSDL keeps the T1.2 fixture honest. The
// fixture must list exactly the SDL root fields: an extra row would claim
// coverage the schema does not have, and a missing row would silently stop the
// gate from covering a root after a schema change.
func TestCutoverGraphQLRootFixtureMatchesSDL(t *testing.T) {
	roots := loadGraphQLRootManifest(t)
	assertBaselineRootCounts(t, roots)

	sdl := sdlRootFields(t)
	fixture := groupRootsByKind(roots)

	for _, kind := range rootKinds {
		var missingFromSDL, missingFromFixture []string
		for name := range fixture[kind] {
			if !sdl[kind][name] {
				missingFromSDL = append(missingFromSDL, name)
			}
		}
		for name := range sdl[kind] {
			if _, listed := fixture[kind][name]; !listed {
				missingFromFixture = append(missingFromFixture, name)
			}
		}
		sort.Strings(missingFromSDL)
		sort.Strings(missingFromFixture)
		if len(missingFromSDL) == 0 && len(missingFromFixture) == 0 {
			continue
		}
		t.Fatalf("%s: fixture and SDL root sets differ (fixture %d, SDL %d)\n  listed in fixture but missing from SDL: %s\n  present in SDL but missing from fixture: %s\n  regenerate %s from the T1.2 audit",
			kind, len(fixture[kind]), len(sdl[kind]),
			strings.Join(missingFromSDL, ", "),
			strings.Join(missingFromFixture, ", "),
			rootManifestPath)
	}
}

// TestCutoverGraphQLRootsRegisteredInAllGoRegistry is the cutover CI gate: in
// the all-go configuration every Query and Mutation root of the T1.2 A-class
// list must resolve through the real contract.Registry, and the four
// Subscription roots must be registered by the real realtime runtime. The
// registry is assembled by calling the same Register functions cmd/api/main.go
// calls for that configuration, so a removed or renamed registration fails here
// without any MySQL, Redis, Mongo, or network dependency.
func TestCutoverGraphQLRootsRegisteredInAllGoRegistry(t *testing.T) {
	roots := loadGraphQLRootManifest(t)
	assertBaselineRootCounts(t, roots)
	fixture := groupRootsByKind(roots)

	reg := allGoGraphQLRegistry(t)

	var missing []string
	queryAndMutation := 0
	for _, kind := range []string{kindQuery, kindMutation} {
		queryAndMutation += len(fixture[kind])
		for name, root := range fixture[kind] {
			registered := false
			switch kind {
			case kindQuery:
				_, registered = reg.Query(name)
			case kindMutation:
				_, registered = reg.Mutation(name)
			}
			if !registered {
				missing = append(missing, fmt.Sprintf("%s %s (switch %s, package %s)", kind, name, root.switchName, root.packageName))
			}
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("%d of %d Query/Mutation roots from the T1.2 A-class list are not registered by the all-go registry:\n  %s",
			len(missing), queryAndMutation, strings.Join(missing, "\n  "))
	}

	assertSubscriptionRootsCovered(t, fixture[kindSubscription])

	t.Logf("all-go registry covers %d Query/Mutation roots; graphqlsubscriptions covers %d Subscription roots",
		queryAndMutation, len(fixture[kindSubscription]))
}

// allGoGraphQLRegistry mirrors the registry cmd/api/main.go assembles when every
// GraphQL switch is go (baseline dcbe563b). Each call passes nil handles and
// zero-value services because the Register functions only capture their
// dependencies in resolver closures; no resolver runs in this test.
//
// Two packages validate their service argument at registration time, so they
// receive a zero-value service pointer instead of nil:
//   - graphqlread/economicdata.Register panics on a nil *econdata.Service
//   - graphqlread/assistantwrite.Register panics on a nil *assistantruns.Service
//
// Keep the call list and order aligned with cmd/api/main.go; a new Register
// call added there must be added here, or its roots fail this gate.
func allGoGraphQLRegistry(t *testing.T) *contract.Registry {
	t.Helper()
	reg := contract.NewRegistry()

	archivereading.Register(reg, nil)

	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	// API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=go in the all-go configuration, so
	// newsEventBrief is registered. The brief completion dependency is only read
	// by the resolver, never by registration.
	newsevents.Register(reg, nil, nil, nil, newsevents.Options{BriefEnabled: true})
	newsindicators.Register(reg, nil)
	kgimpact.Register(reg, nil, nil, nil)
	knowledgegraph.Register(reg, nil, nil)
	workspace.Register(reg, nil, nil, nil)
	crawlmetadata.Register(reg, nil)
	settingscrawl.Register(reg, nil, settingscrawl.Options{})
	// workspace.Register above already owns the three shared processed-item
	// types, so itemsreading must not register them a second time.
	itemsreading.Register(reg, nil, true)
	itemsreading.RegisterList(reg, nil)

	itemsingestgraphql.Register(reg, nil, nil)
	economicdatagraphql.Register(reg, &econdomain.Service{})
	orgaccesswrite.Register(reg, nil, nil)
	assistantwrite.Register(reg, &assistantruns.Service{})
	workspacewrite.Register(reg, nil)
	alerts.RegisterRules(reg, nil, nil)
	settingswrite.Register(reg, nil, nil, settingswrite.Options{})
	crawltaskwrite.Register(reg, nil)
	newsindicatorwrite.Register(reg, nil, nil)
	settingswrite.RegisterSourcePolicy(reg, nil, nil)
	knowledgereview.Register(reg, nil, nil, knowledgereview.Options{})
	rsstranslation.Register(reg, nil)
	analysisrunsgraphql.Register(reg, nil)

	return reg
}

// subscriptionAuthenticator, subscriptionLimiter, and subscriptionFeedSource are
// the minimal non-nil implementations of the three graphqlsubscriptions.Options
// dependencies. graphqlsubscriptions.New requires the authenticator and limiter
// and uses Source instead of Redis, but it never invokes them during
// construction, and this test never serves a connection.
type subscriptionAuthenticator struct{}

func (subscriptionAuthenticator) Identify(*http.Request) (*authhttp.Identity, *authhttp.AuthFailure) {
	return nil, &authhttp.AuthFailure{Status: http.StatusUnauthorized, Message: "test stub: no request is served"}
}

type subscriptionLimiter struct{}

func (subscriptionLimiter) BudgetFor(context.Context) policy.Budget {
	return policy.Budget{WindowSeconds: 60}
}

func (subscriptionLimiter) Consume(context.Context, string, policy.Budget) bool { return false }

type subscriptionFeedSource struct{}

func (subscriptionFeedSource) Subscribe(context.Context, string, string) (<-chan graphqlsubscriptions.FeedEvent, error) {
	return nil, errors.New("test stub: the subscription feed is never opened")
}

// assertSubscriptionRootsCovered proves the four Subscription roots are
// registered without reaching into the private registry of
// graphqlsubscriptions.New. The package exports no registry accessor, and
// changing production code for this gate is out of scope for the cutover batch,
// so the check uses three independent pieces of evidence:
//
//  1. New is constructed for real with in-memory stubs. That executes the model
//     registration and the RegisterSubscription calls inside New
//     (handler.go:113-123); a duplicate registration would panic here.
//  2. The production subscriptionRoots table (source.go:25) must equal the
//     fixture's Subscription set in both directions.
//  3. The AST of New must still range over subscriptionRoots and pass spec.name
//     to registry.RegisterSubscription, so evidence 2 cannot keep passing after
//     the table stopped being consumed.
func assertSubscriptionRootsCovered(t *testing.T, want map[string]graphqlRoot) {
	t.Helper()

	runtime, err := graphqlsubscriptions.New(graphqlsubscriptions.Options{
		Authenticator: subscriptionAuthenticator{},
		Limiter:       subscriptionLimiter{},
		Source:        subscriptionFeedSource{},
	})
	if err != nil {
		t.Fatalf("graphqlsubscriptions.New with in-memory stubs: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runtime.Close(ctx); err != nil {
			t.Errorf("graphqlsubscriptions runtime Close: %v", err)
		}
	})

	sourceRoots := subscriptionRootNamesFromSource(t)
	var missingFromSource, missingFromFixture []string
	for name := range want {
		if _, listed := sourceRoots[name]; !listed {
			missingFromSource = append(missingFromSource, name)
		}
	}
	for name := range sourceRoots {
		if _, listed := want[name]; !listed {
			missingFromFixture = append(missingFromFixture, name)
		}
	}
	sort.Strings(missingFromSource)
	sort.Strings(missingFromFixture)
	if len(missingFromSource) > 0 || len(missingFromFixture) > 0 {
		t.Fatalf("Subscription roots differ (fixture %d, graphqlsubscriptions.subscriptionRoots %d)\n  in fixture but missing from source.go: %s\n  in source.go but missing from fixture: %s",
			len(want), len(sourceRoots),
			strings.Join(missingFromSource, ", "),
			strings.Join(missingFromFixture, ", "))
	}

	if !subscriptionRegistrationLoopFound(t) {
		t.Fatalf("graphqlsubscriptions.New no longer ranges over subscriptionRoots and calls registry.RegisterSubscription with spec.name; the Subscription roots (%s) would not be registered",
			strings.Join(sortedMapKeys(sourceRoots), ", "))
	}
}

// subscriptionRootNamesFromSource parses the production subscriptionRoots table.
// go/parser is used instead of a substring match so reformatting does not
// matter, while a renamed or removed root still fails the gate.
func subscriptionRootNamesFromSource(t *testing.T) map[string]string {
	t.Helper()
	const path = "../graphqlsubscriptions/source.go"
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	for _, declaration := range file.Decls {
		genDecl, ok := declaration.(*ast.GenDecl)
		if !ok || genDecl.Tok != token.VAR {
			continue
		}
		for _, spec := range genDecl.Specs {
			valueSpec, ok := spec.(*ast.ValueSpec)
			if !ok || len(valueSpec.Names) != 1 || valueSpec.Names[0].Name != "subscriptionRoots" {
				continue
			}
			if len(valueSpec.Values) != 1 {
				t.Fatalf("%s: subscriptionRoots must have exactly one composite literal value", path)
			}
			table, ok := valueSpec.Values[0].(*ast.CompositeLit)
			if !ok {
				t.Fatalf("%s: subscriptionRoots value is %T, want a composite literal", path, valueSpec.Values[0])
			}
			roots := make(map[string]string, len(table.Elts))
			for _, element := range table.Elts {
				entry, ok := element.(*ast.CompositeLit)
				if !ok {
					t.Fatalf("%s: subscriptionRoots entry is %T, want a composite literal", path, element)
				}
				name, ok := compositeStringField(entry, "name")
				if !ok {
					t.Fatalf("%s: subscriptionRoots entry has no string name field", path)
				}
				permission, _ := compositeStringField(entry, "permission")
				if _, duplicate := roots[name]; duplicate {
					t.Fatalf("%s: subscriptionRoots lists %q twice", path, name)
				}
				roots[name] = permission
			}
			if len(roots) == 0 {
				t.Fatalf("%s: subscriptionRoots is empty", path)
			}
			return roots
		}
	}
	t.Fatalf("%s: subscriptionRoots table not found", path)
	return nil
}

// compositeStringField returns the string literal stored under key in a keyed
// struct composite literal.
func compositeStringField(literal *ast.CompositeLit, key string) (string, bool) {
	for _, element := range literal.Elts {
		keyValue, ok := element.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		ident, ok := keyValue.Key.(*ast.Ident)
		if !ok || ident.Name != key {
			continue
		}
		value, ok := keyValue.Value.(*ast.BasicLit)
		if !ok || value.Kind != token.STRING {
			return "", false
		}
		unquoted, err := strconv.Unquote(value.Value)
		if err != nil {
			return "", false
		}
		return unquoted, true
	}
	return "", false
}

// subscriptionRegistrationLoopFound reports whether graphqlsubscriptions.New
// still ranges over subscriptionRoots and registers spec.name through
// registry.RegisterSubscription. Asserting the call shape, not only the table
// content, is what ties the table to an actual registration.
//
// This is a static assertion on purpose: graphqlsubscriptions keeps its registry
// private and exports no accessor, and adding one would change production API
// outside this batch's scope. The alternative (reflection or unsafe) would make
// a CI gate depend on unexported struct layout, so the source contract is
// asserted here instead.
func subscriptionRegistrationLoopFound(t *testing.T) bool {
	t.Helper()
	const path = "../graphqlsubscriptions/handler.go"
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}

	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Name.Name != "New" || function.Body == nil {
			continue
		}
		found := false
		ast.Inspect(function.Body, func(node ast.Node) bool {
			if found {
				return false
			}
			rangeStatement, ok := node.(*ast.RangeStmt)
			if !ok {
				return true
			}
			iterated, ok := rangeStatement.X.(*ast.Ident)
			if !ok || iterated.Name != "subscriptionRoots" {
				return true
			}
			ast.Inspect(rangeStatement.Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || selector.Sel.Name != "RegisterSubscription" {
					return true
				}
				owner, ok := selector.X.(*ast.Ident)
				if !ok || owner.Name != "registry" {
					return true
				}
				if callUsesSpecName(call) {
					found = true
					return false
				}
				return true
			})
			return !found
		})
		return found
	}
	return false
}

func callUsesSpecName(call *ast.CallExpr) bool {
	found := false
	ast.Inspect(call, func(node ast.Node) bool {
		selector, ok := node.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		owner, ok := selector.X.(*ast.Ident)
		if !ok || owner.Name != "spec" || selector.Sel.Name != "name" {
			return true
		}
		found = true
		return false
	})
	return found
}

func sortedMapKeys(entries map[string]string) []string {
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
