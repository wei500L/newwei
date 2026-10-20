package economicdata

import "testing"

func TestLatestRowMatchComparesExactDecimal(t *testing.T) {
	unit := "USD"
	row := upsertDataPointRow{value: "1.230000000000", unit: &unit, dataType: ValueTypePrice}
	existing := latestDataPointRow{value: "1.23", unit: &unit, dataType: "price"}
	if !latestRowMatches(existing, row) {
		t.Fatal("equal decimals did not match")
	}
	row.value = "1.230000000001"
	if latestRowMatches(existing, row) {
		t.Fatal("different decimals matched")
	}
}

func TestSkipUnchangedOnlyForConfiguredLatestSeries(t *testing.T) {
	service := &Service{env: Env{SkipUnchangedLatest: true}}
	frequency := FrequencyRealtime
	definition := &ItemConfig{
		ProviderKind:     ProviderAkshare,
		DefaultFrequency: frequency,
		ProviderConfig:   ProviderConfig{Parser: &ParserConfig{Type: ParserLatest}},
	}
	if !service.shouldSkipUnchangedLatestRows(definition) {
		t.Fatal("realtime akshare latest should be eligible")
	}
	definition.ProviderKind = ProviderYfinance
	if service.shouldSkipUnchangedLatestRows(definition) {
		t.Fatal("yfinance must not skip unchanged rows")
	}
	definition.ProviderKind = ProviderAkshare
	definition.ProviderConfig.Parser = &ParserConfig{Type: ParserLatest, TimestampField: "time"}
	if service.shouldSkipUnchangedLatestRows(definition) {
		t.Fatal("timestamped latest must not skip")
	}
	definition.ProviderConfig.Parser = &ParserConfig{Type: ParserLatest}
	definition.DefaultFrequency = FrequencyDaily
	if service.shouldSkipUnchangedLatestRows(definition) {
		t.Fatal("daily series must not skip")
	}
}

func TestUpsertQueryUsesUniqueKeyColumns(t *testing.T) {
	query, args, err := buildUpsertQuery("item-1", []upsertDataPointRow{{value: "1", dataType: ValueTypePrice, sourceField: "close"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 8 {
		t.Fatalf("args = %d", len(args))
	}
	for _, fragment := range []string{"ON DUPLICATE KEY UPDATE", "`value` = VALUES(`value`)", "`sourceMeta` = VALUES(`sourceMeta`)"} {
		if !contains(query, fragment) {
			t.Fatalf("query missing %q: %s", fragment, query)
		}
	}
}

func contains(haystack, needle string) bool {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}
