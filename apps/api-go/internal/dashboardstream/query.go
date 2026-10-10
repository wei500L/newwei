package dashboardstream

import (
	"net/url"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
)

type stringField struct {
	value string
	set   bool
	multi bool
}

func (f *stringField) add(value string) {
	if f.set {
		f.multi = true
		return
	}
	f.value = value
	f.set = true
}

type streamQuery struct {
	start            stringField
	end              stringField
	warMapStart      stringField
	warMapEnd        stringField
	warMapTranslate  stringField
	warMapBbox       stringField
	warMapZoom       stringField
	warMapFlightMode stringField
	warMapAisMode    stringField
	unknown          []string
}

func parseStreamQuery(raw string) streamQuery {
	var query streamQuery
	if raw == "" {
		return query
	}
	seenUnknown := map[string]struct{}{}
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		keyPart, valuePart, hasValue := strings.Cut(part, "=")
		key := decodeQueryComponent(keyPart)
		value := ""
		if hasValue {
			value = decodeQueryComponent(valuePart)
		}
		switch key {
		case "start":
			query.start.add(value)
		case "end":
			query.end.add(value)
		case "warMapStart":
			query.warMapStart.add(value)
		case "warMapEnd":
			query.warMapEnd.add(value)
		case "warMapTranslate":
			query.warMapTranslate.add(value)
		case "warMapBbox":
			query.warMapBbox.add(value)
		case "warMapZoom":
			query.warMapZoom.add(value)
		case "warMapFlightMode":
			query.warMapFlightMode.add(value)
		case "warMapAisMode":
			query.warMapAisMode.add(value)
		default:
			if key == "" {
				continue
			}
			if _, ok := seenUnknown[key]; ok {
				continue
			}
			seenUnknown[key] = struct{}{}
			query.unknown = append(query.unknown, key)
		}
	}
	return query
}

func decodeQueryComponent(value string) string {
	decoded, err := url.QueryUnescape(strings.ReplaceAll(value, "+", " "))
	if err != nil {
		return value
	}
	return decoded
}

func (q streamQuery) validation() string {
	var parts []string
	addISO := func(name string, field stringField) {
		if !field.set {
			return
		}
		if field.multi || !dashboardcharts.ISO8601(field.value) {
			parts = append(parts, name+" must be a valid ISO 8601 date string")
		}
	}
	addString := func(name string, field stringField) {
		if field.multi {
			parts = append(parts, name+" must be a string")
		}
	}
	addISO("start", q.start)
	addISO("end", q.end)
	addISO("warMapStart", q.warMapStart)
	addISO("warMapEnd", q.warMapEnd)
	addString("warMapTranslate", q.warMapTranslate)
	addString("warMapBbox", q.warMapBbox)
	addString("warMapZoom", q.warMapZoom)
	addString("warMapFlightMode", q.warMapFlightMode)
	addString("warMapAisMode", q.warMapAisMode)
	for _, key := range q.unknown {
		parts = append(parts, "property "+key+" should not exist")
	}
	return strings.Join(parts, "; ")
}
