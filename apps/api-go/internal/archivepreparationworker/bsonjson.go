package archivepreparationworker

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// bsonValueToJSON renders a Mongo result subdocument as JSON without dropping
// members. bson.D keeps the stored order; ObjectIds and dates become the same
// strings JSON.stringify produces for a Mongoose lean document.
func bsonValueToJSON(value bson.RawValue) (json.RawMessage, error) {
	if value.IsZero() || value.Type == bson.TypeNull || value.Type == bson.TypeUndefined {
		return nil, nil
	}
	var document bson.D
	if err := bson.Unmarshal(value.Value, &document); err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	if err := writeBSONJSON(&buffer, document); err != nil {
		return nil, err
	}
	return json.RawMessage(buffer.Bytes()), nil
}

func writeBSONJSON(buffer *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		buffer.WriteString("null")
	case bson.D:
		buffer.WriteByte('{')
		for index, element := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}
			encodedKey, err := json.Marshal(element.Key)
			if err != nil {
				return err
			}
			buffer.Write(encodedKey)
			buffer.WriteByte(':')
			if err := writeBSONJSON(buffer, element.Value); err != nil {
				return err
			}
		}
		buffer.WriteByte('}')
	case bson.M:
		return writeBSONJSON(buffer, mapToDocument(typed))
	case bson.A:
		buffer.WriteByte('[')
		for index, entry := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if err := writeBSONJSON(buffer, entry); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
	case []any:
		buffer.WriteByte('[')
		for index, entry := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if err := writeBSONJSON(buffer, entry); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
	case string:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return err
		}
		buffer.Write(encoded)
	case bool:
		if typed {
			buffer.WriteString("true")
		} else {
			buffer.WriteString("false")
		}
	case int:
		buffer.WriteString(strconv.FormatInt(int64(typed), 10))
	case int32:
		buffer.WriteString(strconv.FormatInt(int64(typed), 10))
	case int64:
		buffer.WriteString(strconv.FormatInt(typed, 10))
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			buffer.WriteString("null")
			return nil
		}
		buffer.WriteString(strconv.FormatFloat(typed, 'g', -1, 64))
	case bson.ObjectID:
		encoded, err := json.Marshal(typed.Hex())
		if err != nil {
			return err
		}
		buffer.Write(encoded)
	case time.Time:
		encoded, err := json.Marshal(typed.UTC().Format("2006-01-02T15:04:05.000Z"))
		if err != nil {
			return err
		}
		buffer.Write(encoded)
	case json.Number:
		buffer.WriteString(typed.String())
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return err
		}
		buffer.Write(encoded)
	}
	return nil
}

func mapToDocument(values bson.M) bson.D {
	document := make(bson.D, 0, len(values))
	for key, value := range values {
		document = append(document, bson.E{Key: key, Value: value})
	}
	return document
}

// jsonToBSONDocument turns the updated JSON result back into an ordered BSON
// document for the $set write.
func jsonToBSONDocument(raw json.RawMessage) (bson.D, error) {
	var document bson.D
	if err := bson.UnmarshalExtJSON(raw, false, &document); err != nil {
		return nil, err
	}
	return document, nil
}

// mongoIDFilterValue preserves the stored _id type so a string and an ObjectId
// document are both matched.
func mongoIDFilterValue(value bson.RawValue) (any, string) {
	switch value.Type {
	case bson.TypeObjectID:
		var id bson.ObjectID
		if err := value.Unmarshal(&id); err == nil {
			return id, id.Hex()
		}
	case bson.TypeString:
		var text string
		if err := value.Unmarshal(&text); err == nil {
			return text, text
		}
	}
	return nil, ""
}
