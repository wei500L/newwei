package exec

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"

	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/parser"
	"github.com/vektah/gqlparser/v2/validator"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// SubscriptionPlan is the ownership decision for one graphql-transport-ws
// subscribe payload. KindSubscriptionError means the payload names an operation
// the local executor does not own (a non-subscription operation, an
// unregistered root, or an unsupported selected field); the WS layer reports it
// as an operation-level error and never forwards it to NestJS.
// KindProtocol is a local pre-execution failure (variable coercion) that
// graphql-ws reports as a next(result) followed by complete, not as a
// connection close.
type SubscriptionPlan struct {
	Kind          string
	Result        Result
	Doc           *ast.QueryDocument
	Op            *ast.OperationDefinition
	Root          *ast.Definition
	Field         collectedField
	Query         string
	OperationName string
	RawVariables  map[string]any
	Variables     map[string]any
}

// PlanSubscription parses, validates, and decides whether one subscribe
// payload is fully implemented by the local Subscription registry.
//
// Parse errors, unknown or ambiguous operations, non-subscription operations,
// validation failures, unsupported roots and unsupported selected fields are
// reported as operation-level errors. A non-subscription operation, an
// unregistered root, or an unsupported selected field is a
// KindSubscriptionError so the WS layer reports the error and never forwards
// the payload to NestJS; the local executor never runs a partially supported
// operation.
func (e *Engine) PlanSubscription(query string, operationName *string, rawVariables map[string]any) SubscriptionPlan {
	plan := SubscriptionPlan{Query: query, RawVariables: rawVariables}
	if operationName != nil {
		plan.OperationName = *operationName
	}
	doc, err := parser.ParseQuery(&ast.Source{Name: "query", Input: query})
	if err != nil {
		// graphql-ws reports parse/validation failures as an operation-level
		// error message and does not send complete.
		plan.Kind = KindSubscriptionError
		plan.Result = parseFailure(err)
		return plan
	}
	plan.Doc = doc
	op, selectionErr := selectOperation(doc, operationName)
	if validation := validator.Validate(e.schema, doc); len(validation) > 0 {
		plan.Kind = KindSubscriptionError
		plan.Op = op
		plan.Result = validationErrors(toGraphErrors(validation))
		return plan
	}
	if selectionErr != nil || op == nil {
		// Unknown or ambiguous operation resolution is an ExecutionResult
		// failure: next(errors) then complete, not a protocol error.
		plan.Kind = KindProtocol
		plan.Result = operationResolution(selectionMessage(operationName, doc))
		return plan
	}
	plan.Op = op
	if op.Operation != ast.Subscription || e.schema.Subscription == nil {
		plan.Kind = KindSubscriptionError
		plan.Result = operationNotSupported()
		return plan
	}
	coerced, err := validator.VariableValues(e.schema, op, rawVariables)
	if err != nil {
		// graphql-js coerces variables inside subscribe() and returns an
		// ExecutionResult; graphql-ws sends next(errors) then complete.
		plan.Kind = KindProtocol
		plan.Result = userInput(err.Error(), 0, 0)
		return plan
	}
	plan.Variables = coerced
	fields := collectFields(e.schema, e.schema.Subscription, op.SelectionSet, doc, coerced, map[string]bool{})
	if len(fields) != 1 {
		plan.Kind = KindSubscriptionError
		plan.Result = operationNotSupported()
		return plan
	}
	field := fields[0]
	if field.Name == "__typename" {
		plan.Kind = KindSubscriptionError
		plan.Result = operationNotSupported()
		return plan
	}
	if _, ok := e.reg.Subscription(field.Name); !ok {
		plan.Kind = KindSubscriptionError
		plan.Result = operationNotSupported()
		return plan
	}
	fieldDef := e.schema.Subscription.Fields.ForName(field.Name)
	if fieldDef == nil || !e.typeSupported(fieldDef.Type, field.Selections, doc, map[string]bool{}) {
		plan.Kind = KindSubscriptionError
		plan.Result = operationNotSupported()
		return plan
	}
	plan.Root = e.schema.Subscription
	plan.Field = field
	plan.Kind = KindExecute
	return plan
}

// SubscriptionExecution is one authenticated, planned subscription operation.
// Plan, Selection and the permission check are computed once; every event
// reuses them and only maps the strongly typed payload through projection.
type SubscriptionExecution struct {
	Plan         SubscriptionPlan
	Subscription contract.Subscription
	Identity     contract.Identity
	Selection    *contract.FieldSet
	TraceID      string
}

// PrepareSubscription applies the per-operation rate limit and authentication
// through prepare, then the root permission check. It runs exactly once per
// subscribe message, before any event is read.
//
// A failure is returned as a GraphQL ExecutionResult (errors only). The
// protocol layer sends it as next(payload) followed by complete, matching
// graphql-ws resolver/guard failures rather than closing the connection.
func (e *Engine) PrepareSubscription(ctx context.Context, plan SubscriptionPlan, prepare PrepareRoot, traceID string) (*SubscriptionExecution, *Result) {
	if plan.Kind != KindExecute || plan.Root == nil {
		result := protocolResult(http.StatusBadRequest, nil, graphError{
			Message:    "Subscription is not implemented",
			Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
		})
		return nil, &result
	}
	fieldDef := plan.Root.Fields.ForName(plan.Field.Name)
	if fieldDef == nil {
		result := protocolResult(http.StatusInternalServerError, nil, internalField("Internal server error", []any{plan.Field.Key}, traceID))
		return nil, &result
	}
	identity, err := prepare(ctx, plan.Field.Key, plan.Field.Name)
	if err != nil {
		result := protocolResult(http.StatusOK, nil, fieldFailure(err, plan.Field, traceID))
		return nil, &result
	}
	subscription, ok := e.reg.Subscription(plan.Field.Name)
	if !ok {
		result := protocolResult(http.StatusOK, nil, internalField("Field is not implemented", []any{plan.Field.Key}, traceID))
		return nil, &result
	}
	if permissionErr := authorizeRoot(subscription.Root, identity); permissionErr != nil {
		result := protocolResult(http.StatusOK, nil, fieldFailure(permissionErr, plan.Field, traceID))
		return nil, &result
	}
	return &SubscriptionExecution{
		Plan:         plan,
		Subscription: subscription,
		Identity:     identity,
		Selection:    e.rootFieldSelection(plan.Root, plan.Field, plan.Doc, plan.Variables),
		TraceID:      traceID,
	}, nil
}

// OpenSubscription starts the event source for one authenticated operation.
// The caller cancels ctx when the client completes, reuses the operation ID or
// closes the connection; the source must then release its reader.
func (e *Engine) OpenSubscription(ctx context.Context, execution *SubscriptionExecution) (<-chan contract.SubscriptionEvent, error) {
	return execution.Subscription.Open(contract.Context{
		Ctx:       ctx,
		Identity:  execution.Identity,
		Selection: execution.Selection,
	})
}

// ProjectSubscriptionEvent maps one strongly typed payload onto the planned
// selection set. It reuses the Query projection and non-null propagation, so
// aliases, fragments, @skip/@include, enums, DateTime and JSON behave exactly
// as they do for HTTP results.
func (e *Engine) ProjectSubscriptionEvent(execution *SubscriptionExecution, event contract.SubscriptionEvent) Result {
	header := http.Header{}
	header.Set("Cache-Control", "no-store")
	fieldDef := execution.Plan.Root.Fields.ForName(execution.Plan.Field.Name)
	if fieldDef == nil {
		return dataResult(http.StatusOK, nil, true, true,
			[]graphError{internalField("Internal server error", []any{execution.Plan.Field.Key}, execution.TraceID)}, header)
	}
	if event.Error != nil {
		return subscriptionFieldError(execution, event.Error, header)
	}
	fieldPath := []any{execution.Plan.Field.Key}
	projected, isNull, projectErrors := e.project(
		fieldDef.Type,
		reflect.ValueOf(event.Value),
		execution.Plan.Field.Selections,
		execution.Plan.Doc,
		execution.Plan.Variables,
		fieldPath,
		execution.Identity,
	)
	for i := range projectErrors {
		if projectErrors[i].Extensions == nil {
			projectErrors[i].Extensions = map[string]any{}
		}
		if execution.TraceID != "" {
			projectErrors[i].Extensions["traceId"] = execution.TraceID
		}
	}
	if isNull && fieldDef.Type.NonNull {
		return dataResult(http.StatusOK, nil, true, true, projectErrors, header)
	}
	data, err := json.Marshal(map[string]any{execution.Plan.Field.Key: projected})
	if err != nil {
		return dataResult(http.StatusOK, nil, true, true,
			[]graphError{internalField("Internal server error", fieldPath, execution.TraceID)}, header)
	}
	return dataResult(http.StatusOK, data, false, true, projectErrors, header)
}

// subscriptionFieldError reports a payload conversion failure at one nested
// field. The root Subscription field is non-null in the SDL, so a failed
// nested non-null scalar nulls the whole event data while the error path keeps
// the failing field, exactly like GraphQL scalar serialization.
func subscriptionFieldError(execution *SubscriptionExecution, eventErr *contract.SubscriptionEventError, header http.Header) Result {
	path := []any{execution.Plan.Field.Key}
	if eventErr.Field != "" {
		path = append(path, eventErr.Field)
	}
	extensions := map[string]any{
		"code": "INTERNAL_SERVER_ERROR",
		"http": map[string]any{"status": http.StatusInternalServerError},
	}
	if execution.TraceID != "" {
		extensions["traceId"] = execution.TraceID
	}
	return dataResult(http.StatusOK, nil, true, true, []graphError{{
		Message:    eventErr.Message,
		Path:       path,
		Extensions: extensions,
	}}, header)
}
