// Package jsvalue holds the small JavaScript-style coercions shared by handlers
// that decode loosely-typed maps. Only conversions whose semantics are identical
// across every copy live here; conversions with different fallbacks stay in
// their package.
package jsvalue

// String is the JS `typeof value === "string" ? value : ""` coercion: a string
// is returned, any other dynamic type yields the empty string.
func String(value any) string {
	text, _ := value.(string)
	return text
}

// Int narrows a numeric JSON value to int, returning 0 for anything that is not
// one of the integer/float shapes encoding/json produces. It mirrors the
// asInt helper used by GraphQL map decoding; float64 truncates toward zero the
// same way the original switch did.
func Int(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int32:
		return int(typed)
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}
