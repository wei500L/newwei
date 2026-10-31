package crawltables

import (
	"encoding/json"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// mustNormalize normalizes the given top-level and media raw payloads.
func mustNormalize(t *testing.T, top, media string) []Table {
	t.Helper()
	var topRaw, mediaRaw json.RawMessage
	if top != "" {
		topRaw = json.RawMessage(top)
	}
	if media != "" {
		mediaRaw = json.RawMessage(media)
	}
	tables, err := NormalizeFromArticle(topRaw, mediaRaw)
	if err != nil {
		t.Fatalf("NormalizeFromArticle: %v", err)
	}
	return tables
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

// TestNormalizeFromArticleOrdersTopAndMediaTables proves the top-level `tables`
// array is emitted before `media.tables`, and that a media array is extracted
// even when the table payload is the only thing media carries.
func TestNormalizeFromArticleOrdersTopAndMediaTables(t *testing.T) {
	tables := mustNormalize(t,
		`[{"headers":["Name","Price"],"rows":[[" Alice ","1"],[true,2.5]]}]`,
		`{"images":[{"src":"https://example.com/a.png"}],"tables":[{"headers":["A","A"],"rows":[["x"]]}]}`,
	)
	if len(tables) != 2 {
		t.Fatalf("tables = %d, want 2", len(tables))
	}
	first := tables[0]
	if first.ID != "table-1" || len(first.Headers) != 2 || first.Headers[0] != "Name" || first.RowCount != 2 || first.ColumnCount != 2 {
		t.Fatalf("first table = %s", mustJSON(t, first))
	}
	// Cells keep their raw value: only headers are trimmed, never cells.
	if string(first.Rows[0][0]) != `" Alice "` || string(first.Rows[0][1]) != `"1"` {
		t.Fatalf("first row = %s", mustJSON(t, first.Rows[0]))
	}
	if string(first.Rows[1][0]) != `true` || string(first.Rows[1][1]) != `2.5` {
		t.Fatalf("second row = %s", mustJSON(t, first.Rows[1]))
	}
	second := tables[1]
	if second.ID != "table-2" {
		t.Fatalf("second id = %q", second.ID)
	}
	// Duplicate headers get the historical numeric suffix.
	if len(second.Headers) != 2 || second.Headers[0] != "A" || second.Headers[1] != "A_1" {
		t.Fatalf("second headers = %#v", second.Headers)
	}
	if second.DataFrame.Columns[0] != "A" || second.DataFrame.Columns[1] != "A_1" {
		t.Fatalf("second dataFrame columns = %#v", second.DataFrame.Columns)
	}
}

// TestNormalizeDataRecordsKeepsInputColumnOrder proves the object-record `data`
// form infers columns from the input order (never Go map order), pads ragged
// rows with null and reports the real dimensions.
func TestNormalizeDataRecordsKeepsInputColumnOrder(t *testing.T) {
	tables := mustNormalize(t, `[{"data":[{"b":1,"a":2},{"a":3,"c":true}]}]`, "")
	if len(tables) != 1 {
		t.Fatalf("tables = %d", len(tables))
	}
	table := tables[0]
	if strings.Join(table.Headers, ",") != "b,a,c" {
		t.Fatalf("headers = %#v", table.Headers)
	}
	if table.RowCount != 2 || table.ColumnCount != 3 {
		t.Fatalf("dimensions = %d x %d", table.RowCount, table.ColumnCount)
	}
	if got := mustJSON(t, table.Rows); got != `[[1,2,null],[null,3,true]]` {
		t.Fatalf("rows = %s", got)
	}
	if got := mustJSON(t, table.DataFrame.Rows); got != `[{"a":2,"b":1,"c":null},{"a":3,"b":null,"c":true}]` {
		t.Fatalf("dataFrame rows = %s", got)
	}
}

// TestNormalizeRowsTakePrecedenceOverData proves a present `rows` array wins
// even when empty (the table is dropped) or when `data` is also present.
func TestNormalizeRowsTakePrecedenceOverData(t *testing.T) {
	if tables := mustNormalize(t, `[{"rows":[],"data":[{"a":1}]}]`, ""); len(tables) != 0 {
		t.Fatalf("empty rows array must drop the table, got %s", mustJSON(t, tables))
	}
	tables := mustNormalize(t, `[{"rows":[["x"]],"data":[{"a":1}]}]`, "")
	if len(tables) != 1 {
		t.Fatalf("tables = %d", len(tables))
	}
	if strings.Join(tables[0].Headers, ",") != "column_1" || string(tables[0].Rows[0][0]) != `"x"` {
		t.Fatalf("table = %s", mustJSON(t, tables[0]))
	}
}

// TestNormalizeHeadersDefaultsAndConflicts pins trim, empty filtering, inferred
// fallback, default column names and conflict suffixes.
func TestNormalizeHeadersDefaultsAndConflicts(t *testing.T) {
	dup := mustNormalize(t, `[{"headers":["  ","a","a",""],"rows":[["1","2","3","4"]]}]`, "")
	if len(dup) != 1 || strings.Join(dup[0].Headers, ",") != "a,a_1" {
		t.Fatalf("duplicate headers = %s", mustJSON(t, dup))
	}
	if got := mustJSON(t, dup[0].Rows); got != `[["1","2"]]` {
		t.Fatalf("aligned rows = %s", got)
	}

	fallback := mustNormalize(t, `[{"rows":[["x","y"]]}]`, "")
	if strings.Join(fallback[0].Headers, ",") != "column_1,column_2" {
		t.Fatalf("fallback headers = %#v", fallback[0].Headers)
	}

	single := mustNormalize(t, `[{"headers":[],"rows":[["x"]]}]`, "")
	if strings.Join(single[0].Headers, ",") != "column_1" {
		t.Fatalf("single fallback = %#v", single[0].Headers)
	}

	longHeader := strings.Repeat("h", 80)
	truncated := mustNormalize(t, `[{"headers":["`+longHeader+`"],"rows":[["x"]]}]`, "")
	if len(truncated[0].Headers[0]) != 64 {
		t.Fatalf("header length = %d, want 64", len(truncated[0].Headers[0]))
	}
}

// TestNormalizeCellsPreserveScalarsAndStringifyStructures pins the scalar/null
// cell contract and the object/array stringification of the original helper.
func TestNormalizeCellsPreserveScalarsAndStringifyStructures(t *testing.T) {
	tables := mustNormalize(t,
		`[{"headers":["s","i","f","b","n","o","a"],"rows":[["s",1,2.5,true,null,{"k":1},[1,2]]]}]`, "")
	if len(tables) != 1 {
		t.Fatalf("tables = %d", len(tables))
	}
	got := mustJSON(t, tables[0].Rows[0])
	want := `["s",1,2.5,true,null,"{\"k\":1}","[1,2]"]`
	if got != want {
		t.Fatalf("row = %s, want %s", got, want)
	}
}

// TestNormalizeInvalidAndEmptyPayloads pins the null/empty contract: no table
// means nil, never an empty array or a fabricated row.
func TestNormalizeInvalidAndEmptyPayloads(t *testing.T) {
	if tables := mustNormalize(t, "", ""); tables != nil {
		t.Fatalf("empty payload = %#v", tables)
	}
	if tables := mustNormalize(t, `[1,2,"x",null]`, ""); tables != nil {
		t.Fatalf("non-object entries = %#v", tables)
	}
	if tables := mustNormalize(t, `[{"headers":["a"],"rows":[]}]`, ""); tables != nil {
		t.Fatalf("empty rows = %#v", tables)
	}
	if tables := mustNormalize(t, `[{"headers":["a"]}]`, ""); tables != nil {
		t.Fatalf("no rows/data = %#v", tables)
	}
}

// TestEncodeBSONRoundTripIsIdempotent proves the normalized tables survive a
// Mongo BSON round trip and that FromStored normalizes them idempotently
// (including the `source` and `metadata` fields that only exist on output).
func TestEncodeBSONRoundTripIsIdempotent(t *testing.T) {
	original := mustNormalize(t,
		`[{"id":"t-9","caption":"Prices","headers":["Name","Price"],"rows":[["a","1"],[true,2.5]],"source_xpath":"//table[1]","metadata":{"index":1,"nested":{"k":[1,2]}}}]`,
		"")
	documents, err := EncodeBSON(original)
	if err != nil {
		t.Fatalf("EncodeBSON: %v", err)
	}
	encoded, err := bson.Marshal(bson.D{{Key: "tables", Value: documents}})
	if err != nil {
		t.Fatalf("marshal bson: %v", err)
	}
	var decoded struct {
		Tables []StoredTable `bson:"tables"`
	}
	if err := bson.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal bson: %v", err)
	}
	if len(decoded.Tables) != 1 {
		t.Fatalf("decoded tables = %d", len(decoded.Tables))
	}
	roundTripped := FromStored(decoded.Tables)
	if got, want := mustJSON(t, roundTripped), mustJSON(t, original); got != want {
		t.Fatalf("round trip mismatch:\n got=%s\nwant=%s", got, want)
	}
	if roundTripped[0].Source == nil || *roundTripped[0].Source != "//table[1]" {
		t.Fatalf("source lost: %#v", roundTripped[0].Source)
	}
	if string(roundTripped[0].Metadata) != `{"index":1,"nested":{"k":[1,2]}}` {
		t.Fatalf("metadata = %s", roundTripped[0].Metadata)
	}
}

// TestFromStoredUpgradesLegacyRawRows proves a document written before
// normalization (a raw crawl4ai `{headers,rows}` entry with no rowCount or
// dataFrame) is upgraded on read with the same rules.
func TestFromStoredUpgradesLegacyRawRows(t *testing.T) {
	legacy := []StoredTable{{
		Headers: []Cell{Cell(`"Name"`), Cell(`"Price"`)},
		Rows: [][]Cell{
			{Cell(`"a"`), Cell(`"1"`)},
			{Cell(`"b"`), Cell(`"2"`)},
		},
	}}
	tables := FromStored(legacy)
	if len(tables) != 1 {
		t.Fatalf("tables = %d", len(tables))
	}
	table := tables[0]
	if table.ID != "table-1" || table.RowCount != 2 || table.ColumnCount != 2 {
		t.Fatalf("table = %s", mustJSON(t, table))
	}
	if strings.Join(table.Headers, ",") != "Name,Price" {
		t.Fatalf("headers = %#v", table.Headers)
	}
	if got := mustJSON(t, table.DataFrame.Rows); got != `[{"Name":"a","Price":"1"},{"Name":"b","Price":"2"}]` {
		t.Fatalf("dataFrame = %s", got)
	}
}

// TestFromStoredUpgradesLegacyRawData proves a legacy raw object-record `data`
// entry (stored through a Go map, so deterministically sorted on read) is also
// upgraded.
func TestFromStoredUpgradesLegacyRawData(t *testing.T) {
	legacy := []StoredTable{{
		Data: []Record{
			{"a": Cell(`1`), "b": Cell(`2`)},
			{"a": Cell(`3`)},
		},
	}}
	tables := FromStored(legacy)
	if len(tables) != 1 {
		t.Fatalf("tables = %d", len(tables))
	}
	if strings.Join(tables[0].Headers, ",") != "a,b" {
		t.Fatalf("headers = %#v", tables[0].Headers)
	}
	if got := mustJSON(t, tables[0].Rows); got != `[[1,2],[3,null]]` {
		t.Fatalf("rows = %s", got)
	}
}

// TestFromStoredNil checks the empty contract.
func TestFromStoredNil(t *testing.T) {
	if tables := FromStored(nil); tables != nil {
		t.Fatalf("nil = %#v", tables)
	}
	if tables := FromStored([]StoredTable{}); tables != nil {
		t.Fatalf("empty = %#v", tables)
	}
}
