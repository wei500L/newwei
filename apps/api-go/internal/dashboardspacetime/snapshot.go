package dashboardspacetime

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

type snapshotView struct {
	orgID      string
	eventID    string
	rangeStart string
	rangeEnd   string
	keys       map[string][]string
}

func marshalSnapshot(orgID, eventID string, start, end time.Time, keys map[string][]string) ([]byte, string, bool) {
	if len(keys) == 0 {
		return nil, "", false
	}
	ids := make([]string, 0, len(keys))
	for id, values := range keys {
		if id == "" || len(values) == 0 {
			continue
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil, "", false
	}
	sort.SliceStable(ids, func(i, j int) bool {
		return localeCompare(ids[i], ids[j]) < 0
	})
	var buf bytes.Buffer
	buf.WriteString(`{"v":1,"orgId":`)
	buf.WriteString(jsString(orgID))
	buf.WriteString(`,"eventId":`)
	if eventID == "" {
		buf.WriteString("null")
	} else {
		buf.WriteString(jsString(eventID))
	}
	buf.WriteString(`,"rangeStart":`)
	buf.WriteString(jsString(toISO(start)))
	buf.WriteString(`,"rangeEnd":`)
	buf.WriteString(jsString(toISO(end)))
	buf.WriteString(`,"pointToLocationKeys":{`)
	for index, id := range ids {
		if index > 0 {
			buf.WriteByte(',')
		}
		values := append([]string(nil), keys[id]...)
		sort.SliceStable(values, func(i, j int) bool {
			return localeCompare(values[i], values[j]) < 0
		})
		buf.WriteString(jsString(id))
		buf.WriteString(`:[`)
		for valueIndex, value := range values {
			if valueIndex > 0 {
				buf.WriteByte(',')
			}
			buf.WriteString(jsString(value))
		}
		buf.WriteByte(']')
	}
	buf.WriteString(`}}`)
	body := buf.Bytes()
	sum := sha256.Sum256(body)
	return body, hex.EncodeToString(sum[:]), true
}

func parseSnapshot(raw []byte, orgID string) (snapshotView, bool) {
	var doc struct {
		OrgID      string              `json:"orgId"`
		EventID    *string             `json:"eventId"`
		RangeStart string              `json:"rangeStart"`
		RangeEnd   string              `json:"rangeEnd"`
		Keys       map[string][]string `json:"pointToLocationKeys"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return snapshotView{}, false
	}
	if doc.OrgID != "" && doc.OrgID != orgID {
		return snapshotView{}, false
	}
	eventID := ""
	if doc.EventID != nil {
		eventID = *doc.EventID
	}
	keys := make(map[string][]string, len(doc.Keys))
	for id, values := range doc.Keys {
		kept := make([]string, 0, len(values))
		for _, value := range values {
			value = strings.TrimSpace(value)
			if value != "" {
				kept = append(kept, value)
			}
		}
		if len(kept) > 0 {
			keys[id] = kept
		}
	}
	return snapshotView{
		orgID: doc.OrgID, eventID: eventID,
		rangeStart: doc.RangeStart, rangeEnd: doc.RangeEnd, keys: keys,
	}, true
}

func jsString(value string) string {
	encoded, err := marshalNest(value)
	if err != nil {
		return `""`
	}
	return string(encoded)
}

func marshalNest(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func toISO(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
