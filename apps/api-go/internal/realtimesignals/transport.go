package realtimesignals

import (
	"context"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// TransportPersistence writes MapTransportObjectState and MapTransportTrackPoint
// documents. The document shape, the dedupe/score rules and the track-point
// thresholds are field-for-field ports of
// RealtimeTransportPersistenceService.
type TransportPersistence struct {
	states *mongo.Collection
	tracks *mongo.Collection
	now    func() time.Time
}

func NewTransportPersistence(db *mongo.Database) *TransportPersistence {
	persistence := &TransportPersistence{now: time.Now}
	if db != nil {
		persistence.states = db.Collection(transportStateCollection)
		persistence.tracks = db.Collection(transportTrackCollection)
	}
	return persistence
}

// aircraftClassification is AircraftTransportClassification.
type aircraftClassification struct {
	DisplayCategory     string
	DisplayCategoryZh   string
	Role                string
	RoleZh              string
	IsMilitaryCandidate bool
}

// shipClassification is AisShipTypeClassification.
type shipClassification struct {
	ShipTypeLabel       string
	ShipTypeLabelZh     string
	VesselRole          string
	VesselRoleZh        string
	IsMilitaryCandidate bool
}

// transportMetadata is the stored metadata object. The collector only ever writes
// the source.
type transportMetadata struct {
	Source string `json:"source" bson:"source"`
}

var (
	militaryCallsignPatternA = regexp.MustCompile(`^(RCH|RRR|CNV|QID|GAF|BAF|NVY|NAF|VM)[A-Z0-9]{1,6}$`)
	militaryCallsignPatternB = regexp.MustCompile(`^ASCOT[A-Z0-9]{1,6}$`)
)

var (
	aircraftTransportPrefixes    = []string{"RCH", "RRR", "CNV", "CMB", "ASCOT"}
	aircraftRefuelPrefixes       = []string{"QID", "SHELL", "MPRS", "TKR"}
	aircraftSurveillancePrefixes = []string{"FORTE", "NATO", "MAGMA", "DRAGNET", "AEW"}
)

// isMilitaryLikeAircraft mirrors isMilitaryLikeAircraft.
func isMilitaryLikeAircraft(callsign, icao24, scope string) bool {
	if scope == "military" {
		return true
	}
	normalized := strings.ToUpper(jsTrim(callsign))
	if normalized != "" && (militaryCallsignPatternA.MatchString(normalized) || militaryCallsignPatternB.MatchString(normalized)) {
		return true
	}
	return strings.HasPrefix(strings.ToLower(jsTrim(icao24)), "ae")
}

// aircraftPrefix mirrors extractAircraftPrefix: uppercase, remove all whitespace,
// then the leading run of ASCII letters.
func aircraftPrefix(callsign string) string {
	normalized := strings.ToUpper(removeWhitespace(jsTrim(callsign)))
	end := 0
	for end < len(normalized) && normalized[end] >= 'A' && normalized[end] <= 'Z' {
		end++
	}
	return normalized[:end]
}

func removeWhitespace(value string) string {
	var builder strings.Builder
	for _, r := range value {
		if isJSWhitespace(r) {
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// classifyAircraftTransport mirrors classifyAircraftTransport.
func classifyAircraftTransport(callsign, icao24, scope string) aircraftClassification {
	if !isMilitaryLikeAircraft(callsign, icao24, scope) {
		return aircraftClassification{
			DisplayCategory: "Civil flight", DisplayCategoryZh: "民航飞行",
			Role: "Civil or general aviation", RoleZh: "民航或通用航空",
			IsMilitaryCandidate: false,
		}
	}
	prefix := aircraftPrefix(callsign)
	classification := aircraftClassification{
		DisplayCategory: "Military flight", DisplayCategoryZh: "军事飞行",
		Role: "Tactical aircraft", RoleZh: "战术航空器",
		IsMilitaryCandidate: true,
	}
	switch {
	case containsString(aircraftTransportPrefixes, prefix):
		classification.Role = "Military transport"
		classification.RoleZh = "军用运输"
	case containsString(aircraftRefuelPrefixes, prefix):
		classification.Role = "Aerial refueling"
		classification.RoleZh = "空中加油"
	case containsString(aircraftSurveillancePrefixes, prefix):
		classification.Role = "ISR / surveillance"
		classification.RoleZh = "侦察监视"
	}
	return classification
}

// classifyAisShipType mirrors classifyAisShipType.
func classifyAisShipType(shipType *float64, isMilitaryCandidate bool) shipClassification {
	if shipType == nil || math.IsNaN(*shipType) || math.IsInf(*shipType, 0) {
		role, roleZh := "Other", "其他船舶"
		if isMilitaryCandidate {
			role, roleZh = "Military / government", "军政船舶"
		}
		return shipClassification{
			ShipTypeLabel: "Other", ShipTypeLabelZh: "其他船舶",
			VesselRole: role, VesselRoleZh: roleZh,
			IsMilitaryCandidate: isMilitaryCandidate,
		}
	}
	normalized := int(math.Trunc(*shipType))
	if isMilitaryCandidate || normalized == 35 || normalized == 55 || (normalized >= 50 && normalized <= 59) {
		return shipClassification{
			ShipTypeLabel: "Military / government", ShipTypeLabelZh: "军政船舶",
			VesselRole: "Military / government", VesselRoleZh: "军政船舶",
			IsMilitaryCandidate: true,
		}
	}
	switch {
	case normalized >= 30 && normalized <= 39:
		return shipClassification{"Fishing", "渔船", "Fishing", "渔业作业", false}
	case normalized >= 40 && normalized <= 49:
		return shipClassification{"High-speed craft", "高速船", "High-speed craft", "高速航行", false}
	case normalized >= 60 && normalized <= 69:
		return shipClassification{"Passenger", "客船", "Passenger transport", "客运", false}
	case normalized >= 70 && normalized <= 79:
		return shipClassification{"Cargo", "货船", "Cargo transport", "货运", false}
	case normalized >= 80 && normalized <= 89:
		return shipClassification{"Tanker", "油轮", "Liquid bulk transport", "液货运输", false}
	default:
		return shipClassification{"Other", "其他船舶", "Other", "其他船舶", false}
	}
}

// transportRecord is TransportTelemetryRecord with optional members as pointers.
type transportRecord struct {
	OrgID               string
	EntityKind          string
	SourceType          string
	SourceScope         string
	ObjectKey           string
	ObservedAt          string
	SourceUpdatedAt     string
	Lat                 float64
	Lng                 float64
	GeoCell             string
	ICAO24              string
	MMSI                string
	Callsign            string
	Registration        string
	Name                string
	AircraftType        string
	DisplayCategory     string
	DisplayCategoryZh   string
	Role                string
	RoleZh              string
	CountryCode         string
	CountryName         string
	Heading             *float64
	Course              *float64
	Speed               *float64
	AltitudeFt          *float64
	ShipType            *float64
	ShipTypeLabel       string
	ShipTypeLabelZh     string
	IsMilitaryCandidate bool
	Metadata            transportMetadata
}

// persistAircraftTransportSnapshot mirrors
// persistAircraftTransportSnapshot.
func (p *TransportPersistence) persistAircraftTransportSnapshot(ctx context.Context, orgID string, aircraft []AdsbAircraft, sourceUpdatedAt, sourceScope string) error {
	records := make([]transportRecord, 0, len(aircraft))
	for _, entry := range aircraft {
		if record, ok := buildAircraftTransportRecord(orgID, entry, sourceUpdatedAt, sourceScope); ok {
			records = append(records, record)
		}
	}
	return p.persistTransportTelemetry(ctx, records)
}

func buildAircraftTransportRecord(orgID string, aircraft AdsbAircraft, sourceUpdatedAt, sourceScope string) (transportRecord, bool) {
	if !isValidCoordinate(&aircraft.Lat, &aircraft.Lng) {
		return transportRecord{}, false
	}
	classification := classifyAircraftTransport(aircraft.Callsign, aircraft.ICAO24, sourceScope)
	icao24 := strings.ToLower(aircraft.ICAO24)
	name := aircraft.Callsign
	if name == "" {
		name = aircraft.Registration
	}
	if name == "" {
		name = strings.ToUpper(aircraft.ICAO24)
	}
	record := transportRecord{
		OrgID: orgID, EntityKind: "aircraft", SourceType: "opensky", SourceScope: sourceScope,
		ObjectKey: "opensky:" + icao24, ObservedAt: aircraft.ObservedAt, SourceUpdatedAt: sourceUpdatedAt,
		Lat: aircraft.Lat, Lng: aircraft.Lng, GeoCell: buildTransportGeoCell(aircraft.Lat, aircraft.Lng),
		ICAO24: icao24, Callsign: aircraft.Callsign, Registration: aircraft.Registration,
		AircraftType: aircraft.AircraftType, Name: name,
		CountryCode: aircraft.CountryCode, CountryName: aircraft.CountryName,
		AltitudeFt:      aircraft.AltitudeFt,
		DisplayCategory: classification.DisplayCategory, DisplayCategoryZh: classification.DisplayCategoryZh,
		Role: classification.Role, RoleZh: classification.RoleZh,
		IsMilitaryCandidate: classification.IsMilitaryCandidate,
		Metadata:            transportMetadata{Source: "opensky"},
	}
	if aircraft.Heading != nil {
		heading := normalizeHeading(*aircraft.Heading)
		record.Heading = &heading
	}
	if aircraft.GroundSpeedKt != nil {
		speed := *aircraft.GroundSpeedKt
		record.Speed = &speed
	}
	return record, true
}

// persistAisTransportSnapshot mirrors persistAisTransportSnapshot. A candidate
// report for the same MMSI overrides the "all vessels" entry and marks it as a
// military candidate.
func (p *TransportPersistence) persistAisTransportSnapshot(ctx context.Context, orgID string, snapshot AisSnapshot) error {
	type mergedVessel struct {
		Vessel              AisVessel
		SourceScope         string
		IsMilitaryCandidate bool
	}
	order := make([]string, 0, len(snapshot.Vessels)+len(snapshot.CandidateReports))
	merged := make(map[string]mergedVessel, len(snapshot.Vessels)+len(snapshot.CandidateReports))
	for _, vessel := range snapshot.Vessels {
		if _, exists := merged[vessel.MMSI]; !exists {
			order = append(order, vessel.MMSI)
		}
		merged[vessel.MMSI] = mergedVessel{Vessel: vessel, SourceScope: "all", IsMilitaryCandidate: false}
	}
	for _, vessel := range snapshot.CandidateReports {
		current, exists := merged[vessel.MMSI]
		if !exists {
			order = append(order, vessel.MMSI)
		}
		merged[vessel.MMSI] = mergedVessel{
			Vessel:              mergeAisVesselSnapshot(current.Vessel, vessel, exists),
			SourceScope:         "candidate",
			IsMilitaryCandidate: true,
		}
	}

	records := make([]transportRecord, 0, len(order))
	for _, mmsi := range order {
		entry := merged[mmsi]
		if record, ok := buildAisTransportRecord(orgID, entry.Vessel, snapshot.UpdatedAt, entry.SourceScope, entry.IsMilitaryCandidate); ok {
			records = append(records, record)
		}
	}
	return p.persistTransportTelemetry(ctx, records)
}

// mergeAisVesselSnapshot mirrors mergeAisVesselSnapshot: the newer observation
// wins field by field, and an equal timestamp lets the candidate win.
func mergeAisVesselSnapshot(current, candidate AisVessel, hasCurrent bool) AisVessel {
	if !hasCurrent {
		return candidate
	}
	currentMs, currentOK := parseJSTimeMillis(current.ObservedAt)
	candidateMs, candidateOK := parseJSTimeMillis(candidate.ObservedAt)
	if !currentOK {
		currentMs = 0
	}
	if !candidateOK {
		candidateMs = 0
	}
	if candidateMs >= currentMs {
		return mergeVesselFields(current, candidate)
	}
	return mergeVesselFields(candidate, current)
}

// mergeVesselFields is the JavaScript spread `{...left, ...right}`: right wins
// every defined member.
func mergeVesselFields(left, right AisVessel) AisVessel {
	out := left
	// MMSI, lat/lng and observedAt are required by the normalizer, so they are
	// always present on both sides and the spread always copies them.
	out.MMSI = right.MMSI
	out.Lat = right.Lat
	out.Lng = right.Lng
	out.ObservedAt = right.ObservedAt
	if right.Name != "" {
		out.Name = right.Name
	}
	if right.ShipType != nil {
		out.ShipType = right.ShipType
	}
	if right.Heading != nil {
		out.Heading = right.Heading
	}
	if right.Speed != nil {
		out.Speed = right.Speed
	}
	if right.Course != nil {
		out.Course = right.Course
	}
	return out
}

func buildAisTransportRecord(orgID string, vessel AisVessel, sourceUpdatedAt, sourceScope string, isMilitaryCandidate bool) (transportRecord, bool) {
	if !isValidCoordinate(&vessel.Lat, &vessel.Lng) {
		return transportRecord{}, false
	}
	classification := classifyAisShipType(vessel.ShipType, isMilitaryCandidate)
	record := transportRecord{
		OrgID: orgID, EntityKind: "vessel", SourceType: "ais", SourceScope: sourceScope,
		ObjectKey: "ais:" + vessel.MMSI, ObservedAt: vessel.ObservedAt, SourceUpdatedAt: sourceUpdatedAt,
		Lat: vessel.Lat, Lng: vessel.Lng, GeoCell: buildTransportGeoCell(vessel.Lat, vessel.Lng),
		MMSI: vessel.MMSI, Name: vessel.Name, ShipType: vessel.ShipType,
		ShipTypeLabel: classification.ShipTypeLabel, ShipTypeLabelZh: classification.ShipTypeLabelZh,
		Role: classification.VesselRole, RoleZh: classification.VesselRoleZh,
		DisplayCategory: classification.ShipTypeLabel, DisplayCategoryZh: classification.ShipTypeLabelZh,
		IsMilitaryCandidate: classification.IsMilitaryCandidate,
		Metadata:            transportMetadata{Source: "ais"},
	}
	if vessel.Heading != nil {
		heading := normalizeHeading(*vessel.Heading)
		record.Heading = &heading
	}
	if vessel.Course != nil {
		course := normalizeHeading(*vessel.Course)
		record.Course = &course
	}
	if vessel.Speed != nil {
		speed := *vessel.Speed
		record.Speed = &speed
	}
	return record, true
}

// persistTransportTelemetry mirrors persistTransportTelemetry: dedupe within the
// batch, read the existing states for the object keys, decide which records
// append a track point, insert them, then upsert the states.
func (p *TransportPersistence) persistTransportTelemetry(ctx context.Context, records []transportRecord) error {
	if len(records) == 0 {
		return nil
	}
	deduped := dedupeTransportRecords(records)
	if len(deduped) == 0 {
		return nil
	}
	if p.states == nil || p.tracks == nil {
		return errors.New("realtimesignals: mongo transport collections are not configured")
	}
	orgID := deduped[0].OrgID
	objectKeys := make([]string, 0, len(deduped))
	for _, record := range deduped {
		objectKeys = append(objectKeys, record.ObjectKey)
	}

	cursor, err := p.states.Find(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "objectKey", Value: bson.D{{Key: "$in", Value: objectKeys}}},
	})
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	existingByKey := make(map[string]transportStateDoc, len(deduped))
	for cursor.Next(ctx) {
		var doc transportStateDoc
		if err := cursor.Decode(&doc); err != nil {
			return err
		}
		existingByKey[doc.ObjectKey] = doc
	}
	if err := cursor.Err(); err != nil {
		return err
	}

	trackPoints := make([]transportRecord, 0, len(deduped))
	statesToUpsert := make([]transportRecord, 0, len(deduped))
	for _, record := range deduped {
		existing, hasExisting := existingByKey[record.ObjectKey]
		if shouldPersistTransportTrackPoint(record, existing, hasExisting) {
			trackPoints = append(trackPoints, record)
		}
		existingObservedMs, existingOK := readDateMs(existing.ObservedAt)
		recordObservedMs, recordOK := parseJSTimeMillis(record.ObservedAt)
		if recordOK && (!existingOK || recordObservedMs >= existingObservedMs) {
			statesToUpsert = append(statesToUpsert, record)
		}
	}

	insertedIDs := make(map[string]bson.ObjectID, len(trackPoints))
	now := p.clock()
	if len(trackPoints) > 0 {
		documents := make([]transportTrackDocument, 0, len(trackPoints))
		for _, record := range trackPoints {
			documents = append(documents, buildTransportTrackDocument(record, now))
		}
		result, err := p.tracks.InsertMany(ctx, documents, options.InsertMany().SetOrdered(false))
		if err != nil {
			return err
		}
		for index, inserted := range result.InsertedIDs {
			if index < 0 || index >= len(trackPoints) {
				continue
			}
			if id, ok := inserted.(bson.ObjectID); ok {
				insertedIDs[trackPoints[index].ObjectKey] = id
			}
		}
	}

	if len(statesToUpsert) == 0 {
		return nil
	}
	models := make([]mongo.WriteModel, 0, len(statesToUpsert))
	for _, record := range statesToUpsert {
		existing := existingByKey[record.ObjectKey]
		update := bson.D{
			{Key: "$set", Value: buildTransportStateSet(record, insertedIDs, existing, now)},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}}},
		}
		models = append(models, mongo.NewUpdateOneModel().
			SetFilter(bson.D{
				{Key: "orgId", Value: record.OrgID},
				{Key: "objectKey", Value: record.ObjectKey},
			}).
			SetUpdate(update).
			SetUpsert(true))
	}
	_, err = p.states.BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false))
	return err
}

func (p *TransportPersistence) clock() time.Time {
	if p != nil && p.now != nil {
		return p.now().UTC()
	}
	return time.Now().UTC()
}

// dedupeTransportRecords mirrors dedupeTransportTelemetryRecords.
func dedupeTransportRecords(records []transportRecord) []transportRecord {
	order := make([]string, 0, len(records))
	deduped := make(map[string]transportRecord, len(records))
	for _, record := range records {
		current, exists := deduped[record.ObjectKey]
		if !exists {
			order = append(order, record.ObjectKey)
			deduped[record.ObjectKey] = record
			continue
		}
		currentMs, currentOK := parseJSTimeMillis(current.ObservedAt)
		candidateMs, candidateOK := parseJSTimeMillis(record.ObservedAt)
		if !currentOK {
			currentMs = 0
		}
		if !candidateOK {
			candidateMs = 0
		}
		if candidateMs > currentMs {
			deduped[record.ObjectKey] = record
			continue
		}
		if candidateMs < currentMs {
			continue
		}
		if scoreTransportRecord(record) >= scoreTransportRecord(current) {
			deduped[record.ObjectKey] = record
		}
	}
	out := make([]transportRecord, 0, len(order))
	for _, key := range order {
		out = append(out, deduped[key])
	}
	return out
}

// scoreTransportRecord mirrors scoreTransportTelemetryRecord.
func scoreTransportRecord(record transportRecord) int {
	score := 0
	if record.Callsign != "" {
		score++
	}
	if record.Registration != "" {
		score++
	}
	if record.Name != "" {
		score++
	}
	if record.CountryCode != "" {
		score++
	}
	if record.Heading != nil {
		score++
	}
	if record.Course != nil {
		score++
	}
	if record.Speed != nil {
		score++
	}
	if record.AltitudeFt != nil {
		score++
	}
	if record.ShipType != nil {
		score++
	}
	return score
}

// shouldPersistTransportTrackPoint mirrors
// shouldPersistTransportTrackPoint.
func shouldPersistTransportTrackPoint(record transportRecord, existing transportStateDoc, hasExisting bool) bool {
	if !hasExisting {
		return true
	}
	existingObservedMs, existingOK := readDateMs(existing.ObservedAt)
	recordObservedMs, recordOK := parseJSTimeMillis(record.ObservedAt)
	if !recordOK {
		return false
	}
	if existingOK && recordObservedMs <= existingObservedMs {
		return false
	}
	if existing.Lat != nil && existing.Lng != nil {
		distance := computeTransportDistanceKm(record.Lat, record.Lng, existing.Lat, existing.Lng)
		if distance != nil && *distance >= transportDistanceKm {
			return true
		}
	}
	if computeTransportAngleDelta(record.Heading, existing.Heading) >= transportAngleDeg {
		return true
	}
	if computeTransportAngleDelta(record.Course, existing.Course) >= transportAngleDeg {
		return true
	}
	if record.Speed != nil && existing.Speed != nil && math.Abs(*record.Speed-*existing.Speed) >= transportSpeedKt {
		return true
	}
	if record.EntityKind == "aircraft" && record.AltitudeFt != nil && existing.AltitudeFt != nil &&
		math.Abs(*record.AltitudeFt-*existing.AltitudeFt) >= transportAltitudeFt {
		return true
	}
	if !existingOK {
		return true
	}
	return recordObservedMs-existingObservedMs >= transportHeartbeatMs
}

// transportStateDoc is the projection of an existing object-state document the
// decision logic reads.
type transportStateDoc struct {
	ObjectKey          string         `bson:"objectKey"`
	ObservedAt         *time.Time     `bson:"observedAt"`
	Lat                *float64       `bson:"lat"`
	Lng                *float64       `bson:"lng"`
	Heading            *float64       `bson:"heading"`
	Course             *float64       `bson:"course"`
	Speed              *float64       `bson:"speed"`
	AltitudeFt         *float64       `bson:"altitudeFt"`
	LatestTrackPointID *bson.ObjectID `bson:"latestTrackPointId"`
}

// transportTrackDocument is a track point insert. Every nullable member carries
// an explicit BSON null, exactly like toTransportDocument; Mongoose timestamps
// are reproduced with createdAt/updatedAt.
type transportTrackDocument struct {
	OrgID               string             `bson:"orgId"`
	EntityKind          string             `bson:"entityKind"`
	SourceType          string             `bson:"sourceType"`
	SourceScope         string             `bson:"sourceScope"`
	ObjectKey           string             `bson:"objectKey"`
	ObservedAt          time.Time          `bson:"observedAt"`
	SourceUpdatedAt     *time.Time         `bson:"sourceUpdatedAt"`
	Lat                 float64            `bson:"lat"`
	Lng                 float64            `bson:"lng"`
	GeoCell             string             `bson:"geoCell"`
	ICAO24              *string            `bson:"icao24"`
	MMSI                *string            `bson:"mmsi"`
	Callsign            *string            `bson:"callsign"`
	Registration        *string            `bson:"registration"`
	Name                *string            `bson:"name"`
	AircraftType        *string            `bson:"aircraftType"`
	DisplayCategory     *string            `bson:"displayCategory"`
	DisplayCategoryZh   *string            `bson:"displayCategoryZh"`
	Role                *string            `bson:"role"`
	RoleZh              *string            `bson:"roleZh"`
	CountryCode         *string            `bson:"countryCode"`
	CountryName         *string            `bson:"countryName"`
	Heading             *float64           `bson:"heading"`
	Course              *float64           `bson:"course"`
	Speed               *float64           `bson:"speed"`
	AltitudeFt          *float64           `bson:"altitudeFt"`
	ShipType            *float64           `bson:"shipType"`
	ShipTypeLabel       *string            `bson:"shipTypeLabel"`
	ShipTypeLabelZh     *string            `bson:"shipTypeLabelZh"`
	IsMilitaryCandidate bool               `bson:"isMilitaryCandidate"`
	Metadata            *transportMetadata `bson:"metadata"`
	CreatedAt           time.Time          `bson:"createdAt"`
	UpdatedAt           time.Time          `bson:"updatedAt"`
}

// transportStateSet is the $set document of the object-state upsert.
type transportStateSet struct {
	OrgID               string             `bson:"orgId"`
	EntityKind          string             `bson:"entityKind"`
	SourceType          string             `bson:"sourceType"`
	SourceScope         string             `bson:"sourceScope"`
	ObjectKey           string             `bson:"objectKey"`
	LatestTrackPointID  *bson.ObjectID     `bson:"latestTrackPointId"`
	ObservedAt          time.Time          `bson:"observedAt"`
	SourceUpdatedAt     *time.Time         `bson:"sourceUpdatedAt"`
	Lat                 float64            `bson:"lat"`
	Lng                 float64            `bson:"lng"`
	GeoCell             string             `bson:"geoCell"`
	ICAO24              *string            `bson:"icao24"`
	MMSI                *string            `bson:"mmsi"`
	Callsign            *string            `bson:"callsign"`
	Registration        *string            `bson:"registration"`
	Name                *string            `bson:"name"`
	AircraftType        *string            `bson:"aircraftType"`
	DisplayCategory     *string            `bson:"displayCategory"`
	DisplayCategoryZh   *string            `bson:"displayCategoryZh"`
	Role                *string            `bson:"role"`
	RoleZh              *string            `bson:"roleZh"`
	CountryCode         *string            `bson:"countryCode"`
	CountryName         *string            `bson:"countryName"`
	Heading             *float64           `bson:"heading"`
	Course              *float64           `bson:"course"`
	Speed               *float64           `bson:"speed"`
	AltitudeFt          *float64           `bson:"altitudeFt"`
	ShipType            *float64           `bson:"shipType"`
	ShipTypeLabel       *string            `bson:"shipTypeLabel"`
	ShipTypeLabelZh     *string            `bson:"shipTypeLabelZh"`
	IsMilitaryCandidate bool               `bson:"isMilitaryCandidate"`
	Metadata            *transportMetadata `bson:"metadata"`
	UpdatedAt           time.Time          `bson:"updatedAt"`
}

func buildTransportTrackDocument(record transportRecord, now time.Time) transportTrackDocument {
	observedAt := timeFromISO(record.ObservedAt)
	return transportTrackDocument{
		OrgID: record.OrgID, EntityKind: record.EntityKind, SourceType: record.SourceType,
		SourceScope: record.SourceScope, ObjectKey: record.ObjectKey,
		ObservedAt: observedAt, SourceUpdatedAt: optionalTime(record.SourceUpdatedAt),
		Lat: record.Lat, Lng: record.Lng, GeoCell: record.GeoCell,
		ICAO24: optionalString(record.ICAO24), MMSI: optionalString(record.MMSI),
		Callsign: optionalString(record.Callsign), Registration: optionalString(record.Registration),
		Name: optionalString(record.Name), AircraftType: optionalString(record.AircraftType),
		DisplayCategory: optionalString(record.DisplayCategory), DisplayCategoryZh: optionalString(record.DisplayCategoryZh),
		Role: optionalString(record.Role), RoleZh: optionalString(record.RoleZh),
		CountryCode: optionalString(record.CountryCode), CountryName: optionalString(record.CountryName),
		Heading: record.Heading, Course: record.Course, Speed: record.Speed, AltitudeFt: record.AltitudeFt,
		ShipType: record.ShipType, ShipTypeLabel: optionalString(record.ShipTypeLabel),
		ShipTypeLabelZh:     optionalString(record.ShipTypeLabelZh),
		IsMilitaryCandidate: record.IsMilitaryCandidate, Metadata: &record.Metadata,
		CreatedAt: now, UpdatedAt: now,
	}
}

func buildTransportStateSet(record transportRecord, insertedIDs map[string]bson.ObjectID, existing transportStateDoc, now time.Time) transportStateSet {
	var latest *bson.ObjectID
	if id, ok := insertedIDs[record.ObjectKey]; ok {
		copied := id
		latest = &copied
	} else if existing.LatestTrackPointID != nil && !existing.LatestTrackPointID.IsZero() {
		copied := *existing.LatestTrackPointID
		latest = &copied
	}
	return transportStateSet{
		OrgID: record.OrgID, EntityKind: record.EntityKind, SourceType: record.SourceType,
		SourceScope: record.SourceScope, ObjectKey: record.ObjectKey, LatestTrackPointID: latest,
		ObservedAt: timeFromISO(record.ObservedAt), SourceUpdatedAt: optionalTime(record.SourceUpdatedAt),
		Lat: record.Lat, Lng: record.Lng, GeoCell: record.GeoCell,
		ICAO24: optionalString(record.ICAO24), MMSI: optionalString(record.MMSI),
		Callsign: optionalString(record.Callsign), Registration: optionalString(record.Registration),
		Name: optionalString(record.Name), AircraftType: optionalString(record.AircraftType),
		DisplayCategory: optionalString(record.DisplayCategory), DisplayCategoryZh: optionalString(record.DisplayCategoryZh),
		Role: optionalString(record.Role), RoleZh: optionalString(record.RoleZh),
		CountryCode: optionalString(record.CountryCode), CountryName: optionalString(record.CountryName),
		Heading: record.Heading, Course: record.Course, Speed: record.Speed, AltitudeFt: record.AltitudeFt,
		ShipType: record.ShipType, ShipTypeLabel: optionalString(record.ShipTypeLabel),
		ShipTypeLabelZh:     optionalString(record.ShipTypeLabelZh),
		IsMilitaryCandidate: record.IsMilitaryCandidate, Metadata: &record.Metadata,
		UpdatedAt: now,
	}
}

// buildTransportGeoCell mirrors buildTransportGeoCell: floor to the 0.5 degree
// grid and render each cell coordinate with toFixed(1).
func buildTransportGeoCell(lat, lng float64) string {
	latCell := math.Floor(lat/transportGeoCellStep) * transportGeoCellStep
	lngCell := math.Floor(lng/transportGeoCellStep) * transportGeoCellStep
	return jsToFixed(latCell, 1) + "," + jsToFixed(lngCell, 1)
}

// normalizeHeading mirrors normalizeHeading: [0, 360).
func normalizeHeading(value float64) float64 {
	normalized := math.Mod(value, 360)
	if normalized < 0 {
		normalized += 360
	}
	return normalized
}

// computeTransportAngleDelta mirrors computeTransportAngleDelta.
func computeTransportAngleDelta(left, right *float64) float64 {
	if left == nil || right == nil {
		return 0
	}
	delta := math.Abs(normalizeHeading(*left) - normalizeHeading(*right))
	return math.Min(delta, 360-delta)
}

// computeTransportDistanceKm mirrors the haversine implementation, including the
// 6371km radius and the previous-minus-current delta arguments.
func computeTransportDistanceKm(lat, lng float64, previousLat, previousLng *float64) *float64 {
	if previousLat == nil || previousLng == nil || !isValidCoordinate(previousLat, previousLng) {
		return nil
	}
	toRadians := func(value float64) float64 { return value * math.Pi / 180 }
	dLat := toRadians(*previousLat - lat)
	dLng := toRadians(*previousLng - lng)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(toRadians(lat))*math.Cos(toRadians(*previousLat))*math.Sin(dLng/2)*math.Sin(dLng/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	value := earthRadiusKm * c
	return &value
}

func readDateMs(value *time.Time) (int64, bool) {
	if value == nil || value.IsZero() {
		return 0, false
	}
	return value.UnixMilli(), true
}

func timeFromISO(value string) time.Time {
	if millis, ok := parseJSTimeMillis(value); ok {
		return time.UnixMilli(millis).UTC()
	}
	return time.Now().UTC()
}

func optionalTime(value string) *time.Time {
	if value == "" {
		return nil
	}
	parsed := timeFromISO(value)
	return &parsed
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
