package classificationrssops

import (
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// optionalString distinguishes an absent BSON field from a stored null so the
// JSON output matches JavaScript exactly: an absent field is omitted (like
// undefined) and a stored null is serialized as null.
type optionalString struct {
	present bool
	value   *string
}

// newOptionalString decodes a BSON string field.
func newOptionalString(value bson.RawValue) optionalString {
	return optionalString{present: rawPresent(value), value: rawString(value)}
}

// IsZero reports whether the field is absent; json's omitzero option uses it.
func (o optionalString) IsZero() bool { return !o.present }

// MarshalJSON emits null for a stored null and the string otherwise.
func (o optionalString) MarshalJSON() ([]byte, error) {
	if o.value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*o.value)
}

// optionalNumber distinguishes an absent BSON field from a stored null.
type optionalNumber struct {
	present bool
	value   *float64
}

// newOptionalNumber decodes a BSON numeric field.
func newOptionalNumber(value bson.RawValue) optionalNumber {
	return optionalNumber{present: rawPresent(value), value: rawNumber(value)}
}

// newOptionalNumberFromValue wraps an already computed number as present.
func newOptionalNumberFromValue(value float64) optionalNumber {
	return optionalNumber{present: true, value: &value}
}

// IsZero reports whether the field is absent; json's omitzero option uses it.
func (o optionalNumber) IsZero() bool { return !o.present }

// MarshalJSON emits null for a stored null and the number otherwise.
func (o optionalNumber) MarshalJSON() ([]byte, error) {
	if o.value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*o.value)
}

// optionalTime distinguishes an absent BSON date from a stored null and always
// renders with millisecond precision (Date.prototype.toISOString).
type optionalTime struct {
	present bool
	value   *time.Time
}

// newOptionalTime decodes a BSON date/time-like field.
func newOptionalTime(value bson.RawValue) optionalTime {
	return optionalTime{present: rawPresent(value), value: rawTime(value)}
}

// IsZero reports whether the field is absent; json's omitzero option uses it.
func (o optionalTime) IsZero() bool { return !o.present }

// MarshalJSON emits null for a stored null and the ISO string otherwise.
func (o optionalTime) MarshalJSON() ([]byte, error) {
	if o.value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(formatJSTime(*o.value))
}
