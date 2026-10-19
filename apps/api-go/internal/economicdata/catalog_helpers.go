package economicdata

// MainlineRole mirrors FinancialDataMainlineRole.
type MainlineRole string

const (
	Canonical MainlineRole = "canonical"
	Derived   MainlineRole = "derived"
	Internal  MainlineRole = "internal"
	Fallback  MainlineRole = "fallback"
)

func field(name, label, unit string, dataType ValueType) DataField {
	return DataField{Field: name, Label: label, Unit: unit, DataType: dataType}
}

func latestParser(timestampField string, fields ...DataField) ParserConfig {
	return ParserConfig{Type: ParserLatest, TimestampField: timestampField, ValueFields: fields}
}

func timeseriesParser(timestampField, timestampFormat string, fields ...DataField) ParserConfig {
	return ParserConfig{Type: ParserTimeseries, TimestampField: timestampField, TimestampFormat: timestampFormat, ValueFields: fields}
}

func macroParser(periodField, categoryField string, fields ...DataField) ParserConfig {
	return ParserConfig{Type: ParserMacro, PeriodField: periodField, CategoryField: categoryField, ValueFields: fields}
}

func yearMonthParser(yearField, monthField, dayField, categoryField string, fields ...DataField) ParserConfig {
	return ParserConfig{Type: ParserYearMonth, YearField: yearField, MonthField: monthField, DayField: dayField, CategoryField: categoryField, ValueFields: fields}
}

func yieldCurveParser(dateField string, fields ...DataField) ParserConfig {
	return ParserConfig{Type: ParserYieldCurve, DateField: dateField, SeriesFields: fields}
}

func newAkshareDefinition(
	id, slug, displayName, description string,
	categories []string,
	sourceFunction, endpoint, docURL, method string,
	valueType ValueType,
	defaultUnit string,
	defaultFrequency Frequency,
	parser ParserConfig,
	defaultParams map[string]string,
	filter *PayloadFilter,
	tags []string,
) Definition {
	return Definition{
		ID:               id,
		Slug:             slug,
		DisplayName:      displayName,
		Description:      description,
		Categories:       categories,
		SourceFunction:   sourceFunction,
		Endpoint:         endpoint,
		DocURL:           docURL,
		ValueType:        valueType,
		DefaultUnit:      defaultUnit,
		DefaultFrequency: defaultFrequency,
		ProviderKind:     ProviderAkshare,
		ProviderConfig: ProviderConfig{
			Kind:          ProviderAkshare,
			FunctionName:  sourceFunction,
			Endpoint:      endpoint,
			DocURL:        docURL,
			Method:        method,
			DefaultParams: defaultParams,
			Filter:        filter,
			Parser:        &parser,
		},
		DefaultEnabled: true,
		MainlineRole:   string(Canonical),
		Tags:           tags,
	}
}

func newFinnhubDefinition(
	id, slug, displayName, description string,
	categories []string,
	symbol, sourceField string,
	valueType ValueType,
	defaultUnit string,
	defaultFrequency Frequency,
	role MainlineRole,
	snapshot *Snapshot,
	tags []string,
) Definition {
	return Definition{
		ID:               id,
		Slug:             slug,
		DisplayName:      displayName,
		Description:      description,
		Categories:       categories,
		SourceFunction:   "finnhub.quote",
		Endpoint:         "/quote",
		DocURL:           "https://finnhub.io/docs/api/quote",
		ValueType:        valueType,
		DefaultUnit:      defaultUnit,
		DefaultFrequency: defaultFrequency,
		ProviderKind:     ProviderFinnhub,
		ProviderConfig: ProviderConfig{
			Kind:        ProviderFinnhub,
			Symbol:      symbol,
			Endpoint:    "/quote",
			DocURL:      "https://finnhub.io/docs/api/quote",
			Metric:      "quote_price",
			SourceField: sourceField,
		},
		RequiresSecret: "finnhubApiKey",
		DefaultEnabled: false,
		MainlineRole:   string(role),
		Snapshot:       snapshot,
		Tags:           tags,
	}
}

func newFredDefinition(
	id, slug, displayName, description string,
	categories []string,
	sourceFunction, seriesID, metric string,
	valueType ValueType,
	defaultUnit string,
	defaultFrequency Frequency,
	role MainlineRole,
	snapshot *Snapshot,
	lookback, precision int,
	transform string,
	tags []string,
) Definition {
	config := ProviderConfig{
		Kind:        ProviderFred,
		SeriesID:    seriesID,
		Endpoint:    "/series/observations",
		DocURL:      "https://fred.stlouisfed.org/docs/api/fred/series_observations.html",
		Metric:      metric,
		SourceField: "value",
		Lookback:    lookback,
		Precision:   precision,
		Transform:   transform,
	}
	return Definition{
		ID:               id,
		Slug:             slug,
		DisplayName:      displayName,
		Description:      description,
		Categories:       categories,
		SourceFunction:   sourceFunction,
		Endpoint:         "/series/observations",
		DocURL:           "https://fred.stlouisfed.org/docs/api/fred/series_observations.html",
		ValueType:        valueType,
		DefaultUnit:      defaultUnit,
		DefaultFrequency: defaultFrequency,
		ProviderKind:     ProviderFred,
		ProviderConfig:   config,
		RequiresSecret:   "fredApiKey",
		DefaultEnabled:   false,
		MainlineRole:     string(role),
		Snapshot:         snapshot,
		Tags:             tags,
	}
}

func newYfinanceDefinition(
	id, slug, displayName, description string,
	categories []string,
	symbol string,
	valueType ValueType,
	defaultUnit string,
	defaultFrequency Frequency,
	role MainlineRole,
	snapshot *Snapshot,
	period1 int64,
	tags []string,
) Definition {
	includePrePost := false
	period2 := Period2{Now: true}
	sourceFields := &YahooSourceFields{Open: "open", High: "high", Low: "low", Close: "close"}
	return Definition{
		ID:               id,
		Slug:             slug,
		DisplayName:      displayName,
		Description:      description,
		Categories:       categories,
		SourceFunction:   "yfinance.history",
		Endpoint:         "/v8/finance/chart",
		DocURL:           "https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.history.html",
		ValueType:        valueType,
		DefaultUnit:      defaultUnit,
		DefaultFrequency: defaultFrequency,
		ProviderKind:     ProviderYfinance,
		ProviderConfig: ProviderConfig{
			Kind:           ProviderYfinance,
			Symbol:         symbol,
			Endpoint:       "/v8/finance/chart",
			DocURL:         "https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.history.html",
			Interval:       "1d",
			Period1:        &period1,
			Period2:        &period2,
			IncludePrePost: &includePrePost,
			Events:         "div,splits",
			SourceFields:   sourceFields,
		},
		DefaultEnabled: true,
		MainlineRole:   string(role),
		Snapshot:       snapshot,
		Tags:           tags,
	}
}

func boolPtr(value bool) *bool       { return &value }
func stringPtr(value string) *string { return &value }
