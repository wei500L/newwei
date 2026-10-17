package newsnowclusteringops

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// newsnowAvailableSourceIDs is the set of source ids present in the registry.
// The personalized-ordering endpoint intersects the requested source ids with
// it before scoring.
var newsnowAvailableSourceIDs = func() map[string]struct{} {
	out := make(map[string]struct{}, len(newsnowSourceRegistry))
	for _, entry := range newsnowSourceRegistry {
		out[entry.ID] = struct{}{}
	}
	return out
}()

// newsnowColumnSourcesByID maps a column id to its ordered source ids, which the
// personalized-ordering endpoint uses as the fallback set when the request
// carries no explicit sources.
var newsnowColumnSourcesByID = func() map[string][]string {
	out := make(map[string][]string, len(newsnowColumnRegistry))
	for _, column := range newsnowColumnRegistry {
		sources := make([]string, len(column.Sources))
		copy(sources, column.Sources)
		out[column.ID] = sources
	}
	return out
}()

// metadataResponse is the payload of GET /api/news-aggregator/metadata. Both
// members are serialized in the NestJS insertion order, which Go's map encoder
// would otherwise reorder alphabetically.
type metadataResponse struct {
	Sources newsnowSourceMap `json:"sources"`
	Columns newsnowColumnMap `json:"columns"`
}

// newsnowSourceMap is the ordered source registry object of the metadata
// payload.
type newsnowSourceMap []newsnowRegistryEntry

// MarshalJSON writes the registry as a JSON object in slice order.
func (m newsnowSourceMap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, entry := range m {
		if i > 0 {
			buf.WriteByte(',')
		}
		encodedID, err := json.Marshal(entry.ID)
		if err != nil {
			return nil, err
		}
		buf.Write(encodedID)
		buf.WriteByte(':')
		encodedSource, err := json.Marshal(entry.Source)
		if err != nil {
			return nil, err
		}
		buf.Write(encodedSource)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// newsnowColumnMap is the ordered column object of the metadata payload.
type newsnowColumnMap []newsnowColumnDefinition

// MarshalJSON writes the column registry as a JSON object in slice order. The
// sources list is always emitted as an array, never null.
func (m newsnowColumnMap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, column := range m {
		if i > 0 {
			buf.WriteByte(',')
		}
		encodedID, err := json.Marshal(column.ID)
		if err != nil {
			return nil, err
		}
		buf.Write(encodedID)
		buf.WriteString(`:{"name":`)
		encodedName, err := json.Marshal(column.Name)
		if err != nil {
			return nil, err
		}
		buf.Write(encodedName)
		buf.WriteString(`,"sources":`)
		sources := column.Sources
		if sources == nil {
			sources = []string{}
		}
		encodedSources, err := json.Marshal(sources)
		if err != nil {
			return nil, err
		}
		buf.Write(encodedSources)
		buf.WriteByte('}')
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// MarshalJSON writes one source entry using the exact JSON key order recorded
// when the registry was generated from the NestJS data files. Go struct field
// order cannot express that order because the NestJS spread operator places
// `title` first for plain sources and `redirect` first for redirect parents.
func (s newsnowMetadataSource) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, key := range s.Keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key.Name)
		if err != nil {
			return nil, err
		}
		buf.Write(encodedKey)
		buf.WriteByte(':')
		if err := s.writeField(&buf, key.Kind); err != nil {
			return nil, err
		}
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// writeField encodes the typed slot selected by kind. Only keys present in the
// generated key order reach this method, so string slots are never empty.
func (s newsnowMetadataSource) writeField(buf *bytes.Buffer, kind newsnowSourceFieldKind) error {
	switch kind {
	case newsnowFieldInterval:
		buf.WriteString(strconv.Itoa(s.Interval))
		return nil
	case newsnowFieldRuntimeSecrets:
		encoded, err := json.Marshal(s.RuntimeSecrets)
		if err != nil {
			return err
		}
		buf.Write(encoded)
		return nil
	default:
		encoded, err := json.Marshal(s.stringField(kind))
		if err != nil {
			return err
		}
		buf.Write(encoded)
		return nil
	}
}

// stringField resolves the string slot selected by kind.
func (s newsnowMetadataSource) stringField(kind newsnowSourceFieldKind) string {
	switch kind {
	case newsnowFieldRedirect:
		return s.Redirect
	case newsnowFieldName:
		return s.Name
	case newsnowFieldType:
		return s.Type
	case newsnowFieldDisable:
		return s.Disable
	case newsnowFieldDesc:
		return s.Desc
	case newsnowFieldColumn:
		return s.Column
	case newsnowFieldHome:
		return s.Home
	case newsnowFieldColor:
		return s.Color
	case newsnowFieldTitle:
		return s.Title
	default:
		return ""
	}
}

// buildMetadata assembles the deterministic metadata payload. It mirrors
// NestJS NewsAggregatorService.getMetadata(), which returns
// { sources: genSources(), columns: genMetadata(genSources()) }.
func buildMetadata() metadataResponse {
	sources := make(newsnowSourceMap, 0, len(newsnowSourceRegistry))
	sources = append(sources, newsnowSourceRegistry...)
	columns := make(newsnowColumnMap, 0, len(newsnowColumnRegistry))
	columns = append(columns, newsnowColumnRegistry...)
	return metadataResponse{Sources: sources, Columns: columns}
}
