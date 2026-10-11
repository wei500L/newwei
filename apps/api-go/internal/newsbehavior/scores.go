package newsbehavior

import (
	"math"
	"sort"
	"strconv"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

func init() {
	for i := range behaviorBands {
		band := &behaviorBands[i]
		band.weight = bandAverageWeight(band.start, band.end)
	}
}

func decayWeight(ageDays float64) float64 {
	if math.IsNaN(ageDays) || math.IsInf(ageDays, 0) || ageDays < 0 {
		ageDays = 0
	}
	return math.Pow(0.5, ageDays/float64(decayHalfLifeDays))
}

func bandAverageWeight(start, end int) float64 {
	if start < 0 {
		start = 0
	}
	if end < start {
		end = start
	}
	total := 0.0
	for day := start; day <= end; day++ {
		total += decayWeight(float64(day))
	}
	days := float64(end - start + 1)
	return round4(total / days)
}

func bandIndex(dayOffset int) int {
	for i, band := range behaviorBands {
		if dayOffset >= band.start && dayOffset <= band.end {
			return i
		}
	}
	return -1
}

// round4 对齐 Number(value.toFixed(4))：先格式化到四位小数再解析回去。
func round4(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	parsed, err := strconv.ParseFloat(strconv.FormatFloat(value, 'f', 4, 64), 64)
	if err != nil {
		return 0
	}
	return parsed
}

func parsePositiveNumber(raw string) (float64, bool) {
	parsed, err := strconv.ParseFloat(trimJSNumber(raw), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
		return 0, false
	}
	return parsed, true
}

func trimJSNumber(raw string) string {
	start := 0
	end := len(raw)
	for start < end && isJSSpace(raw[start]) {
		start++
	}
	for end > start && isJSSpace(raw[end-1]) {
		end--
	}
	return raw[start:end]
}

func isJSSpace(b byte) bool {
	switch b {
	case ' ', '\n', '\r', '\t', '\v', '\f':
		return true
	default:
		return false
	}
}

// tally 保留首次插入顺序。加总不挪动已有键。
type tally struct {
	keys []string
	vals map[string]float64
}

func newTally() *tally {
	return &tally{vals: map[string]float64{}}
}

func (t *tally) add(key string, delta float64) {
	if t == nil {
		return
	}
	if prev, ok := t.vals[key]; ok {
		t.vals[key] = prev + delta
		return
	}
	t.keys = append(t.keys, key)
	t.vals[key] = delta
}

func (t *tally) mergeFrom(incoming *tally) {
	if t == nil || incoming == nil {
		return
	}
	for _, key := range incoming.keys {
		t.add(key, incoming.vals[key])
	}
}

func (t *tally) toMap() personalnews.ScoreMap {
	out := make(personalnews.ScoreMap)
	if t == nil {
		return out
	}
	for _, key := range t.keys {
		out[key] = t.vals[key]
	}
	return out
}

func (t *tally) record() scoreRecord {
	if t == nil || len(t.keys) == 0 {
		return scoreRecord{}
	}
	vals := make(map[string]float64, len(t.vals))
	for key, value := range t.vals {
		vals[key] = value
	}
	return scoreRecord{order: append([]string(nil), t.keys...), vals: vals}
}

func (t *tally) limited() *tally {
	out := newTally()
	if t == nil || len(t.keys) == 0 {
		return out
	}
	type pair struct {
		key   string
		value float64
	}
	pairs := make([]pair, 0, len(t.keys))
	for _, key := range t.keys {
		pairs = append(pairs, pair{key: key, value: t.vals[key]})
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		return pairs[i].value > pairs[j].value
	})
	if len(pairs) > scoreLimit {
		pairs = pairs[:scoreLimit]
	}
	for _, pair := range pairs {
		out.add(pair.key, pair.value)
	}
	return out
}

// scoreRecord 按分数排序或插入顺序写出 JSON。encoding/json 对 map
// 会按字母序重排，不能用在画像上。
type scoreRecord struct {
	order []string
	vals  map[string]float64
}

func (s scoreRecord) MarshalJSON() ([]byte, error) {
	if len(s.order) == 0 {
		return []byte("{}"), nil
	}
	var buf []byte
	buf = append(buf, '{')
	first := true
	for _, key := range s.order {
		value, ok := s.vals[key]
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		quoted, err := jsQuote(key)
		if err != nil {
			return nil, err
		}
		if !first {
			buf = append(buf, ',')
		}
		first = false
		buf = append(buf, quoted...)
		buf = append(buf, ':')
		if value == 0 {
			value = 0
		}
		buf = append(buf, strconv.FormatFloat(value, 'f', -1, 64)...)
	}
	buf = append(buf, '}')
	return buf, nil
}

type scoreDims struct {
	actions  *tally
	sources  *tally
	topics   *tally
	entities *tally
	items    *tally
	events   *tally
	domains  *tally
}

func newScoreDims() *scoreDims {
	return &scoreDims{
		actions:  newTally(),
		sources:  newTally(),
		topics:   newTally(),
		entities: newTally(),
		items:    newTally(),
		events:   newTally(),
		domains:  newTally(),
	}
}

func (d *scoreDims) byName(name string) *tally {
	if d == nil {
		return nil
	}
	switch name {
	case "actions":
		return d.actions
	case "sources":
		return d.sources
	case "topics":
		return d.topics
	case "entities":
		return d.entities
	case "items":
		return d.items
	case "events":
		return d.events
	case "domains":
		return d.domains
	default:
		return nil
	}
}

func (d *scoreDims) set(name string, value *tally) {
	if d == nil {
		return
	}
	if value == nil {
		value = newTally()
	}
	switch name {
	case "actions":
		d.actions = value
	case "sources":
		d.sources = value
	case "topics":
		d.topics = value
	case "entities":
		d.entities = value
	case "items":
		d.items = value
	case "events":
		d.events = value
	case "domains":
		d.domains = value
	}
}

func (d *scoreDims) hasAny() bool {
	if d == nil {
		return false
	}
	for _, name := range dimensionNames {
		if tally := d.byName(name); tally != nil && len(tally.keys) > 0 {
			return true
		}
	}
	return false
}

func (d *scoreDims) export() personalnews.ScoreDimensions {
	if d == nil {
		return emptyDims()
	}
	return personalnews.ScoreDimensions{
		Actions:  d.actions.toMap(),
		Sources:  d.sources.toMap(),
		Topics:   d.topics.toMap(),
		Entities: d.entities.toMap(),
		Items:    d.items.toMap(),
		Events:   d.events.toMap(),
		Domains:  d.domains.toMap(),
	}
}

func (d *scoreDims) wire() wireDims {
	if d == nil {
		d = newScoreDims()
	}
	return wireDims{
		Actions:  d.actions.record(),
		Sources:  d.sources.record(),
		Topics:   d.topics.record(),
		Entities: d.entities.record(),
		Items:    d.items.record(),
		Events:   d.events.record(),
		Domains:  d.domains.record(),
	}
}

type bandFold struct {
	key      string
	weight   float64
	positive *scoreDims
	negative *scoreDims
}

func foldDays(days [][]hashField) (positive, negative *scoreDims, bands []bandFold, actionTotal float64) {
	positive = newScoreDims()
	negative = newScoreDims()
	bands = make([]bandFold, len(behaviorBands))
	for i, band := range behaviorBands {
		bands[i] = bandFold{
			key:      band.key,
			weight:   band.weight,
			positive: newScoreDims(),
			negative: newScoreDims(),
		}
	}
	for offset, fields := range days {
		index := bandIndex(offset)
		if index < 0 || index >= len(bands) {
			continue
		}
		decay := decayWeight(float64(offset))
		rawPositive := newScoreDims()
		rawNegative := newScoreDims()
		for _, field := range fields {
			parsed, ok := parseBehaviorField(field.field)
			if !ok {
				continue
			}
			score, ok := parsePositiveNumber(field.value)
			if !ok {
				continue
			}
			target := rawPositive
			if parsed.polarity != "p" {
				target = rawNegative
			}
			bucket := target.byName(parsed.dimension)
			if bucket == nil {
				continue
			}
			bucket.add(parsed.term, score)
			if parsed.polarity == "p" && parsed.dimension == "actions" {
				actionTotal += score
			}
		}
		band := bands[index]
		for _, name := range dimensionNames {
			addDecayed(positive.byName(name), band.positive.byName(name), rawPositive.byName(name), decay, name)
			addDecayed(negative.byName(name), band.negative.byName(name), rawNegative.byName(name), decay, name)
		}
	}
	return positive, negative, bands, actionTotal
}

func addDecayed(aggregate, band, raw *tally, decay float64, dimension string) {
	if raw == nil {
		return
	}
	for _, term := range raw.keys {
		rawValue := raw.vals[term]
		normalized := normalizeDimensionKey(dimension, term)
		if normalized == "" || rawValue <= 0 {
			continue
		}
		score := round4(math.Log1p(rawValue) * decay)
		if score <= 0 {
			continue
		}
		if band != nil {
			band.add(normalized, score)
		}
		if aggregate != nil {
			aggregate.add(normalized, score)
		}
	}
}

func normalizeDimensionKey(dimension, term string) string {
	if dimension == "items" || dimension == "events" {
		return normalizeID(term)
	}
	return normalizeTerm(term)
}

func applyLegacy(positive *scoreDims, hashes [][]hashField) bool {
	if positive == nil || len(hashes) != len(dimensionNames) {
		return false
	}
	scaled := newScoreDims()
	for i, kind := range dimensionNames {
		norm := normalizeTerm
		if kind == "items" || kind == "events" {
			norm = normalizeID
		}
		scaled.byName(kind).mergeFrom(scaleLegacy(parseScoreRecord(hashes[i], norm)))
	}
	if !scaled.hasAny() {
		return false
	}
	for _, kind := range dimensionNames {
		positive.byName(kind).mergeFrom(scaled.byName(kind))
	}
	return true
}

func parseScoreRecord(fields []hashField, norm func(string) string) *tally {
	type pair struct {
		key   string
		value float64
	}
	pairs := make([]pair, 0, len(fields))
	for _, field := range fields {
		term := norm(field.field)
		if term == "" {
			continue
		}
		value, ok := parsePositiveNumber(field.value)
		if !ok {
			continue
		}
		pairs = append(pairs, pair{key: term, value: value})
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		return pairs[i].value > pairs[j].value
	})
	if len(pairs) > scoreLimit {
		pairs = pairs[:scoreLimit]
	}
	out := newTally()
	for _, pair := range pairs {
		if _, exists := out.vals[pair.key]; exists {
			out.vals[pair.key] = pair.value
			continue
		}
		out.add(pair.key, pair.value)
	}
	return out
}

func scaleLegacy(in *tally) *tally {
	out := newTally()
	if in == nil {
		return out
	}
	for _, term := range in.keys {
		scaled := round4(math.Log1p(in.vals[term]) * legacyFallbackScale)
		if scaled <= 0 {
			continue
		}
		out.add(term, scaled)
	}
	return out
}

func subtract(positive, negative *tally) *tally {
	out := newTally()
	seen := make(map[string]struct{})
	if positive != nil {
		for _, key := range positive.keys {
			seen[key] = struct{}{}
			neg := 0.0
			if negative != nil {
				neg = negative.vals[key]
			}
			value := round4(positive.vals[key] - neg)
			if math.Abs(value) <= scoreEpsilon {
				continue
			}
			out.add(key, value)
		}
	}
	if negative != nil {
		for _, key := range negative.keys {
			if _, ok := seen[key]; ok {
				continue
			}
			value := round4(0 - negative.vals[key])
			if math.Abs(value) <= scoreEpsilon {
				continue
			}
			out.add(key, value)
		}
	}
	return out.limited()
}

func clampScores(in *tally) *tally {
	out := newTally()
	if in == nil {
		return out.limited()
	}
	for _, key := range in.keys {
		value := round4(math.Max(0, in.vals[key]))
		if value <= 0 {
			continue
		}
		out.add(key, value)
	}
	return out.limited()
}

func subtractDims(positive, negative *scoreDims) *scoreDims {
	out := newScoreDims()
	for _, name := range dimensionNames {
		var pos, neg *tally
		if positive != nil {
			pos = positive.byName(name)
		}
		if negative != nil {
			neg = negative.byName(name)
		}
		out.set(name, subtract(pos, neg))
	}
	return out
}

func clampDims(in *scoreDims) *scoreDims {
	out := newScoreDims()
	for _, name := range dimensionNames {
		var tally *tally
		if in != nil {
			tally = in.byName(name)
		}
		out.set(name, clampScores(tally))
	}
	return out
}
