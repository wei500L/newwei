package analysisrunsgraphql

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/analysisruns"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// This file reproduces the reachable class-validator constraints of the three
// analysis input DTOs. GraphQL itself enforces the scalar/list/enum shapes; the
// checks here cover what the SDL cannot express: bbox length, transportKinds
// length, finite numbers and string array element types. Constraint messages
// use class-validator's default wording and are joined with "; " like the
// global exception filter.
//
// The DTOs deliberately have no non-empty, ISO-date, array-size or text-length
// constraint beyond the ones reproduced below. In particular the geographic
// dates are arbitrary strings at submission time; invalid dates fail later in
// the worker and become a failed run, not a submission-time 400.

func inputObject(args map[string]any) (map[string]any, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		return nil, inputFailure([]string{"input must be an object"})
	}
	return raw, nil
}

type inputFailureError struct{ message string }

func (e *inputFailureError) Error() string { return e.message }

func inputFailure(messages []string) error {
	return &inputFailureError{message: strings.Join(messages, "; ")}
}

func graphqlFailure(err error) error {
	if err == nil {
		return nil
	}
	var input *inputFailureError
	if errors.As(err, &input) {
		return &contract.Failure{Message: input.message, Status: http.StatusBadRequest}
	}
	return err
}

func requiredString(input map[string]any, name string, messages *[]string) string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, name+" must be a string")
		return ""
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, name+" must be a string")
		return ""
	}
	return text
}

func requiredFloat(input map[string]any, name string, messages *[]string) float64 {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, name+" must be a number conforming to the specified constraints")
		return 0
	}
	number, ok := contract.AsFloat(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		*messages = append(*messages, name+" must be a number conforming to the specified constraints")
		return 0
	}
	return number
}

func requiredStringList(input map[string]any, name string, messages *[]string) []string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		*messages = append(*messages, name+" must be an array")
		return nil
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, name+" must be an array")
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			*messages = append(*messages, "each value in "+name+" must be a string")
			continue
		}
		out = append(out, text)
	}
	return out
}

// optionalStringList distinguishes absent/null (nil, false) from a present list
// (possibly empty).
func optionalStringList(input map[string]any, name string, messages *[]string) ([]string, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing || state == contract.ArgNull {
		return nil, false
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, name+" must be an array")
		return nil, true
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			*messages = append(*messages, "each value in "+name+" must be a string")
			continue
		}
		out = append(out, text)
	}
	return out, true
}

// optionalFloatList reproduces @IsArray + @ArrayMinSize + @ArrayMaxSize +
// @IsNumber({each:true}) for bbox. Absent and explicit null are both allowed by
// @IsOptional.
func optionalFloatList(input map[string]any, name string, minSize, maxSize int, messages *[]string) ([]float64, bool) {
	value, state := contract.Lookup(input, name)
	if state == contract.ArgMissing || state == contract.ArgNull {
		return nil, false
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, name+" must be an array")
		return nil, true
	}
	if len(items) < minSize {
		*messages = append(*messages, fmt.Sprintf("%s must contain at least %d elements", name, minSize))
	}
	if len(items) > maxSize {
		*messages = append(*messages, fmt.Sprintf("%s must contain not more than %d elements", name, maxSize))
	}
	out := make([]float64, 0, len(items))
	for _, item := range items {
		number, ok := contract.AsFloat(item)
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
			*messages = append(*messages, "each value in "+name+" must be a number conforming to the specified constraints")
			continue
		}
		out = append(out, number)
	}
	return out, true
}

func parseCorrelationInput(args map[string]any) (analysisruns.CorrelationInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return analysisruns.CorrelationInput{}, err
	}
	messages := []string{}
	input := analysisruns.CorrelationInput{
		IndicatorName: requiredString(raw, "indicatorName", &messages),
		Value:         requiredFloat(raw, "value", &messages),
		ChangePercent: requiredFloat(raw, "changePercent", &messages),
		StartDate:     requiredString(raw, "startDate", &messages),
		EndDate:       requiredString(raw, "endDate", &messages),
		NewsSummaries: requiredStringList(raw, "newsSummaries", &messages),
	}
	if len(messages) > 0 {
		return analysisruns.CorrelationInput{}, inputFailure(messages)
	}
	return input, nil
}

func parseAnomalyInput(args map[string]any) (analysisruns.AnomalyInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return analysisruns.AnomalyInput{}, err
	}
	messages := []string{}
	input := analysisruns.AnomalyInput{
		Metric:           requiredString(raw, "metric", &messages),
		Timestamp:        requiredString(raw, "timestamp", &messages),
		Value:            requiredFloat(raw, "value", &messages),
		DeviationPercent: requiredFloat(raw, "deviationPercent", &messages),
		NewsList:         requiredStringList(raw, "newsList", &messages),
		PolicyList:       requiredStringList(raw, "policyList", &messages),
	}
	series, seriesSet := parseSeries(raw, &messages)
	if seriesSet {
		input.Series = series
	}
	if len(messages) > 0 {
		return analysisruns.AnomalyInput{}, inputFailure(messages)
	}
	return input, nil
}

// parseSeries returns a pointer for a configured series. An explicit null is a
// pointer to a nil slice so the persisted document keeps `"series": null`
// instead of dropping the property.
func parseSeries(raw map[string]any, messages *[]string) (*[]analysisruns.SeriesPoint, bool) {
	value, state := contract.Lookup(raw, "series")
	if state == contract.ArgMissing {
		return nil, false
	}
	if state == contract.ArgNull {
		var empty []analysisruns.SeriesPoint
		return &empty, true
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, "series must be an array")
		var empty []analysisruns.SeriesPoint
		return &empty, true
	}
	points := make([]analysisruns.SeriesPoint, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			*messages = append(*messages, "each value in series must be an object")
			continue
		}
		points = append(points, analysisruns.SeriesPoint{
			Timestamp: requiredString(entry, "timestamp", messages),
			Value:     requiredFloat(entry, "value", messages),
		})
	}
	return &points, true
}

func parseGeoTransportInput(args map[string]any) (analysisruns.GeoTransportInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return analysisruns.GeoTransportInput{}, err
	}
	messages := []string{}
	transportKinds := requiredTransportKinds(raw, &messages)
	input := analysisruns.GeoTransportInput{
		TransportKinds: transportKinds,
		StartDate:      requiredString(raw, "startDate", &messages),
		EndDate:        requiredString(raw, "endDate", &messages),
	}
	bbox, bboxSet := optionalFloatList(raw, "bbox", 4, 4, &messages)
	// The resolver passes only a length-4 bbox to the service.
	if bboxSet && len(bbox) == 4 {
		input.Bbox = bbox
	}
	objectKeys, objectKeysSet := optionalStringList(raw, "objectKeys", &messages)
	// A missing, null or empty objectKeys list is not an extra filter.
	if objectKeysSet && len(objectKeys) > 0 {
		input.ObjectKeys = objectKeys
	}
	if len(messages) > 0 {
		return analysisruns.GeoTransportInput{}, inputFailure(messages)
	}
	return input, nil
}

func requiredTransportKinds(raw map[string]any, messages *[]string) []string {
	value, state := contract.Lookup(raw, "transportKinds")
	if state != contract.ArgValue {
		*messages = append(*messages, "transportKinds must be an array")
		return nil
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, "transportKinds must be an array")
		return nil
	}
	if len(items) < 1 {
		*messages = append(*messages, "transportKinds must contain at least 1 elements")
	}
	if len(items) > 2 {
		*messages = append(*messages, "transportKinds must contain not more than 2 elements")
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		kind, ok := item.(string)
		if !ok {
			*messages = append(*messages, "each value in transportKinds must be one of the following values: aircraft, vessel")
			continue
		}
		if kind != "aircraft" && kind != "vessel" {
			*messages = append(*messages, "each value in transportKinds must be one of the following values: aircraft, vessel")
			continue
		}
		out = append(out, kind)
	}
	return out
}
