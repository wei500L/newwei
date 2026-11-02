// Package crawltables normalizes crawl4ai table payloads into the
// CrawlResultContent `tables` shape shared by the crawlexecution writer and the
// crawlreadtelemetry read model.
//
// The normalization is a faithful port of CrawlResultService's
// normalizeTablesFromResult / normalizeTablePayload helpers from the retired
// NestJS backend (apps/api/src/modules/crawl/crawl-result.service.ts at
// e72440e1). Keeping the rules in one package avoids making the read handler
// package a DTO dependency of the write layer: crawlexecution encodes tables
// with EncodeBSON and crawlreadtelemetry decodes them back with FromStored.
//
// A table is produced from either the top-level `tables` array or the
// `media.tables` array of one crawl4ai result, in that order. A table with no
// usable rows is dropped, so an empty/invalid payload normalizes to nil, which
// the writer stores as JSON/BSON null (the NestJS `tables ?? null` contract).
package crawltables

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// RawJSON carries a schema-less JSON leaf (the table `metadata` object). It
// preserves the value verbatim so the reader can round-trip it without a
// field-by-field model.
type RawJSON []byte

// MarshalJSON renders the stored raw value; an empty value renders as JSON null.
func (r RawJSON) MarshalJSON() ([]byte, error) {
	if len(bytes.TrimSpace(r)) == 0 {
		return []byte("null"), nil
	}
	return r, nil
}

// UnmarshalJSON keeps the raw bytes so a JSON round trip never re-models the
// schema-less payload.
func (r *RawJSON) UnmarshalJSON(data []byte) error {
	*r = append((*r)[:0], data...)
	return nil
}

// UnmarshalBSONValue implements bson.ValueUnmarshaler: it re-encodes the raw
// BSON value as relaxed JSON so nested objects survive a Mongo projection.
func (r *RawJSON) UnmarshalBSONValue(valueType byte, data []byte) error {
	if bson.Type(valueType) == bson.TypeNull || bson.Type(valueType) == bson.TypeUndefined {
		*r = nil
		return nil
	}
	wrapped, err := bson.MarshalExtJSON(
		bson.D{{Key: "v", Value: bson.RawValue{Type: bson.Type(valueType), Value: data}}},
		false, false,
	)
	if err != nil {
		return err
	}
	colon := bytes.IndexByte(wrapped, ':')
	if colon < 0 || len(wrapped) < colon+2 || wrapped[len(wrapped)-1] != '}' {
		return fmt.Errorf("crawltables: unexpected extended JSON value %q", wrapped)
	}
	inner := bytes.TrimSpace(wrapped[colon+1 : len(wrapped)-1])
	encoded := make([]byte, len(inner))
	copy(encoded, inner)
	*r = encoded
	return nil
}

// Cell is one table cell preserving the scalar JSON type: string, number,
// boolean or null. Object and array inputs are stringified by the normalizer,
// so a stored Cell is always a scalar leaf or the quoted text of a structure.
type Cell RawJSON

// MarshalJSON renders the stored cell value.
func (c Cell) MarshalJSON() ([]byte, error) {
	return RawJSON(c).MarshalJSON()
}

// UnmarshalJSON keeps the raw cell bytes.
func (c *Cell) UnmarshalJSON(data []byte) error {
	*c = append((*c)[:0], data...)
	return nil
}

// UnmarshalBSONValue decodes a BSON cell into its relaxed JSON form.
func (c *Cell) UnmarshalBSONValue(valueType byte, data []byte) error {
	var raw RawJSON
	if err := raw.UnmarshalBSONValue(valueType, data); err != nil {
		return err
	}
	*c = Cell(raw)
	return nil
}

// Record is one data-frame row keyed by column name. It is a named record type
// rather than a general map so callers cannot smuggle arbitrary business data
// through an untyped container.
type Record map[string]Cell

// DataFrame is the tabular view of a crawled table. Columns preserves the header
// order so consumers never depend on map iteration order.
type DataFrame struct {
	Columns []string `json:"columns" bson:"columns"`
	Rows    []Record `json:"rows" bson:"rows"`
}

// Table mirrors the CrawlResultTable interface stored in Mongo. The JSON field
// order and tags are the protocol the web detail page and the GraphQL JSON
// scalar already expect.
type Table struct {
	ID          string    `json:"id" bson:"id"`
	Caption     *string   `json:"caption,omitempty" bson:"caption"`
	Headers     []string  `json:"headers" bson:"headers"`
	Rows        [][]Cell  `json:"rows" bson:"rows"`
	RowCount    int       `json:"rowCount" bson:"rowCount"`
	ColumnCount int       `json:"columnCount" bson:"columnCount"`
	Source      *string   `json:"source,omitempty" bson:"source"`
	Metadata    RawJSON   `json:"metadata,omitempty" bson:"metadata"`
	DataFrame   DataFrame `json:"dataFrame" bson:"dataFrame"`
}

// StoredTable is the BSON projection of one CrawlResultContent.tables element.
// It keeps the legacy raw crawl4ai columns (`rows`, `data`, `source_xpath`) in
// addition to the normalized ones, so a document written before normalization
// can be upgraded on read without rewriting Mongo.
type StoredTable struct {
	ID               Cell      `bson:"id"`
	Caption          Cell      `bson:"caption"`
	Headers          []Cell    `bson:"headers"`
	Rows             [][]Cell  `bson:"rows"`
	Data             []Record  `bson:"data"`
	RowCount         int       `bson:"rowCount"`
	ColumnCount      int       `bson:"columnCount"`
	Source           Cell      `bson:"source"`
	SourceXPath      Cell      `bson:"source_xpath"`
	SourceXPathCamel Cell      `bson:"sourceXPath"`
	Metadata         RawJSON   `bson:"metadata"`
	DataFrame        DataFrame `bson:"dataFrame"`
}

// rowField is one ordered key/value pair of an object-record `data` row.
type rowField struct {
	Key   string
	Value Cell
}

// tableInput is the shared intermediate the JSON (write) and BSON (read) paths
// feed into the same normalization rules.
type tableInput struct {
	id               string
	idSet            bool
	caption          Cell
	headers          []Cell
	rows             [][]Cell
	rowsIsArray      bool
	data             [][]rowField
	dataIsArray      bool
	sourceXPath      Cell
	sourceXPathCamel Cell
	metadata         RawJSON
}

// rawTablePayload is the JSON shape of one crawl4ai table entry. Every leaf is
// kept raw because a crawl4ai table mixes optional strings, arrays and objects.
type rawTablePayload struct {
	ID               json.RawMessage `json:"id"`
	Caption          json.RawMessage `json:"caption"`
	Headers          json.RawMessage `json:"headers"`
	Rows             json.RawMessage `json:"rows"`
	Data             json.RawMessage `json:"data"`
	SourceXPath      json.RawMessage `json:"source_xpath"`
	SourceXPathCamel json.RawMessage `json:"sourceXPath"`
	Metadata         json.RawMessage `json:"metadata"`
}

// NormalizeFromArticle extracts and normalizes the top-level `tables` array and
// the nested `media.tables` array of one crawl4ai result, preserving that order.
// Media extraction is independent of binary media storage, so tables survive
// even when shouldStoreMedia is false. The result is nil when neither payload
// yields a usable table.
func NormalizeFromArticle(topTables, media json.RawMessage) ([]Table, error) {
	inputs, err := collectArticleTableInputs(topTables, media)
	if err != nil {
		return nil, err
	}
	return normalizeInputs(inputs)
}

// FromStored upgrades the stored tables of one CrawlResultContent document to
// the normalized shape. Newly written documents are already normalized and pass
// through unchanged (the rules are idempotent); legacy raw crawl4ai entries are
// normalized with the same rules. The result is nil when nothing is usable.
func FromStored(stored []StoredTable) []Table {
	if len(stored) == 0 {
		return nil
	}
	inputs := make([]tableInput, 0, len(stored))
	for _, entry := range stored {
		inputs = append(inputs, tableInputFromStored(entry))
	}
	tables := make([]Table, 0, len(inputs))
	for index := range inputs {
		table, err := normalizeInput(&inputs[index], index)
		if err != nil || table == nil {
			continue
		}
		tables = append(tables, *table)
	}
	if len(tables) == 0 {
		return nil
	}
	return tables
}

// EncodeBSON renders the normalized tables as Mongo documents in the exact key
// order the read model decodes. A nil/empty slice encodes as JSON/BSON null by
// the caller (it receives nil), matching the `tables ?? null` contract.
func EncodeBSON(tables []Table) ([]bson.D, error) {
	if len(tables) == 0 {
		return nil, nil
	}
	documents := make([]bson.D, 0, len(tables))
	for _, table := range tables {
		document, err := table.bsonDocument()
		if err != nil {
			return nil, err
		}
		documents = append(documents, document)
	}
	return documents, nil
}

// bsonDocument renders one table in the NestJS key order.
func (t Table) bsonDocument() (bson.D, error) {
	document := bson.D{{Key: "id", Value: t.ID}}
	if t.Caption != nil {
		document = append(document, bson.E{Key: "caption", Value: *t.Caption})
	}
	document = append(document, bson.E{Key: "headers", Value: stringArrayValue(t.Headers)})
	rows := make(bson.A, 0, len(t.Rows))
	for _, row := range t.Rows {
		encodedRow := make(bson.A, 0, len(row))
		for _, cell := range row {
			value, err := decodeJSONValue(json.RawMessage(cell))
			if err != nil {
				return nil, err
			}
			encodedRow = append(encodedRow, value)
		}
		rows = append(rows, encodedRow)
	}
	document = append(document, bson.E{Key: "rows", Value: rows})
	document = append(document, bson.E{Key: "rowCount", Value: int32(t.RowCount)})
	document = append(document, bson.E{Key: "columnCount", Value: int32(t.ColumnCount)})
	if t.Source != nil {
		document = append(document, bson.E{Key: "source", Value: *t.Source})
	}
	if len(bytes.TrimSpace(t.Metadata)) > 0 {
		metadata, err := decodeJSONValue(json.RawMessage(t.Metadata))
		if err != nil {
			return nil, err
		}
		document = append(document, bson.E{Key: "metadata", Value: metadata})
	}
	dataFrame := bson.D{{Key: "columns", Value: stringArrayValue(t.DataFrame.Columns)}}
	dataFrameRows := make(bson.A, 0, len(t.DataFrame.Rows))
	for _, record := range t.DataFrame.Rows {
		encodedRecord := bson.D{}
		for _, column := range t.DataFrame.Columns {
			value, ok := record[column]
			if !ok || isNullCell(value) {
				value = nullCell()
			}
			decoded, err := decodeJSONValue(json.RawMessage(value))
			if err != nil {
				return nil, err
			}
			encodedRecord = append(encodedRecord, bson.E{Key: column, Value: decoded})
		}
		dataFrameRows = append(dataFrameRows, encodedRecord)
	}
	dataFrame = append(dataFrame, bson.E{Key: "rows", Value: dataFrameRows})
	document = append(document, bson.E{Key: "dataFrame", Value: dataFrame})
	return document, nil
}

// collectArticleTableInputs parses the top-level and media table arrays into the
// shared intermediate. Entries that are not JSON objects are dropped, exactly
// like the `entry && typeof entry === "object"` filter in the original helper.
func collectArticleTableInputs(topTables, media json.RawMessage) ([]tableInput, error) {
	inputs := make([]tableInput, 0, 4)
	top := bytes.TrimSpace(topTables)
	if isJSONArray(top) {
		var entries []json.RawMessage
		if err := json.Unmarshal(top, &entries); err != nil {
			return nil, fmt.Errorf("crawltables: decode tables array: %w", err)
		}
		for _, entry := range entries {
			input, keep, err := parseTableInput(entry)
			if err != nil {
				return nil, err
			}
			if keep {
				inputs = append(inputs, input)
			}
		}
	}
	mediaObject := bytes.TrimSpace(media)
	if len(mediaObject) > 0 && mediaObject[0] == '{' {
		var payload struct {
			Tables json.RawMessage `json:"tables"`
		}
		if err := json.Unmarshal(mediaObject, &payload); err != nil {
			return nil, fmt.Errorf("crawltables: decode media payload: %w", err)
		}
		if isJSONArray(bytes.TrimSpace(payload.Tables)) {
			var entries []json.RawMessage
			if err := json.Unmarshal(payload.Tables, &entries); err != nil {
				return nil, fmt.Errorf("crawltables: decode media.tables array: %w", err)
			}
			for _, entry := range entries {
				input, keep, err := parseTableInput(entry)
				if err != nil {
					return nil, err
				}
				if keep {
					inputs = append(inputs, input)
				}
			}
		}
	}
	return inputs, nil
}

// parseTableInput parses one raw JSON table entry. keep is false for a value
// that is not a JSON object (null, string, number, array), which the original
// normalizer dropped.
func parseTableInput(raw json.RawMessage) (tableInput, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return tableInput{}, false, nil
	}
	var payload rawTablePayload
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return tableInput{}, false, fmt.Errorf("crawltables: decode table payload: %w", err)
	}
	input := tableInput{
		caption:          Cell(payload.Caption),
		headers:          parseHeaderCells(payload.Headers),
		sourceXPath:      Cell(payload.SourceXPath),
		sourceXPathCamel: Cell(payload.SourceXPathCamel),
		metadata:         RawJSON(payload.Metadata),
	}
	if id := resolveScalarString(payload.ID); id != nil {
		input.id = *id
		input.idSet = true
	}
	rows, rowsIsArray, err := parseRows(payload.Rows)
	if err != nil {
		return tableInput{}, false, err
	}
	input.rows = rows
	input.rowsIsArray = rowsIsArray
	data, dataIsArray, err := parseDataRecords(payload.Data)
	if err != nil {
		return tableInput{}, false, err
	}
	input.data = data
	input.dataIsArray = dataIsArray
	return input, true, nil
}

// tableInputFromStored maps one stored table back to the shared intermediate.
// The normalized `source` is fed back through the legacy source_xpath slot so a
// normalized entry normalizes idempotently.
func tableInputFromStored(stored StoredTable) tableInput {
	input := tableInput{
		caption:          stored.Caption,
		headers:          stored.Headers,
		rows:             stored.Rows,
		rowsIsArray:      stored.Rows != nil,
		sourceXPath:      stored.Source,
		sourceXPathCamel: stored.SourceXPathCamel,
		metadata:         stored.Metadata,
	}
	if isNullCell(input.sourceXPath) {
		input.sourceXPath = stored.SourceXPath
	}
	if id := resolveScalarString(json.RawMessage(stored.ID)); id != nil {
		input.id = *id
		input.idSet = true
	}
	if stored.Data != nil {
		input.data = make([][]rowField, 0, len(stored.Data))
		for _, record := range stored.Data {
			keys := make([]string, 0, len(record))
			for key := range record {
				keys = append(keys, key)
			}
			// The legacy writer stored object records through a Go map, so their
			// original key order is already lost; sorting keeps the upgrade
			// deterministic instead of depending on map iteration order.
			sort.Strings(keys)
			fields := make([]rowField, 0, len(keys))
			for _, key := range keys {
				fields = append(fields, rowField{Key: key, Value: record[key]})
			}
			input.data = append(input.data, fields)
		}
		input.dataIsArray = true
	}
	return input
}

// normalizeInputs normalizes a batch and drops entries that yield no table.
func normalizeInputs(inputs []tableInput) ([]Table, error) {
	if len(inputs) == 0 {
		return nil, nil
	}
	tables := make([]Table, 0, len(inputs))
	for index := range inputs {
		table, err := normalizeInput(&inputs[index], index)
		if err != nil {
			return nil, err
		}
		if table != nil {
			tables = append(tables, *table)
		}
	}
	if len(tables) == 0 {
		return nil, nil
	}
	return tables, nil
}

// normalizeInput applies normalizeTablePayload to one table. It returns nil when
// the table has no usable rows.
func normalizeInput(input *tableInput, index int) (*Table, error) {
	rows, inferredHeaders, err := extractRows(input)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	headers := normalizeHeaders(input.headers, inferredHeaders, len(rows[0]))
	aligned := make([][]Cell, len(rows))
	for rowIndex, row := range rows {
		aligned[rowIndex] = alignRow(row, len(headers))
	}
	records := buildRecords(headers, aligned)
	metadata := normalizeMetadata(input.metadata)
	id := fmt.Sprintf("table-%d", index+1)
	if input.idSet {
		id = input.id
	}
	return &Table{
		ID:          id,
		Caption:     ensureString(input.caption),
		Headers:     headers,
		Rows:        aligned,
		RowCount:    len(aligned),
		ColumnCount: len(headers),
		Source:      resolveSource(input.sourceXPath, input.sourceXPathCamel, metadata),
		Metadata:    metadata,
		DataFrame:   DataFrame{Columns: headers, Rows: records},
	}, nil
}

// extractRows returns the row matrix and, for the object-record form, the
// inferred headers. A present `rows` array wins even when empty, matching the
// original `Array.isArray(table.rows)` short circuit.
func extractRows(input *tableInput) ([][]Cell, []string, error) {
	if input.rowsIsArray {
		rows := make([][]Cell, 0, len(input.rows))
		for _, row := range input.rows {
			normalized := make([]Cell, 0, len(row))
			for _, cell := range row {
				normalized = append(normalized, coerceCell(cell))
			}
			if len(normalized) > 0 {
				rows = append(rows, normalized)
			}
		}
		return rows, nil, nil
	}
	if input.dataIsArray {
		columns := collectColumns(input.data)
		if len(columns) == 0 {
			return nil, nil, nil
		}
		rows := make([][]Cell, 0, len(input.data))
		for _, record := range input.data {
			row := make([]Cell, 0, len(columns))
			for _, column := range columns {
				row = append(row, coerceCell(lookupField(record, column)))
			}
			rows = append(rows, row)
		}
		return rows, columns, nil
	}
	return nil, nil, nil
}

// collectColumns reproduces collectColumnsFromRecords: trimmed, de-duplicated,
// 64-rune-capped, and capped at 50 columns across records (checked per record).
func collectColumns(records [][]rowField) []string {
	columns := make([]string, 0, 8)
	for _, record := range records {
		for _, field := range record {
			trimmed := jsTrim(field.Key)
			if len(trimmed) == 0 {
				continue
			}
			if !containsString(columns, trimmed) {
				columns = append(columns, jsSliceUTF16(trimmed, 64))
			}
		}
		if len(columns) >= 50 {
			break
		}
	}
	return columns
}

// lookupField returns the value for the exact (already trimmed) column name.
func lookupField(record []rowField, column string) Cell {
	for _, field := range record {
		if field.Key == column {
			return field.Value
		}
	}
	return nil
}

// normalizeHeaders reproduces normalizeTableHeaders: trim/truncate, inferred
// fallback, column_N defaults and conflict suffixes.
func normalizeHeaders(headers []Cell, inferred []string, fallbackSize int) []string {
	fromHeaders := make([]string, 0, len(headers))
	for _, header := range headers {
		text := ""
		if value, ok := stringCell(header); ok {
			text = jsTrim(value)
		}
		if len(text) > 0 {
			fromHeaders = append(fromHeaders, jsSliceUTF16(text, 64))
		}
	}
	base := fromHeaders
	if len(base) == 0 && len(inferred) > 0 {
		base = inferred
	}
	if len(base) == 0 && fallbackSize > 0 {
		base = make([]string, 0, fallbackSize)
		for index := 0; index < fallbackSize; index++ {
			base = append(base, fmt.Sprintf("column_%d", index+1))
		}
	}
	if len(base) == 0 {
		base = []string{"column_1"}
	}
	seen := make(map[string]struct{}, len(base))
	normalized := make([]string, 0, len(base))
	for index, header := range base {
		safe := header
		if len(safe) == 0 {
			safe = fmt.Sprintf("column_%d", index+1)
		}
		candidate := safe
		suffix := 1
		for {
			if _, exists := seen[candidate]; !exists {
				break
			}
			candidate = fmt.Sprintf("%s_%d", safe, suffix)
			suffix++
		}
		seen[candidate] = struct{}{}
		normalized = append(normalized, candidate)
	}
	return normalized
}

// alignRow truncates or pads a row to size, padding with null.
func alignRow(row []Cell, size int) []Cell {
	next := make([]Cell, 0, size)
	if len(row) > size {
		next = append(next, row[:size]...)
	} else {
		next = append(next, row...)
	}
	for len(next) < size {
		next = append(next, nullCell())
	}
	return next
}

// buildRecords builds the data-frame records keyed by header name.
func buildRecords(headers []string, rows [][]Cell) []Record {
	records := make([]Record, 0, len(rows))
	for _, row := range rows {
		record := make(Record, len(headers))
		for index, header := range headers {
			cell := nullCell()
			if index < len(row) && !isNullCell(row[index]) {
				cell = row[index]
			}
			record[header] = cell
		}
		records = append(records, record)
	}
	return records
}

// coerceCell reproduces normalizeTableCell: null stays null, scalars are kept,
// and object/array values become their compact JSON text as a string.
func coerceCell(cell Cell) Cell {
	trimmed := bytes.TrimSpace(cell)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nullCell()
	}
	switch trimmed[0] {
	case '"':
		return Cell(trimmed)
	case 't', 'f':
		return Cell(trimmed)
	case '{', '[':
		compacted, err := compactJSON(trimmed)
		if err != nil {
			return Cell(`"[object]"`)
		}
		quoted, err := json.Marshal(string(compacted))
		if err != nil {
			return Cell(`"[object]"`)
		}
		return Cell(quoted)
	default:
		return Cell(trimmed)
	}
}

// normalizeMetadata keeps a metadata object verbatim (compact) and drops every
// non-object payload, matching normalizeTableMetadata.
func normalizeMetadata(raw RawJSON) RawJSON {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	compacted, err := compactJSON(trimmed)
	if err != nil {
		return nil
	}
	return RawJSON(compacted)
}

// resolveSource implements the `source_xpath ?? sourceXPath ??
// metadata.source_xpath` chain and then ensureString.
func resolveSource(sourceXPath, sourceXPathCamel Cell, metadata RawJSON) *string {
	if !isNullCell(sourceXPath) {
		return ensureString(sourceXPath)
	}
	if !isNullCell(sourceXPathCamel) {
		return ensureString(sourceXPathCamel)
	}
	if len(bytes.TrimSpace(metadata)) > 0 {
		var record map[string]json.RawMessage
		if err := json.Unmarshal(metadata, &record); err == nil {
			if value, ok := record["source_xpath"]; ok {
				return ensureString(Cell(value))
			}
		}
	}
	return nil
}

// ensureString mirrors ensureString: only a non-empty JSON string survives.
func ensureString(cell Cell) *string {
	if value, ok := stringCell(cell); ok && len(value) > 0 {
		return &value
	}
	return nil
}

// stringCell returns the cell as a Go string only when it is a JSON string.
func stringCell(cell Cell) (string, bool) {
	trimmed := bytes.TrimSpace(cell)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", false
	}
	return value, true
}

// resolveScalarString reproduces `value?.toString()` for the id leaf: strings,
// numbers and booleans stringify, while null/absent/objects yield nil.
func resolveScalarString(raw json.RawMessage) *string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	switch trimmed[0] {
	case '"':
		var value string
		if err := json.Unmarshal(trimmed, &value); err == nil {
			return &value
		}
	case 't':
		value := "true"
		return &value
	case 'f':
		value := "false"
		return &value
	default:
		var number json.Number
		if err := json.Unmarshal(trimmed, &number); err == nil {
			value := number.String()
			return &value
		}
	}
	return nil
}

// decodeJSONValue converts one JSON value to its BSON Go representation. It
// decodes with an ordered token stream so object key order and number types are
// preserved instead of being flattened through an untyped map.
func decodeJSONValue(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decodeJSONToken(decoder)
}

func decodeJSONToken(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch typed := token.(type) {
	case nil:
		return nil, nil
	case bool:
		return typed, nil
	case string:
		return typed, nil
	case json.Number:
		if integer, intErr := typed.Int64(); intErr == nil {
			if integer >= -2147483648 && integer <= 2147483647 {
				return int32(integer), nil
			}
			return integer, nil
		}
		return typed.Float64()
	case json.Delim:
		switch typed {
		case '{':
			document := bson.D{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, keyErr
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("crawltables: unexpected object key token %v", keyToken)
				}
				value, valueErr := decodeJSONToken(decoder)
				if valueErr != nil {
					return nil, valueErr
				}
				document = append(document, bson.E{Key: key, Value: value})
			}
			if _, closeErr := decoder.Token(); closeErr != nil {
				return nil, closeErr
			}
			return document, nil
		case '[':
			array := bson.A{}
			for decoder.More() {
				value, valueErr := decodeJSONToken(decoder)
				if valueErr != nil {
					return nil, valueErr
				}
				array = append(array, value)
			}
			if _, closeErr := decoder.Token(); closeErr != nil {
				return nil, closeErr
			}
			return array, nil
		}
	}
	return nil, fmt.Errorf("crawltables: unexpected JSON token %v", token)
}

// parseRows parses the `rows` leaf. A non-array value yields rowsIsArray=false.
func parseRows(raw json.RawMessage) ([][]Cell, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if !isJSONArray(trimmed) {
		return nil, false, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil, false, fmt.Errorf("crawltables: decode rows array: %w", err)
	}
	rows := make([][]Cell, 0, len(entries))
	for _, entry := range entries {
		trimmedEntry := bytes.TrimSpace(entry)
		if !isJSONArray(trimmedEntry) {
			rows = append(rows, nil)
			continue
		}
		var values []json.RawMessage
		if err := json.Unmarshal(trimmedEntry, &values); err != nil {
			return nil, false, fmt.Errorf("crawltables: decode row: %w", err)
		}
		row := make([]Cell, len(values))
		for index, value := range values {
			row[index] = Cell(value)
		}
		rows = append(rows, row)
	}
	return rows, true, nil
}

// parseHeaderCells parses the `headers` leaf into raw cells; a non-array value
// yields nil.
func parseHeaderCells(raw json.RawMessage) []Cell {
	trimmed := bytes.TrimSpace(raw)
	if !isJSONArray(trimmed) {
		return nil
	}
	var values []json.RawMessage
	if err := json.Unmarshal(trimmed, &values); err != nil {
		return nil
	}
	cells := make([]Cell, len(values))
	for index, value := range values {
		cells[index] = Cell(value)
	}
	return cells
}

// parseDataRecords parses the object-record `data` leaf preserving input key
// order, so column order never depends on Go map iteration.
func parseDataRecords(raw json.RawMessage) ([][]rowField, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if !isJSONArray(trimmed) {
		return nil, false, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil, false, fmt.Errorf("crawltables: decode data array: %w", err)
	}
	records := make([][]rowField, 0, len(entries))
	for _, entry := range entries {
		trimmedEntry := bytes.TrimSpace(entry)
		if len(trimmedEntry) == 0 || trimmedEntry[0] != '{' {
			records = append(records, nil)
			continue
		}
		fields, err := parseOrderedObject(trimmedEntry)
		if err != nil {
			return nil, false, err
		}
		records = append(records, fields)
	}
	return records, true, nil
}

// parseOrderedObject decodes a JSON object into ordered key/value pairs.
func parseOrderedObject(raw []byte) ([]rowField, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("crawltables: decode object: %w", err)
	}
	if delim, ok := opening.(json.Delim); !ok || delim != '{' {
		return nil, fmt.Errorf("crawltables: expected an object, got %v", opening)
	}
	fields := make([]rowField, 0, 8)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("crawltables: decode object key: %w", err)
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, fmt.Errorf("crawltables: unexpected object key %v", keyToken)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, fmt.Errorf("crawltables: decode object value: %w", err)
		}
		fields = append(fields, rowField{Key: key, Value: Cell(value)})
	}
	if _, err := decoder.Token(); err != nil {
		return nil, fmt.Errorf("crawltables: close object: %w", err)
	}
	return fields, nil
}

// --- small helpers -------------------------------------------------------

// isJSONArray reports whether raw is a JSON array.
func isJSONArray(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '['
}

// compactJSON strips insignificant whitespace from raw JSON, preserving order.
func compactJSON(raw []byte) ([]byte, error) {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// nullCell is the JSON null cell.
func nullCell() Cell { return Cell("null") }

// isNullCell reports whether a cell is absent or JSON null.
func isNullCell(cell Cell) bool {
	trimmed := bytes.TrimSpace(cell)
	return len(trimmed) == 0 || string(trimmed) == "null"
}

// stringArrayValue converts a []string to a BSON array; nil stays nil so an
// absent list is omitted rather than encoded as [].
func stringArrayValue(values []string) bson.A {
	if values == nil {
		return nil
	}
	array := make(bson.A, 0, len(values))
	for _, value := range values {
		array = append(array, value)
	}
	return array
}

// containsString reports whether values contains target.
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// jsTrim trims the ECMAScript WhiteSpace + LineTerminator set. Go's
// strings.TrimSpace additionally trims U+0085, which JavaScript keeps.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

// isJSWhitespace reports whether r is ECMAScript whitespace.
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsSliceUTF16 truncates to at most maxUnits UTF-16 code units, matching
// JavaScript String.prototype.slice on the header strings without splitting a
// Go rune.
func jsSliceUTF16(value string, maxUnits int) string {
	if maxUnits <= 0 {
		return ""
	}
	units := 0
	for index, r := range value {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width > maxUnits {
			return value[:index]
		}
		units += width
	}
	return value
}
