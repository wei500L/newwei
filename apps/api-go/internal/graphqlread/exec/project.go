package exec

import (
	"encoding/json"
	"math"
	"reflect"
	"time"

	"github.com/vektah/gqlparser/v2/ast"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

func (e *Engine) project(typ *ast.Type, value reflect.Value, set ast.SelectionSet, doc *ast.QueryDocument, vars map[string]any, path []any) (any, bool, []graphError) {
	if typ == nil {
		return nil, true, []graphError{{Message: "Internal server error", Path: append([]any{}, path...)}}
	}
	value = derefInterface(value)
	if typ.Elem != nil {
		return e.projectList(typ, value, set, doc, vars, path)
	}
	if !value.IsValid() {
		if typ.NonNull {
			return nil, true, []graphError{{
				Message:    "Cannot return null for non-nullable field",
				Path:       append([]any{}, path...),
				Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
			}}
		}
		return nil, true, nil
	}
	named := e.schema.Types[typ.Name()]
	if named == nil {
		return nil, true, []graphError{{Message: "Internal server error", Path: append([]any{}, path...)}}
	}
	switch named.Kind {
	case ast.Scalar, ast.Enum:
		return e.projectLeaf(named, typ.NonNull, value, path)
	default:
		return e.projectObject(named, typ.NonNull, value, set, doc, vars, path)
	}
}

func (e *Engine) projectList(typ *ast.Type, value reflect.Value, set ast.SelectionSet, doc *ast.QueryDocument, vars map[string]any, path []any) (any, bool, []graphError) {
	value = derefInterface(value)
	if !value.IsValid() || (value.Kind() == reflect.Pointer && value.IsNil()) || (value.Kind() == reflect.Slice && value.IsNil()) {
		if typ.NonNull {
			if value.Kind() == reflect.Slice {
				return []any{}, false, nil
			}
			return nil, true, []graphError{{
				Message:    "Cannot return null for non-nullable field",
				Path:       append([]any{}, path...),
				Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
			}}
		}
		return nil, true, nil
	}
	for value.Kind() == reflect.Pointer {
		if value.IsNil() {
			if typ.NonNull {
				return []any{}, false, nil
			}
			return nil, true, nil
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Slice && value.Kind() != reflect.Array {
		return nil, true, []graphError{{
			Message:    "Expected a list",
			Path:       append([]any{}, path...),
			Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
		}}
	}
	out := make([]any, 0, value.Len())
	var errors []graphError
	for i := 0; i < value.Len(); i++ {
		itemPath := append(append([]any{}, path...), i)
		item, isNull, itemErrors := e.project(typ.Elem, value.Index(i), set, doc, vars, itemPath)
		errors = append(errors, itemErrors...)
		if isNull && typ.Elem.NonNull {
			return nil, true, errors
		}
		out = append(out, item)
	}
	return out, false, errors
}

func (e *Engine) projectObject(def *ast.Definition, nonNull bool, value reflect.Value, set ast.SelectionSet, doc *ast.QueryDocument, vars map[string]any, path []any) (any, bool, []graphError) {
	value = concrete(value)
	if !value.IsValid() {
		if nonNull {
			return nil, true, []graphError{{
				Message:    "Cannot return null for non-nullable field",
				Path:       append([]any{}, path...),
				Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
			}}
		}
		return nil, true, nil
	}
	fields := collectFields(e.schema, def, set, doc, vars, map[string]bool{})
	result := map[string]any{}
	var errors []graphError
	nullObject := false
	for _, field := range fields {
		fieldPath := append(append([]any{}, path...), field.Key)
		if field.Name == "__typename" {
			result[field.Key] = def.Name
			continue
		}
		fieldDef := def.Fields.ForName(field.Name)
		if fieldDef == nil {
			errors = append(errors, graphError{
				Message:    "Cannot query field \"" + field.Name + "\" on type \"" + def.Name + "\".",
				Path:       fieldPath,
				Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
			})
			nullObject = true
			continue
		}
		child, ok := fieldValue(value, field.Name)
		if !ok {
			errors = append(errors, graphError{
				Message:    "Field \"" + field.Name + "\" is not implemented on \"" + def.Name + "\"",
				Path:       fieldPath,
				Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
			})
			if fieldDef.Type.NonNull {
				nullObject = true
			} else {
				result[field.Key] = nil
			}
			continue
		}
		projected, isNull, fieldErrors := e.project(fieldDef.Type, child, field.Selections, doc, vars, fieldPath)
		errors = append(errors, fieldErrors...)
		if isNull && fieldDef.Type.NonNull {
			nullObject = true
			continue
		}
		result[field.Key] = projected
	}
	if nullObject {
		return nil, true, errors
	}
	return result, false, errors
}

func (e *Engine) projectLeaf(def *ast.Definition, nonNull bool, value reflect.Value, path []any) (any, bool, []graphError) {
	value = concrete(value)
	if !value.IsValid() {
		if nonNull {
			return nil, true, []graphError{{
				Message:    "Cannot return null for non-nullable field",
				Path:       append([]any{}, path...),
				Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
			}}
		}
		return nil, true, nil
	}
	switch def.Name {
	case "Int":
		number, ok := contract.AsInt(value.Interface())
		if !ok {
			return nil, true, []graphError{{Message: "Int cannot represent non-integer value", Path: append([]any{}, path...)}}
		}
		return number, false, nil
	case "Float":
		number, ok := contract.AsFloat(value.Interface())
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
			if nonNull {
				return nil, true, []graphError{{
					Message:    "Float cannot represent non numeric value",
					Path:       append([]any{}, path...),
					Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
				}}
			}
			return nil, true, nil
		}
		return number, false, nil
	case "String", "ID":
		switch typed := value.Interface().(type) {
		case string:
			return typed, false, nil
		case []byte:
			return string(typed), false, nil
		default:
			return nil, true, []graphError{{Message: "String cannot represent value", Path: append([]any{}, path...)}}
		}
	case "Boolean":
		typed, ok := value.Interface().(bool)
		if !ok {
			return nil, true, []graphError{{Message: "Boolean cannot represent value", Path: append([]any{}, path...)}}
		}
		return typed, false, nil
	case "DateTime":
		switch typed := value.Interface().(type) {
		case time.Time:
			return contract.FormatDateTime(typed), false, nil
		case string:
			return typed, false, nil
		default:
			return nil, true, []graphError{{Message: "DateTime cannot represent value", Path: append([]any{}, path...)}}
		}
	case "JSON":
		normalized := normalizeJSON(value.Interface())
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return nil, true, []graphError{{Message: "JSON cannot represent value", Path: append([]any{}, path...)}}
		}
		return json.RawMessage(encoded), false, nil
	default:
		if def.Kind == ast.Enum {
			text, ok := value.Interface().(string)
			if !ok {
				return nil, true, []graphError{{Message: "Enum cannot represent value", Path: append([]any{}, path...)}}
			}
			if !enumHas(def, text) {
				return nil, true, []graphError{{
					Message:    "Enum \"" + def.Name + "\" cannot represent value: \"" + text + "\"",
					Path:       append([]any{}, path...),
					Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
				}}
			}
			return text, false, nil
		}
		return normalizeJSON(value.Interface()), false, nil
	}
}

func derefInterface(value reflect.Value) reflect.Value {
	for value.IsValid() && value.Kind() == reflect.Interface {
		if value.IsNil() {
			return reflect.Value{}
		}
		value = value.Elem()
	}
	return value
}

func concrete(value reflect.Value) reflect.Value {
	value = derefInterface(value)
	for value.IsValid() && value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return reflect.Value{}
		}
		value = value.Elem()
		value = derefInterface(value)
	}
	return value
}

func fieldValue(value reflect.Value, name string) (reflect.Value, bool) {
	value = concrete(value)
	if !value.IsValid() {
		return reflect.Value{}, false
	}
	if value.Kind() == reflect.Map {
		key := reflect.ValueOf(name)
		if value.Type().Key().Kind() != reflect.String {
			return reflect.Value{}, false
		}
		item := value.MapIndex(key)
		if !item.IsValid() {
			return reflect.Value{}, true
		}
		return item, true
	}
	if value.Kind() != reflect.Struct {
		return reflect.Value{}, false
	}
	path, ok := structPath(value.Type(), name)
	if !ok {
		return reflect.Value{}, false
	}
	current := value
	for _, index := range path {
		for current.Kind() == reflect.Pointer {
			if current.IsNil() {
				return reflect.Value{}, true
			}
			current = current.Elem()
		}
		if current.Kind() != reflect.Struct || index >= current.NumField() {
			return reflect.Value{}, false
		}
		current = current.Field(index)
	}
	return current, true
}

func structPath(typ reflect.Type, name string) ([]int, bool) {
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct {
		return nil, false
	}
	var walk func(reflect.Type, []int) ([]int, bool)
	walk = func(typ reflect.Type, prefix []int) ([]int, bool) {
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			path := append(append([]int{}, prefix...), i)
			if field.Anonymous {
				embedded := field.Type
				for embedded.Kind() == reflect.Pointer {
					embedded = embedded.Elem()
				}
				if embedded.Kind() == reflect.Struct {
					if found, ok := walk(embedded, path); ok {
						return found, true
					}
				}
				continue
			}
			if field.Tag.Get("graphql") == name {
				return path, true
			}
		}
		return nil, false
	}
	return walk(typ, nil)
}

func enumHas(def *ast.Definition, name string) bool {
	for _, value := range def.EnumValues {
		if value != nil && value.Name == name {
			return true
		}
	}
	return false
}

func normalizeJSON(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case time.Time:
		return contract.FormatDateTime(typed)
	case *time.Time:
		if typed == nil {
			return nil
		}
		return contract.FormatDateTime(*typed)
	case json.RawMessage:
		if json.Valid(typed) {
			var decoded any
			if err := json.Unmarshal(typed, &decoded); err == nil {
				return normalizeJSON(decoded)
			}
		}
		return string(typed)
	case []byte:
		if json.Valid(typed) {
			var decoded any
			if err := json.Unmarshal(typed, &decoded); err == nil {
				return normalizeJSON(decoded)
			}
		}
		return string(typed)
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeJSON(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = normalizeJSON(item)
		}
		return out
	default:
		return typed
	}
}
