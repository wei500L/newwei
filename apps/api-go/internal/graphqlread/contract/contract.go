// Package contract is the resolver registration surface shared by the GraphQL
// read executor and the alert, history, and economic query packages.
//
// Resolvers return plain Go values. The executor projects selected fields by
// reflection. Nested object types must be registered with RegisterType so an
// unregistered nested field fails closed into the legacy gateway instead of
// being rendered as a zero value.
//
// Struct fields use a graphql tag with the SDL name (`graphql:"metricSlug"`).
// Pointer fields are nullable. time.Time is DateTime. any is the JSON scalar.
// Enums are their SDL names as strings. Slices are lists; a nil slice of a
// non-null list is projected as an empty list.
package contract

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"sync"
	"time"
)

// FormatDateTime is JavaScript Date.toISOString: UTC with exactly three millisecond digits.
func FormatDateTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// Identity is the server-derived user. Permissions come from MySQL, never
// from JWT claims.
type Identity struct {
	UserID      string
	OrgID       string
	Permissions map[string]bool
}

// Has reports whether the derived permission set contains name.
func (id Identity) Has(name string) bool {
	return id.Permissions[name]
}

// Context is the per-root-field call context. Args are coerced GraphQL values:
// missing nullable arguments are absent; explicit null is a present nil;
// input objects are map[string]any; enums and DateTime inputs are strings;
// Int is an integer; Float is float64.
type Context struct {
	Ctx      context.Context
	Identity Identity
	Args     map[string]any
}

// Resolver loads one root field. It must not depend on which sibling fields
// were selected. Returning (nil, nil) for a nullable root is a GraphQL null.
type Resolver func(ctx Context) (any, error)

// Root is one migrated Query field.
//
// Permission is required unless AllowAuthenticated is set. Neither means the
// executor fails closed with PERMISSION_METADATA_MISSING.
type Root struct {
	Name               string
	Permission         string
	AllowAuthenticated bool
	Resolve            Resolver
}

// Failure is a field error whose HTTP status and extensions follow the Nest
// GraphQL exception filter. Status 0 means 500.
type Failure struct {
	Message             string
	Status              int
	Code                string
	AppCode             string
	Detail              string
	RequiredPermissions []string
	PermissionsMode     string
	MissingPermissions  []string
}

func (f *Failure) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// Registry stores root resolvers and the Go types used to project objects.
type Registry struct {
	mu     sync.RWMutex
	roots  map[string]Root
	types  map[string]reflect.Type
	fields map[string]map[string]struct{}
	// fieldPermissions maps a GraphQL object type and field to the single
	// permission required to select that field. The executor rejects a
	// selection of a protected field with the same FORBIDDEN failure the
	// root permission check uses, mirroring the NestJS field-level
	// @HasPermission directive.
	fieldPermissions map[string]map[string]string
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{
		roots:            map[string]Root{},
		types:            map[string]reflect.Type{},
		fields:           map[string]map[string]struct{}{},
		fieldPermissions: map[string]map[string]string{},
	}
}

// RegisterRoot adds a Query field. A second registration of the same name panics.
func (r *Registry) RegisterRoot(root Root) {
	if root.Name == "" || root.Resolve == nil {
		panic("graphqlread: root resolver requires a name and function")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.roots[root.Name]; ok {
		panic("graphqlread: duplicate root " + root.Name)
	}
	r.roots[root.Name] = root
}

// RegisterType records an object type's projected fields. sample may be a
// struct or a pointer to a struct. Unknown selected fields on this type make
// the whole operation legacy.
func (r *Registry) RegisterType(graphqlName string, sample any) {
	if graphqlName == "" || sample == nil {
		panic("graphqlread: type registration requires a name and sample")
	}
	typ := reflect.TypeOf(sample)
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct {
		panic("graphqlread: type " + graphqlName + " sample must be a struct")
	}
	fields := map[string]struct{}{}
	collectTags(typ, fields)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.types[graphqlName] = typ
	r.fields[graphqlName] = fields
}

// RegisterFieldPermission declares that selecting fieldName on the GraphQL
// object typeName requires permission. The executor fails such a selection
// with the same FORBIDDEN GraphQL error the root check produces, which
// mirrors NestJS's field-level @HasPermission guard. Registering the same
// field twice panics so a typo cannot silently lose the guard.
func (r *Registry) RegisterFieldPermission(typeName, fieldName, permission string) {
	if typeName == "" || fieldName == "" || permission == "" {
		panic("graphqlread: field permission requires a type, field, and permission")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	fields := r.fieldPermissions[typeName]
	if fields == nil {
		fields = map[string]string{}
		r.fieldPermissions[typeName] = fields
	}
	if existing, ok := fields[fieldName]; ok {
		panic("graphqlread: duplicate field permission " + typeName + "." + fieldName + " (" + existing + ")")
	}
	fields[fieldName] = permission
}

// FieldPermission returns the permission required to select fieldName on
// typeName and whether such a guard was registered.
func (r *Registry) FieldPermission(typeName, fieldName string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	fields := r.fieldPermissions[typeName]
	if fields == nil {
		return "", false
	}
	permission, ok := fields[fieldName]
	return permission, ok
}

// Root returns a registered root and whether it exists.
func (r *Registry) Root(name string) (Root, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	root, ok := r.roots[name]
	return root, ok
}

// HasType reports whether an object type was registered.
func (r *Registry) HasType(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.types[name]
	return ok
}

// HasField reports whether a registered object type projects field.
func (r *Registry) HasField(typeName, field string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	fields := r.fields[typeName]
	if fields == nil {
		return false
	}
	_, ok := fields[field]
	return ok
}

func collectTags(typ reflect.Type, out map[string]struct{}) {
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if field.Anonymous {
			embedded := field.Type
			for embedded.Kind() == reflect.Pointer {
				embedded = embedded.Elem()
			}
			if embedded.Kind() == reflect.Struct {
				collectTags(embedded, out)
			}
			continue
		}
		tag := field.Tag.Get("graphql")
		if tag == "" || tag == "-" {
			continue
		}
		out[tag] = struct{}{}
	}
}

// ArgState distinguishes a missing argument from an explicit null.
type ArgState int

const (
	// ArgMissing means the argument was omitted and has no schema default.
	ArgMissing ArgState = iota
	// ArgNull means the caller sent null.
	ArgNull
	// ArgValue means a non-null value is present.
	ArgValue
)

// Lookup reports whether args contains name.
func Lookup(args map[string]any, name string) (any, ArgState) {
	if args == nil {
		return nil, ArgMissing
	}
	value, ok := args[name]
	if !ok {
		return nil, ArgMissing
	}
	if value == nil {
		return nil, ArgNull
	}
	return value, ArgValue
}

// IntArg reads a GraphQL Int. Absent and null are not ok.
func IntArg(args map[string]any, name string) (int, bool) {
	value, state := Lookup(args, name)
	if state != ArgValue {
		return 0, false
	}
	number, ok := AsInt(value)
	return number, ok
}

// StringArg reads a GraphQL String or enum. Absent and null are not ok.
func StringArg(args map[string]any, name string) (string, bool) {
	value, state := Lookup(args, name)
	if state != ArgValue {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}

// MapArg reads an input object.
func MapArg(args map[string]any, name string) (map[string]any, bool) {
	value, state := Lookup(args, name)
	if state != ArgValue {
		return nil, false
	}
	record, ok := value.(map[string]any)
	return record, ok
}

// AsInt coerces the integer shapes produced by JSON and gqlparser.
func AsInt(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int32:
		return int(typed), true
	case int64:
		return int(typed), true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed != math.Trunc(typed) {
			return 0, false
		}
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	case string:
		parsed, err := strconv.Atoi(typed)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// AsFloat coerces a GraphQL Float.
func AsFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(typed, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

// FiniteFloat converts a decimal-like database value to a finite float.
// Non-finite and unparsable values are not ok.
func FiniteFloat(value any) (float64, bool) {
	if value == nil {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return FiniteFloat(float64(typed))
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	case string:
		return parseFinite(typed)
	case []byte:
		return parseFinite(string(typed))
	default:
		return parseFinite(fmt.Sprint(typed))
	}
}

func parseFinite(text string) (float64, bool) {
	if text == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// OptFloat returns nil when value is null or non-finite.
func OptFloat(value any) *float64 {
	parsed, ok := FiniteFloat(value)
	if !ok {
		return nil
	}
	return &parsed
}

// OptString returns nil for nil or a string pointer otherwise.
func OptString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
