package itempipeline

// Mongoose ObjectId compatibility helpers.
//
// Types.ObjectId.isValid accepts a 24-character hexadecimal string and any
// 12-byte string (the BSON implementation checks `input.length === 12` before
// the hex check), so the Go port must accept both. A 12-byte string is used as
// the raw ObjectId bytes, not as hex.

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// isValidObjectID is Types.ObjectId.isValid for string inputs.
func isValidObjectID(value string) bool {
	if len(value) == 12 {
		return true
	}
	if len(value) != 24 {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		isDigit := character >= '0' && character <= '9'
		isLower := character >= 'a' && character <= 'f'
		isUpper := character >= 'A' && character <= 'F'
		if !isDigit && !isLower && !isUpper {
			return false
		}
	}
	return true
}

// objectIDFromJSValue converts a Types.ObjectId.isValid string the same way
// `new Types.ObjectId(value)` does: a 24-character hex string is parsed as hex,
// a 12-byte string is copied as the ObjectId bytes.
func objectIDFromJSValue(value string) (bson.ObjectID, bool) {
	if !isValidObjectID(value) {
		return bson.ObjectID{}, false
	}
	if len(value) == 24 {
		objectID, err := bson.ObjectIDFromHex(value)
		if err != nil {
			return bson.ObjectID{}, false
		}
		return objectID, true
	}
	var objectID bson.ObjectID
	copy(objectID[:], []byte(value))
	return objectID, true
}

// isoMillis is Date.prototype.toISOString: UTC, millisecond precision, Z.
func isoMillis(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

// isoMillisPtr is the nullable toISOString helper.
func isoMillisPtr(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := isoMillis(*value)
	return &formatted
}

// msTime truncates a timestamp to the millisecond, like every Date written to
// MySQL/Mongo by the NestJS code.
func msTime(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}
