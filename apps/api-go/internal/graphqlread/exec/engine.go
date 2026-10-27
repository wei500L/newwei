package exec

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"

	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/gqlerror"
	"github.com/vektah/gqlparser/v2/parser"
	"github.com/vektah/gqlparser/v2/validator"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	// KindLegacy means the original HTTP request must be proxied unchanged.
	KindLegacy = "legacy"
	// KindProtocol means Body is a complete GraphQL HTTP response and no
	// resolver ran.
	KindProtocol = "protocol"
	// KindExecute means the selected query is fully implemented.
	KindExecute = "execute"
	// KindSubscriptionError means graphql-ws must send an operation-level
	// error message (no complete) for an unparseable or schema-invalid
	// subscription document.
	KindSubscriptionError = "subscription_error"
)

// PrepareRoot runs before each business root field. It must apply rate
// limiting and then authentication. Permission checks stay in the engine.
type PrepareRoot func(ctx context.Context, responseKey, fieldName string) (contract.Identity, error)

// Cache is the private response cache. Keys already include identity.
type Cache interface {
	Get(ctx context.Context, key string) ([]byte, bool)
	Set(ctx context.Context, key string, body []byte, ttlSeconds int)
}

// Engine plans and executes migrated GraphQL queries against the full SDL.
type Engine struct {
	schema          *ast.Schema
	reg             *contract.Registry
	depthLimit      int
	complexityLimit int
	resolverCalls   *atomic.Int64
	// errorRecorder receives every resolver/guard failure. Nil disables recording.
	errorRecorder ErrorRecorder
}

// New returns an engine. depthLimit and complexityLimit use the Nest defaults
// when non-positive values are passed (8 and 2000).
func New(schema *ast.Schema, reg *contract.Registry, depthLimit, complexityLimit int, resolverCalls *atomic.Int64) *Engine {
	if depthLimit <= 0 {
		depthLimit = 8
	}
	if complexityLimit <= 0 {
		complexityLimit = 2000
	}
	if resolverCalls == nil {
		resolverCalls = &atomic.Int64{}
	}
	return &Engine{
		schema:          schema,
		reg:             reg,
		depthLimit:      depthLimit,
		complexityLimit: complexityLimit,
		resolverCalls:   resolverCalls,
	}
}

// Plan is the ownership decision. It does not call resolvers.
type Plan struct {
	Kind             string
	RegisterDocument bool
	Validated        bool
	Result           Result
	Doc              *ast.QueryDocument
	Op               *ast.OperationDefinition
	Query            string
	OperationName    string
	RawVariables     map[string]any
	Variables        map[string]any
}

// PlanDocument parses, validates, and decides whether Go may execute query.
// operationName nil means the client omitted it. rawVariables is the JSON
// object from the request, before coercion.
func (e *Engine) PlanDocument(query string, operationName *string, rawVariables map[string]any) Plan {
	plan := Plan{Query: query, RawVariables: rawVariables}
	if operationName != nil {
		plan.OperationName = *operationName
	}
	doc, err := parser.ParseQuery(&ast.Source{Name: "query", Input: query})
	if err != nil {
		plan.Kind = KindProtocol
		plan.Result = parseFailure(err)
		return plan
	}
	plan.Doc = doc
	op, selectionErr := selectOperation(doc, operationName)
	validation := validator.Validate(e.schema, doc)
	supported := op != nil && e.rootDefinition(op) != nil && e.operationSupported(doc, op)
	if len(validation) > 0 {
		if selectionErr == nil && op != nil && !supported {
			plan.Kind = KindLegacy
			plan.Op = op
			return plan
		}
		plan.Kind = KindProtocol
		plan.Result = validationErrors(toGraphErrors(validation))
		return plan
	}
	if selectionErr != nil || op == nil {
		plan.Kind = KindProtocol
		plan.RegisterDocument = true
		plan.Validated = true
		plan.Result = operationResolution(selectionMessage(operationName, doc))
		return plan
	}
	if e.rootDefinition(op) == nil {
		plan.Kind = KindLegacy
		plan.RegisterDocument = true
		plan.Validated = true
		plan.Op = op
		return plan
	}
	depth := e.depthErrors(doc)
	if !supported {
		plan.Kind = KindLegacy
		plan.Op = op
		if len(depth) == 0 {
			plan.RegisterDocument = true
			plan.Validated = true
		}
		return plan
	}
	if len(depth) > 0 {
		plan.Kind = KindProtocol
		plan.Result = validationErrors(depth)
		return plan
	}
	coerced, err := validator.VariableValues(e.schema, op, rawVariables)
	if err != nil {
		plan.Kind = KindProtocol
		plan.RegisterDocument = true
		plan.Validated = true
		plan.Op = op
		plan.Result = userInput(err.Error(), 0, 0)
		return plan
	}
	plan.Kind = KindExecute
	plan.RegisterDocument = true
	plan.Validated = true
	plan.Op = op
	plan.Variables = coerced
	return plan
}

// IsMutation reports whether the selected operation is a mutation.
func IsMutation(plan Plan) bool {
	return plan.Op != nil && plan.Op.Operation == ast.Mutation
}

// MutationOverGET is the rejection Apollo Server returns when a GET request
// selects a mutation: 405 with the BAD_REQUEST code and an Allow: POST header.
// GET requests never reach a mutation resolver, so no write can happen.
func MutationOverGET(plan Plan) *Result {
	if !IsMutation(plan) {
		return nil
	}
	header := http.Header{}
	header.Set("Allow", http.MethodPost)
	result := protocolResult(http.StatusMethodNotAllowed, header, graphError{
		Message:    "GET requests only support query operations, not mutation operations",
		Extensions: map[string]any{"code": codeBadRequest},
	})
	return &result
}

// CheckComplexity implements the Nest estimator order. A failure is returned
// before resolvers and before APQ registration.
func (e *Engine) CheckComplexity(plan Plan) *Result {
	if plan.Op == nil {
		return nil
	}
	cost := e.complexityOf(plan.Op, plan.Doc, plan.Variables)
	if cost > e.complexityLimit {
		result := complexityTooHigh(cost, e.complexityLimit, plan.OperationName)
		return &result
	}
	return nil
}

// Execute runs a KindExecute plan. Prepare runs once per collected business
// root field, after skip/include and field merging, and before resolvers.
//
// Query fields are prepared together and then resolved; Mutation fields are
// authenticated, resolved, and projected one at a time in document order, and
// a non-null top-level failure stops the remaining fields with data: null.
func (e *Engine) Execute(ctx context.Context, plan Plan, prepare PrepareRoot, cache Cache, cacheAllowed bool, cacheTTL int, schemaVersion, traceID string) Result {
	if ctx.Err() != nil {
		return protocolResult(http.StatusInternalServerError, nil, graphError{
			Message:    "Internal server error",
			Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR"},
		})
	}
	if IsMutation(plan) {
		return e.executeMutation(ctx, plan, prepare, traceID)
	}
	rootDef := e.schema.Query
	fields := collectFields(e.schema, rootDef, plan.Op.SelectionSet, plan.Doc, plan.Variables, map[string]bool{})
	type ready struct {
		field    collectedField
		identity contract.Identity
		root     contract.Root
	}
	readyFields := make([]ready, 0, len(fields))
	result := map[string]any{}
	var errors []graphError
	nullData := false
	for _, field := range fields {
		if field.Name == "__typename" {
			result[field.Key] = "Query"
			continue
		}
		root, ok := e.reg.Query(field.Name)
		fieldPath := []any{field.Key}
		if !ok {
			errors = append(errors, internalField("Field is not implemented", fieldPath, traceID))
			nullData = true
			continue
		}
		identity, err := prepare(ctx, field.Key, field.Name)
		if err != nil {
			// A rejection here is the rate limiter or the authentication chain, so it
			// is a resolver-level failure for recording purposes: NestJS's
			// GraphqlRateLimitGuard and GqlAuthGuard throw out of the field resolver
			// and the filter records them.
			e.recordResolverError(err, field.Name, plan.OperationName, traceID, contract.Identity{})
			errors = append(errors, fieldFailure(err, field, traceID))
			if fieldNonNull(field.Field) {
				nullData = true
			} else {
				result[field.Key] = nil
			}
			continue
		}
		if permErr := authorizeRoot(root, identity); permErr != nil {
			e.recordResolverError(permErr, field.Name, plan.OperationName, traceID, identity)
			errors = append(errors, fieldFailure(permErr, field, traceID))
			if fieldNonNull(field.Field) {
				nullData = true
			} else {
				result[field.Key] = nil
			}
			continue
		}
		readyFields = append(readyFields, ready{field: field, identity: identity, root: root})
	}
	header := http.Header{}
	header.Set("Cache-Control", cacheControl(plan, cacheTTL, false))
	if len(errors) == 0 && cacheAllowed && cache != nil && len(readyFields) > 0 {
		if cached, ok := cache.Get(ctx, cacheKey(schemaVersion, readyFields[0].identity, plan)); ok && json.Valid(cached) {
			header.Set("Cache-Control", cacheControl(plan, cacheTTL, false))
			return dataResult(http.StatusOK, cached, false, true, nil, header)
		}
	}
	for _, item := range readyFields {
		if ctx.Err() != nil {
			errors = append(errors, internalField("Internal server error", []any{item.field.Key}, traceID))
			nullData = true
			break
		}
		e.resolverCalls.Add(1)
		args := map[string]any{}
		if item.field.Field != nil && item.field.Field.Definition != nil {
			args = item.field.Field.ArgumentMap(plan.Variables)
		}
		selection := e.rootFieldSelection(rootDef, item.field, plan.Doc, plan.Variables)
		value, err := item.root.Resolve(contract.Context{
			Ctx:       ctx,
			Identity:  item.identity,
			Args:      args,
			Selection: selection,
		})
		fieldPath := []any{item.field.Key}
		if err != nil {
			e.recordResolverError(err, item.field.Name, plan.OperationName, traceID, item.identity)
			errors = append(errors, fieldFailure(err, item.field, traceID))
			if fieldNonNull(item.field.Field) {
				nullData = true
			} else {
				result[item.field.Key] = nil
			}
			continue
		}
		fieldDef := rootDef.Fields.ForName(item.field.Name)
		projected, isNull, projectErrors := e.project(fieldDef.Type, reflect.ValueOf(value), item.field.Selections, plan.Doc, plan.Variables, fieldPath, item.identity)
		for i := range projectErrors {
			if projectErrors[i].Extensions == nil {
				projectErrors[i].Extensions = map[string]any{}
			}
			if traceID != "" {
				projectErrors[i].Extensions["traceId"] = traceID
			}
		}
		errors = append(errors, projectErrors...)
		if isNull && fieldDef.Type.NonNull {
			nullData = true
			continue
		}
		result[item.field.Key] = projected
	}
	if nullData {
		header.Set("Cache-Control", "no-store")
		return dataResult(statusFromErrors(errors, http.StatusOK), nil, true, true, errors, header)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		header.Set("Cache-Control", "no-store")
		return dataResult(http.StatusInternalServerError, nil, true, true, []graphError{internalField("Internal server error", nil, traceID)}, header)
	}
	if len(errors) > 0 {
		header.Set("Cache-Control", "no-store")
	} else {
		header.Set("Cache-Control", cacheControl(plan, cacheTTL, false))
		if cacheAllowed && cache != nil && cacheTTL > 0 && len(readyFields) > 0 {
			cache.Set(ctx, cacheKey(schemaVersion, readyFields[0].identity, plan), encoded, cacheTTL)
		}
	}
	return dataResult(statusFromErrors(errors, http.StatusOK), encoded, false, true, errors, header)
}

// executeMutation runs a mutation plan. Every top-level field is completed in
// document order: prepare (rate limit and authentication), permission check,
// resolver call, and projection. A non-null field failure yields data: null
// and stops the remaining fields; already committed fields are never rolled
// back. Mutations never read or write the response cache.
func (e *Engine) executeMutation(ctx context.Context, plan Plan, prepare PrepareRoot, traceID string) Result {
	rootDef := e.schema.Mutation
	header := http.Header{}
	header.Set("Cache-Control", "no-store")
	if rootDef == nil {
		return dataResult(http.StatusInternalServerError, nil, true, true, []graphError{internalField("Internal server error", nil, traceID)}, header)
	}
	fields := collectFields(e.schema, rootDef, plan.Op.SelectionSet, plan.Doc, plan.Variables, map[string]bool{})
	result := map[string]any{}
	var errors []graphError
	nullData := false
	for _, field := range fields {
		if ctx.Err() != nil {
			errors = append(errors, internalField("Internal server error", []any{field.Key}, traceID))
			nullData = true
			break
		}
		if field.Name == "__typename" {
			result[field.Key] = "Mutation"
			continue
		}
		fieldPath := []any{field.Key}
		root, ok := e.reg.Mutation(field.Name)
		if !ok {
			errors = append(errors, internalField("Field is not implemented", fieldPath, traceID))
			nullData = true
			break
		}
		identity, err := prepare(ctx, field.Key, field.Name)
		if err != nil {
			// Rate limiter or authentication rejection, as in the query path.
			e.recordResolverError(err, field.Name, plan.OperationName, traceID, contract.Identity{})
			// The rate limiter or the authentication chain rejected the field; the
			// NestJS guards throw out of the resolver, so the filter records it.
			e.recordResolverError(err, field.Name, plan.OperationName, traceID, contract.Identity{})
			errors = append(errors, fieldFailure(err, field, traceID))
			if fieldNonNull(field.Field) {
				nullData = true
				break
			}
			result[field.Key] = nil
			continue
		}
		if permErr := authorizeRoot(root, identity); permErr != nil {
			e.recordResolverError(permErr, field.Name, plan.OperationName, traceID, identity)
			errors = append(errors, fieldFailure(permErr, field, traceID))
			if fieldNonNull(field.Field) {
				nullData = true
				break
			}
			result[field.Key] = nil
			continue
		}
		e.resolverCalls.Add(1)
		args := map[string]any{}
		if field.Field != nil && field.Field.Definition != nil {
			args = field.Field.ArgumentMap(plan.Variables)
		}
		selection := e.rootFieldSelection(rootDef, field, plan.Doc, plan.Variables)
		value, err := root.Resolve(contract.Context{
			Ctx:       ctx,
			Identity:  identity,
			Args:      args,
			Selection: selection,
		})
		if err != nil {
			e.recordResolverError(err, field.Name, plan.OperationName, traceID, identity)
			errors = append(errors, fieldFailure(err, field, traceID))
			if fieldNonNull(field.Field) {
				nullData = true
				break
			}
			result[field.Key] = nil
			continue
		}
		fieldDef := rootDef.Fields.ForName(field.Name)
		projected, isNull, projectErrors := e.project(fieldDef.Type, reflect.ValueOf(value), field.Selections, plan.Doc, plan.Variables, fieldPath, identity)
		for i := range projectErrors {
			if projectErrors[i].Extensions == nil {
				projectErrors[i].Extensions = map[string]any{}
			}
			if traceID != "" {
				projectErrors[i].Extensions["traceId"] = traceID
			}
		}
		errors = append(errors, projectErrors...)
		if isNull && fieldDef.Type.NonNull {
			nullData = true
			break
		}
		result[field.Key] = projected
	}
	if nullData {
		return dataResult(statusFromErrors(errors, http.StatusOK), nil, true, true, errors, header)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return dataResult(http.StatusInternalServerError, nil, true, true, []graphError{internalField("Internal server error", nil, traceID)}, header)
	}
	return dataResult(statusFromErrors(errors, http.StatusOK), encoded, false, true, errors, header)
}

func cacheKey(schemaVersion string, id contract.Identity, plan Plan) string {
	raw, _ := json.Marshal(plan.RawVariables)
	sum := sha256Hex(plan.Query + "\n" + plan.OperationName + "\n" + string(raw))
	return "gqlread:resp:v1:" + schemaVersion + ":" + id.OrgID + ":" + id.UserID + ":" + sum
}

func cacheControl(plan Plan, maxAge int, errored bool) string {
	if errored || maxAge <= 0 {
		return "no-store"
	}
	names := executedRootNames(plan)
	if len(names) == 0 {
		return "no-store"
	}
	for _, name := range names {
		if name != "getEconomicData" && name != "getEconomicDataWithInsights" {
			return "no-store"
		}
	}
	return fmt.Sprintf("private, max-age=%d", maxAge)
}

func executedRootNames(plan Plan) []string {
	if plan.Op == nil {
		return nil
	}
	names := make([]string, 0)
	for _, selection := range plan.Op.SelectionSet {
		field, ok := selection.(*ast.Field)
		if !ok || field.Name == "__typename" {
			continue
		}
		if !includeSelection(field.Directives, plan.Variables) {
			continue
		}
		names = append(names, field.Name)
	}
	return names
}

// ResponseCacheable reports whether Nest would read and write the private
// response cache for this request. forceRefresh skips both. Only query
// operations are ever cacheable: a mutation must not read or write the cached
// response, regardless of its operation name or root fields.
//
// The rule mirrors isCacheableGraphqlRequest
// (apps/api/src/graphql/graphql.module.ts): the operation-name allowlist wins,
// otherwise every direct root field selection must be in the field allowlist.
// directRootNames counts a root __typename as a root field, which is what the
// NestJS implementation does; Apollo Client sends __typename by default, so
// counting it keeps the cache decision identical to Nest for the same document.
func ResponseCacheable(plan Plan, maxAge int) bool {
	if maxAge <= 0 {
		return false
	}
	if plan.Op == nil || plan.Op.Operation != ast.Query {
		return false
	}
	if plan.RawVariables != nil && plan.RawVariables["forceRefresh"] == true {
		return false
	}
	if plan.OperationName != "" && cacheableOperationNames[plan.OperationName] {
		return true
	}
	names := directRootNames(plan.Op)
	if len(names) == 0 {
		return false
	}
	for _, name := range names {
		if !cacheableRootFields[name] {
			return false
		}
	}
	return true
}

var cacheableOperationNames = map[string]bool{
	"DashboardHeroMetrics":      true,
	"EconomicData":              true,
	"EconomicDataWithInsights":  true,
	"GetEntityImpactGraph":      true,
	"GetKnowledgeGraphSubgraph": true,
}

var cacheableRootFields = map[string]bool{
	"getEconomicData":             true,
	"getEconomicDataWithInsights": true,
	"getEntityImpactGraph":        true,
	"getKnowledgeGraphSubgraph":   true,
}

func authorizeRoot(root contract.Root, id contract.Identity) error {
	// A multi-permission root mirrors the NestJS @Permissions decorator with
	// mode "any": the caller only needs to hold one of the listed permissions.
	// The failure shape is byte-for-byte the GqlPermissionsGuard output, which
	// is why the detail string joins the permissions with ", " in declaration
	// order and reports the full list as requiredPermissions.
	if len(root.AnyPermissions) > 0 {
		for _, permission := range root.AnyPermissions {
			if id.Has(permission) {
				return nil
			}
		}
		return &contract.Failure{
			Message:             "Insufficient permissions",
			Status:              http.StatusForbidden,
			AppCode:             "INSUFFICIENT_PERMISSIONS",
			Detail:              "Requires any permission: " + strings.Join(root.AnyPermissions, ", "),
			RequiredPermissions: root.AnyPermissions,
			PermissionsMode:     "any",
		}
	}
	if root.Permission == "" {
		if root.AllowAuthenticated {
			if id.UserID == "" || id.OrgID == "" {
				return &contract.Failure{Message: "Unauthorized", Status: http.StatusUnauthorized}
			}
			return nil
		}
		return &contract.Failure{
			Message: "Permission metadata missing",
			Status:  http.StatusForbidden,
			AppCode: "PERMISSION_METADATA_MISSING",
		}
	}
	if id.Has(root.Permission) {
		return nil
	}
	return &contract.Failure{
		Message:             "Insufficient permissions",
		Status:              http.StatusForbidden,
		AppCode:             "INSUFFICIENT_PERMISSIONS",
		Detail:              "Requires any permission: " + root.Permission,
		RequiredPermissions: []string{root.Permission},
		PermissionsMode:     "any",
	}
}

// Authorize applies the same root permission contract to a Query, Mutation or
// Subscription root. Subscription planning reuses it so a local subscription
// fails with byte-identical FORBIDDEN/UNAUTHORIZED shapes.
func Authorize(root contract.Root, id contract.Identity) error {
	return authorizeRoot(root, id)
}

// fieldPermissionError builds the GraphQL error raised when the caller
// selects a field guarded by @HasPermission without holding that permission.
// The message, extensions, and HTTP status match the root permission failure
// and the NestJS GqlPermissionsGuard.
func fieldPermissionError(permission string, path []any) graphError {
	return graphError{
		Message: "Insufficient permissions",
		Path:    path,
		Extensions: map[string]any{
			"code":                "FORBIDDEN",
			"http":                map[string]any{"status": http.StatusForbidden},
			"appCode":             "INSUFFICIENT_PERMISSIONS",
			"detail":              "Requires any permission: " + permission,
			"requiredPermissions": []string{permission},
			"permissionsMode":     "any",
		},
	}
}

func fieldNonNull(field *ast.Field) bool {
	return field != nil && field.Definition != nil && field.Definition.Type != nil && field.Definition.Type.NonNull
}

func fieldFailure(err error, field collectedField, traceID string) graphError {
	path := []any{field.Key}
	var failure *contract.Failure
	if errors.As(err, &failure) && failure != nil {
		status := failure.Status
		if status == 0 {
			status = http.StatusInternalServerError
		}
		message := failure.Message
		if status >= 500 && !failure.ExposeMessage {
			message = "Internal server error"
		}
		if message == "" {
			message = http.StatusText(status)
		}
		extensions := map[string]any{
			"code": graphqlCode(status),
			"http": map[string]any{"status": status},
		}
		if traceID != "" {
			extensions["traceId"] = traceID
		}
		if failure.AppCode != "" {
			extensions["appCode"] = failure.AppCode
		}
		if failure.Detail != "" {
			extensions["detail"] = failure.Detail
		}
		if len(failure.RequiredPermissions) > 0 {
			extensions["requiredPermissions"] = failure.RequiredPermissions
		}
		if failure.PermissionsMode != "" {
			extensions["permissionsMode"] = failure.PermissionsMode
		}
		if len(failure.MissingPermissions) > 0 {
			extensions["missingPermissions"] = failure.MissingPermissions
		}
		var pos *ast.Position
		if field.Field != nil {
			pos = field.Field.Position
		}
		return graphError{Message: message, Path: path, Locations: positionLocations(pos), Extensions: extensions}
	}
	return internalField("Internal server error", path, traceID)
}

func internalField(message string, path []any, traceID string) graphError {
	extensions := map[string]any{
		"code": "INTERNAL_SERVER_ERROR",
		"http": map[string]any{"status": 500},
	}
	if traceID != "" {
		extensions["traceId"] = traceID
	}
	return graphError{Message: message, Path: path, Extensions: extensions}
}

func graphqlCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "BAD_REQUEST"
	case http.StatusUnauthorized:
		return "UNAUTHORIZED"
	case http.StatusForbidden:
		return "FORBIDDEN"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusConflict:
		return "CONFLICT"
	case http.StatusTooManyRequests:
		return "TOO_MANY_REQUESTS"
	case http.StatusServiceUnavailable:
		return "SERVICE_UNAVAILABLE"
	default:
		if status >= 500 {
			return "INTERNAL_SERVER_ERROR"
		}
		return "INTERNAL_SERVER_ERROR"
	}
}

func selectOperation(doc *ast.QueryDocument, operationName *string) (*ast.OperationDefinition, error) {
	if operationName != nil {
		op := doc.Operations.ForName(*operationName)
		if op == nil {
			return nil, errors.New("missing")
		}
		return op, nil
	}
	if len(doc.Operations) == 1 {
		return doc.Operations[0], nil
	}
	return nil, errors.New("ambiguous")
}

func selectionMessage(operationName *string, doc *ast.QueryDocument) string {
	if operationName != nil {
		return "Unknown operation named \"" + *operationName + "\"."
	}
	if len(doc.Operations) == 0 {
		return "Must provide operation name if query contains multiple operations."
	}
	return "Must provide operation name if query contains multiple operations."
}

func parseFailure(err error) Result {
	var gqlErr *gqlerror.Error
	if errors.As(err, &gqlErr) && gqlErr != nil {
		line, column := 0, 0
		if len(gqlErr.Locations) > 0 {
			line = gqlErr.Locations[0].Line
			column = gqlErr.Locations[0].Column
		}
		return parseError(gqlErr.Message, line, column)
	}
	return parseError(err.Error(), 0, 0)
}

func toGraphErrors(list gqlerror.List) []graphError {
	out := make([]graphError, 0, len(list))
	for _, err := range list {
		if err == nil {
			continue
		}
		item := graphError{Message: err.Message}
		for _, loc := range err.Locations {
			item.Locations = append(item.Locations, location{Line: loc.Line, Column: loc.Column})
		}
		out = append(out, item)
	}
	return out
}

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}
