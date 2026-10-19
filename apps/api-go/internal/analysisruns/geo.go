package analysisruns

// This file reads the real transport collections and builds the bounded geo
// context. All queries are organization-scoped; the top-30 aggregation is
// described on GeoBuilder.

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	mapTransportStateCollection      = "maptransportobjectstates"
	mapTransportTrackPointCollection = "maptransporttrackpoints"
)

// GeoBuilder reads the real transport collections for one analysis context.
//
// Window: states and track points are restricted to the requested inclusive
// observedAt range, and every query is organization-scoped.
//
// Top-30 optimization: the source grouped every matching track point with
// $push and sliced afterwards, and on an empty result it repeated the identical
// range query as a fallback. This implementation uses Mongo 7.0 $topN inside
// $group, so each object transfers at most the 30 points the prompt needs and
// there is no duplicate fallback query. The state selection (latest 20 states,
// optional bbox on states only, objectKeys limited to the first 20) is
// unchanged; track points are never bbox-filtered.
//
// Ordering: track points sort by observedAt descending. MongoDB does not define
// a tie order for equal timestamps, and the source $sort had the same property;
// no artificial secondary business ordering is introduced here.
type GeoBuilder struct {
	mongo *mongo.Database
}

// NewGeoBuilder builds the reader over the shared Mongo connection.
func NewGeoBuilder(database *mongo.Database) *GeoBuilder {
	return &GeoBuilder{mongo: database}
}

type stateDocument struct {
	ObjectKey         string    `bson:"objectKey"`
	EntityKind        string    `bson:"entityKind"`
	SourceScope       string    `bson:"sourceScope"`
	ObservedAt        time.Time `bson:"observedAt"`
	Lat               float64   `bson:"lat"`
	Lng               float64   `bson:"lng"`
	Callsign          *string   `bson:"callsign"`
	Registration      *string   `bson:"registration"`
	ICAO24            *string   `bson:"icao24"`
	Name              *string   `bson:"name"`
	MMSI              *string   `bson:"mmsi"`
	DisplayCategory   *string   `bson:"displayCategory"`
	DisplayCategoryZh *string   `bson:"displayCategoryZh"`
	Role              *string   `bson:"role"`
	RoleZh            *string   `bson:"roleZh"`
	ShipTypeLabel     *string   `bson:"shipTypeLabel"`
	ShipTypeLabelZh   *string   `bson:"shipTypeLabelZh"`
	CountryCode       *string   `bson:"countryCode"`
	CountryName       *string   `bson:"countryName"`
	Heading           *float64  `bson:"heading"`
	Course            *float64  `bson:"course"`
	Speed             *float64  `bson:"speed"`
	AltitudeFt        *float64  `bson:"altitudeFt"`
}

type trackPointDocument struct {
	ID         bson.ObjectID `bson:"_id"`
	ObservedAt time.Time     `bson:"observedAt"`
	Lat        float64       `bson:"lat"`
	Lng        float64       `bson:"lng"`
	Heading    *float64      `bson:"heading"`
	Course     *float64      `bson:"course"`
	Speed      *float64      `bson:"speed"`
	AltitudeFt *float64      `bson:"altitudeFt"`
	GeoCell    *string       `bson:"geoCell"`
}

type trackGroupDocument struct {
	ObjectKey string               `bson:"_id"`
	Points    []trackPointDocument `bson:"points"`
}

// Build reads the states and bounded tracks and assembles the complete context.
func (b *GeoBuilder) Build(ctx context.Context, orgID string, input GeoTransportInput) (GeoContext, error) {
	if b == nil || b.mongo == nil {
		return GeoContext{}, fmt.Errorf("analysisruns: mongo is not configured")
	}
	entityKinds := input.TransportKinds
	if len(entityKinds) == 0 {
		entityKinds = []string{"aircraft", "vessel"}
	}
	startDate, err := parseJSDate(input.StartDate)
	if err != nil {
		return GeoContext{}, fmt.Errorf("analysisruns: invalid startDate: %w", err)
	}
	endDate, err := parseJSDate(input.EndDate)
	if err != nil {
		return GeoContext{}, fmt.Errorf("analysisruns: invalid endDate: %w", err)
	}

	stateFilter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "entityKind", Value: bson.D{{Key: "$in", Value: entityKinds}}},
		{Key: "observedAt", Value: bson.D{
			{Key: "$gte", Value: startDate},
			{Key: "$lte", Value: endDate},
		}},
	}
	bbox := input.Bbox
	if len(bbox) != 4 {
		bbox = nil
	}
	if bbox != nil {
		stateFilter = append(stateFilter,
			bson.E{Key: "lng", Value: bson.D{
				{Key: "$gte", Value: bbox[0]},
				{Key: "$lte", Value: bbox[2]},
			}},
			bson.E{Key: "lat", Value: bson.D{
				{Key: "$gte", Value: bbox[1]},
				{Key: "$lte", Value: bbox[3]},
			}},
		)
	}
	if len(input.ObjectKeys) > 0 {
		objectKeys := input.ObjectKeys
		if len(objectKeys) > maxGeoObjects {
			objectKeys = objectKeys[:maxGeoObjects]
		}
		stateFilter = append(stateFilter, bson.E{Key: "objectKey", Value: bson.D{{Key: "$in", Value: objectKeys}}})
	}

	cursor, err := b.mongo.Collection(mapTransportStateCollection).Find(ctx, stateFilter,
		options.Find().
			SetSort(bson.D{{Key: "observedAt", Value: -1}}).
			SetLimit(maxGeoObjects))
	if err != nil {
		return GeoContext{}, fmt.Errorf("analysisruns: query transport states: %w", err)
	}
	defer cursor.Close(ctx)
	states := make([]stateDocument, 0, maxGeoObjects)
	if err := cursor.All(ctx, &states); err != nil {
		return GeoContext{}, fmt.Errorf("analysisruns: decode transport states: %w", err)
	}

	objectKeys := make([]string, 0, len(states))
	seen := make(map[string]struct{}, len(states))
	for _, state := range states {
		key := strings.TrimSpace(state.ObjectKey)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		objectKeys = append(objectKeys, key)
	}
	tracks, err := b.loadTrackPointsByObjectKeys(ctx, orgID, objectKeys, startDate, endDate)
	if err != nil {
		return GeoContext{}, err
	}

	objects := make([]GeoObject, 0, len(states))
	for _, state := range states {
		// The source looks up the raw state.objectKey in a map keyed by the
		// trimmed, deduplicated query list, so an object key with surrounding
		// whitespace legitimately yields no points. No trimming fallback is
		// added here.
		objects = append(objects, buildGeoObject(state, tracks[state.ObjectKey]))
	}

	trackPointIDs := make([]string, 0)
	geoCellCounts := make(map[string]int)
	geoCellOrder := make([]string, 0)
	for _, object := range objects {
		for _, point := range object.TrackPoints {
			if point.TrackPointID != "" {
				trackPointIDs = append(trackPointIDs, point.TrackPointID)
			}
			if point.GeoCell != nil && *point.GeoCell != "" {
				if _, ok := geoCellCounts[*point.GeoCell]; !ok {
					geoCellOrder = append(geoCellOrder, *point.GeoCell)
				}
				geoCellCounts[*point.GeoCell]++
			}
		}
	}
	hotspots := make([]GeoHotspot, 0, len(geoCellCounts))
	for _, cell := range geoCellOrder {
		hotspots = append(hotspots, GeoHotspot{GeoCell: cell, Count: geoCellCounts[cell]})
	}
	sort.SliceStable(hotspots, func(left, right int) bool {
		return hotspots[left].Count > hotspots[right].Count
	})
	if len(hotspots) > 10 {
		hotspots = hotspots[:10]
	}

	filters := GeoFilters{
		TransportKinds: entityKinds,
		StartDate:      input.StartDate,
		EndDate:        input.EndDate,
	}
	if bbox != nil {
		filters.Bbox = bbox
	}
	if len(input.ObjectKeys) > 0 {
		filters.RequestedObjectKeys = input.ObjectKeys
	}

	contextKeys := make([]string, 0, len(objects))
	for _, object := range objects {
		contextKeys = append(contextKeys, object.ObjectKey)
	}
	return GeoContext{
		Filters:       filters,
		ObjectKeys:    contextKeys,
		TrackPointIDs: trackPointIDs,
		Hotspots:      hotspots,
		Objects:       objects,
	}, nil
}

// loadTrackPointsByObjectKeys returns at most 30 latest points per object with a
// single bounded aggregation. An empty object list returns an empty map without
// querying Mongo, which also removes the source's repeated empty fallback.
func (b *GeoBuilder) loadTrackPointsByObjectKeys(
	ctx context.Context,
	orgID string,
	objectKeys []string,
	startDate time.Time,
	endDate time.Time,
) (map[string][]trackPointDocument, error) {
	if len(objectKeys) == 0 {
		return map[string][]trackPointDocument{}, nil
	}
	match := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "objectKey", Value: bson.D{{Key: "$in", Value: objectKeys}}},
		{Key: "observedAt", Value: bson.D{
			{Key: "$gte", Value: startDate},
			{Key: "$lte", Value: endDate},
		}},
	}
	output := bson.D{
		{Key: "_id", Value: "$_id"},
		{Key: "observedAt", Value: "$observedAt"},
		{Key: "lat", Value: "$lat"},
		{Key: "lng", Value: "$lng"},
		{Key: "heading", Value: "$heading"},
		{Key: "course", Value: "$course"},
		{Key: "speed", Value: "$speed"},
		{Key: "altitudeFt", Value: "$altitudeFt"},
		{Key: "geoCell", Value: "$geoCell"},
	}
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: match}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$objectKey"},
			{Key: "points", Value: bson.D{{Key: "$topN", Value: bson.D{
				{Key: "n", Value: maxTrackPointsPerObject},
				{Key: "sortBy", Value: bson.D{{Key: "observedAt", Value: -1}}},
				{Key: "output", Value: output},
			}}}},
		}}},
	}
	cursor, err := b.mongo.Collection(mapTransportTrackPointCollection).Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("analysisruns: aggregate track points: %w", err)
	}
	defer cursor.Close(ctx)
	groups := make([]trackGroupDocument, 0, len(objectKeys))
	if err := cursor.All(ctx, &groups); err != nil {
		return nil, fmt.Errorf("analysisruns: decode track points: %w", err)
	}
	result := make(map[string][]trackPointDocument, len(groups))
	for _, group := range groups {
		result[group.ObjectKey] = group.Points
	}
	return result, nil
}

func buildGeoObject(state stateDocument, points []trackPointDocument) GeoObject {
	name := state.ObjectKey
	if state.EntityKind == "aircraft" {
		name = firstNonNil(state.Callsign, state.Registration, state.ICAO24, stringPointer(state.ObjectKey))
	} else {
		name = firstNonNil(state.Name, state.MMSI, stringPointer(state.ObjectKey))
	}
	trackPoints := make([]GeoTrackPoint, 0, len(points))
	for _, point := range points {
		trackPointID := ""
		if !point.ID.IsZero() {
			trackPointID = point.ID.Hex()
		}
		trackPoints = append(trackPoints, GeoTrackPoint{
			TrackPointID: trackPointID,
			ObservedAt:   isoString(point.ObservedAt),
			Lat:          point.Lat,
			Lng:          point.Lng,
			Heading:      finitePointer(point.Heading),
			Course:       finitePointer(point.Course),
			Speed:        finitePointer(point.Speed),
			AltitudeFt:   finitePointer(point.AltitudeFt),
			GeoCell:      point.GeoCell,
		})
	}
	return GeoObject{
		ObjectKey:         state.ObjectKey,
		EntityKind:        state.EntityKind,
		SourceScope:       state.SourceScope,
		Name:              name,
		DisplayCategory:   state.DisplayCategory,
		DisplayCategoryZh: state.DisplayCategoryZh,
		Role:              state.Role,
		RoleZh:            state.RoleZh,
		ShipTypeLabel:     state.ShipTypeLabel,
		ShipTypeLabelZh:   state.ShipTypeLabelZh,
		CountryCode:       state.CountryCode,
		CountryName:       state.CountryName,
		LatestObservedAt:  isoString(state.ObservedAt),
		LatestPosition: GeoPosition{
			Lat:        state.Lat,
			Lng:        state.Lng,
			Heading:    finitePointer(state.Heading),
			Course:     finitePointer(state.Course),
			Speed:      finitePointer(state.Speed),
			AltitudeFt: finitePointer(state.AltitudeFt),
		},
		TrackPoints: trackPoints,
	}
}

func firstNonNil(values ...*string) string {
	for _, value := range values {
		if value != nil {
			return *value
		}
	}
	return ""
}

func stringPointer(value string) *string { return &value }

func finitePointer(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	copy := *value
	return &copy
}

func isoString(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// parseJSDate accepts the ISO shapes JavaScript Date.parse handles for this
// input. A date-only value is UTC; a date-time without an offset is local time,
// matching ECMAScript. Anything else fails at execution time, which becomes a
// failed analysis run (not a submission-time 400).
func parseJSDate(value string) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, fmt.Errorf("empty date")
	}
	layoutsUTC := []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999Z0700",
		"2006-01-02T15:04:05Z0700",
		"2006-01-02",
	}
	for _, layout := range layoutsUTC {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC(), nil
		}
	}
	layoutsLocal := []string{
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
	}
	for _, layout := range layoutsLocal {
		if parsed, err := time.ParseInLocation(layout, trimmed, time.Local); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized date %q", trimmed)
}
