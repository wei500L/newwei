package legacyproxy

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The two Go-owned HTTP contract artifacts, resolved relative to this package
// directory (go test runs with the package dir as the working directory). They
// are the OpenAPI route/permission snapshot and the auth matrix: historical
// Nest-generated expectations that this gate reconciles against the real Go
// route table assembled by AllRoutes.
const (
	openAPISnapshotRelPath = "../apidocs/openapi.snapshot.json"
	authMatrixRelPath      = "../../contracts/auth-matrix.json"
)

// httpMethods are the OpenAPI path-item keys this gate treats as HTTP
// operations. Anything else under a path item (parameters, summary, ...) is
// ignored.
var httpMethods = map[string]bool{
	"get": true, "post": true, "put": true, "patch": true, "delete": true,
	"head": true, "options": true,
}

var (
	// braceParam matches the OpenAPI {param} placeholder form.
	braceParam = regexp.MustCompile(`\{[^}]+\}`)
	// colonParam matches the Nest :param placeholder form.
	colonParam = regexp.MustCompile(`:[A-Za-z0-9_]+`)
)

// httpOperation is one documented METHOD + path.
type httpOperation struct {
	method string
	path   string
}

// normalized collapses both the OpenAPI {param} form and the Nest :param form
// to :param so the two artifacts can be compared as sets.
func (op httpOperation) normalized() string {
	return op.method + " " + normalizePath(op.path)
}

func normalizePath(path string) string {
	path = braceParam.ReplaceAllString(path, ":param")
	return colonParam.ReplaceAllString(path, ":param")
}

// concretePath substitutes every parameter placeholder with one non-empty
// segment so the gateway matcher (which works on concrete request paths) can
// classify the operation.
func concretePath(path string) string {
	path = braceParam.ReplaceAllString(path, "x")
	return colonParam.ReplaceAllString(path, "x")
}

func loadOpenAPIOperations(t *testing.T) []httpOperation {
	t.Helper()
	raw, err := os.ReadFile(openAPISnapshotRelPath)
	if err != nil {
		t.Fatalf("read %s: %v", openAPISnapshotRelPath, err)
	}
	var doc struct {
		OpenAPI string                                `json:"openapi"`
		Paths   map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", openAPISnapshotRelPath, err)
	}
	if doc.OpenAPI != "3.0.3" {
		t.Fatalf("%s openapi = %q, want 3.0.3", openAPISnapshotRelPath, doc.OpenAPI)
	}
	var ops []httpOperation
	for path, item := range doc.Paths {
		for method := range item {
			if !httpMethods[strings.ToLower(method)] {
				continue
			}
			ops = append(ops, httpOperation{method: strings.ToUpper(method), path: path})
		}
	}
	if len(ops) < 300 {
		t.Fatalf("%s has %d operations; refusing to pass on a truncated snapshot", openAPISnapshotRelPath, len(ops))
	}
	sort.Slice(ops, func(i, j int) bool { return ops[i].normalized() < ops[j].normalized() })
	return ops
}

// authMatrixRow is the subset of one auth-matrix row this gate relies on.
type authMatrixRow struct {
	Method string `json:"method"`
	Route  string `json:"route"`
	// Anonymous is "allowed" for @Public rows and "denied" otherwise.
	Anonymous string `json:"anonymous"`
	// AuthenticatedWithoutPermission is "allowed" for @AllowAuthenticated rows
	// and "denied" for permission-gated rows.
	AuthenticatedWithoutPermission string   `json:"authenticatedWithoutPermission"`
	Permission                     []string `json:"permission"`
	PermissionMode                 string   `json:"permissionMode"`
}

type authMatrix struct {
	Totals struct {
		Endpoints int `json:"endpoints"`
		Public    int `json:"public"`
		AllowAuth int `json:"allowAuthenticated"`
		Gated     int `json:"permissionGated"`
	} `json:"totals"`
	Rows []authMatrixRow `json:"rows"`
}

func loadAuthMatrix(t *testing.T) authMatrix {
	t.Helper()
	raw, err := os.ReadFile(authMatrixRelPath)
	if err != nil {
		t.Fatalf("read %s: %v", authMatrixRelPath, err)
	}
	var matrix authMatrix
	if err := json.Unmarshal(raw, &matrix); err != nil {
		t.Fatalf("parse %s: %v", authMatrixRelPath, err)
	}
	if len(matrix.Rows) < 300 {
		t.Fatalf("%s has %d rows; refusing to pass on a truncated matrix", authMatrixRelPath, len(matrix.Rows))
	}
	return matrix
}

// TestHTTPContractArtifactsAgree proves the two Go-owned HTTP artifacts describe
// exactly the same METHOD + path set. A route added to one without the other is
// a real contract drift, not a formatting difference.
func TestHTTPContractArtifactsAgree(t *testing.T) {
	ops := loadOpenAPIOperations(t)
	matrix := loadAuthMatrix(t)

	open := make(map[string]bool, len(ops))
	for _, op := range ops {
		open[op.normalized()] = true
	}
	grid := make(map[string]bool, len(matrix.Rows))
	for _, row := range matrix.Rows {
		grid[httpOperation{method: strings.ToUpper(row.Method), path: row.Route}.normalized()] = true
	}

	var onlyOpen, onlyGrid []string
	for op := range open {
		if !grid[op] {
			onlyOpen = append(onlyOpen, op)
		}
	}
	for op := range grid {
		if !open[op] {
			onlyGrid = append(onlyGrid, op)
		}
	}
	sort.Strings(onlyOpen)
	sort.Strings(onlyGrid)
	if len(onlyOpen) > 0 || len(onlyGrid) > 0 {
		t.Fatalf("OpenAPI and auth-matrix disagree on documented routes:\n  only in OpenAPI: %v\n  only in auth-matrix: %v", onlyOpen, onlyGrid)
	}
}

// TestEveryDocumentedHTTPOperationIsOwnedByGo is the sustainable Go contract
// gate: every operation in both static artifacts must match a declared rule in
// the AllRoutes table (the same table cmd/api/main.go builds), and must not fall
// through to a generic catch-all. This finds routes that were added/omitted/
// misclassified relative to the real Go registration instead of comparing two
// hand-maintained tables to each other.
func TestEveryDocumentedHTTPOperationIsOwnedByGo(t *testing.T) {
	gateway := New(AllRoutes())

	var failures []string
	check := func(method, path, source string) {
		rule, matched := gateway.matchRule(method, concretePath(path))
		if !matched {
			failures = append(failures, fmt.Sprintf("%s %s (%s) matched no Go rule", method, path, source))
			return
		}
		if rule.Prefix == "/api/" {
			failures = append(failures, fmt.Sprintf("%s %s (%s) matched the generic /api/ catch-all; expected a declared Go rule", method, path, source))
		}
	}

	for _, op := range loadOpenAPIOperations(t) {
		check(op.method, op.path, "openapi.snapshot.json")
	}
	for _, row := range loadAuthMatrix(t).Rows {
		check(strings.ToUpper(row.Method), row.Route, "auth-matrix.json")
	}

	sort.Strings(failures)
	if len(failures) > 0 {
		t.Fatalf("%d documented HTTP operations are not owned by a Go rule:\n  %s", len(failures), strings.Join(failures, "\n  "))
	}
}

// TestAuthMatrixPermissionStructure keeps the matrix's four-state permission
// contract self-consistent: public rows carry no permission, @AllowAuthenticated
// rows carry no permission, and permission-gated rows must declare a permission
// with an explicit any/all mode. This is the static permission boundary the Go
// handlers must still enforce at runtime; the matrix cannot silently lose a
// gate when it is copied into the Go-owned contracts directory.
func TestAuthMatrixPermissionStructure(t *testing.T) {
	matrix := loadAuthMatrix(t)
	if matrix.Totals.Endpoints != len(matrix.Rows) {
		t.Fatalf("totals.endpoints = %d, rows = %d", matrix.Totals.Endpoints, len(matrix.Rows))
	}

	public, allowAuth, gated := 0, 0, 0
	for _, row := range matrix.Rows {
		switch {
		case row.Anonymous == "allowed":
			public++
			if len(row.Permission) != 0 {
				t.Errorf("%s %s is public but declares permissions %v", row.Method, row.Route, row.Permission)
			}
		case row.AuthenticatedWithoutPermission == "allowed":
			allowAuth++
			if len(row.Permission) != 0 {
				t.Errorf("%s %s is allow-authenticated but declares permissions %v", row.Method, row.Route, row.Permission)
			}
		default:
			gated++
			if len(row.Permission) == 0 {
				t.Errorf("%s %s is permission-gated but declares no permission", row.Method, row.Route)
			}
			if row.PermissionMode != "any" && row.PermissionMode != "all" {
				t.Errorf("%s %s permission-gated with permissionMode %q, want any or all", row.Method, row.Route, row.PermissionMode)
			}
		}
	}
	if public != matrix.Totals.Public || allowAuth != matrix.Totals.AllowAuth || gated != matrix.Totals.Gated {
		t.Fatalf("auth-matrix totals drifted: public %d/%d, allowAuthenticated %d/%d, gated %d/%d",
			public, matrix.Totals.Public, allowAuth, matrix.Totals.AllowAuth, gated, matrix.Totals.Gated)
	}
}
