package dashboardwarmap

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

// This file is the minimal export surface an integration test needs to prove that
// the realtime collector writes documents the war-map readers can parse. It adds
// no new read logic: every field comes from redisSnapshots.LatestAdsb /
// LatestAis, so a passing assertion exercises the production decoder.

// RealtimeAdsbAircraft is one parsed aircraft.
type RealtimeAdsbAircraft struct {
	ID            string
	ICAO24        string
	Callsign      string
	Registration  string
	AircraftType  string
	Lat           float64
	Lng           float64
	Heading       *float64
	AltitudeFt    *float64
	GroundSpeedKt *float64
	CountryCode   string
	CountryName   string
	ObservedAt    string
	Source        string
}

// RealtimeAdsbSnapshot is the parsed OpenSky snapshot.
type RealtimeAdsbSnapshot struct {
	SourceEndpoint string
	UpdatedAt      string
	LatestObserved string
	TotalAircraft  int
	ValidPositions int
	StaleThreshold int
	Retained       bool
	Aircraft       []RealtimeAdsbAircraft
}

// RealtimeAisVessel is one parsed vessel.
type RealtimeAisVessel struct {
	MMSI       string
	Name       string
	ObservedAt string
	Lat        float64
	Lng        float64
	ShipType   *float64
	Heading    *float64
	Speed      *float64
	Course     *float64
}

// RealtimeAisSnapshot is the parsed AIS snapshot.
type RealtimeAisSnapshot struct {
	SourceEndpoint string
	UpdatedAt      string
	Connected      bool
	VesselCount    int
	Messages       int
	HasVessels     bool
	Health         string
	ReasonCode     string
	Reason         string
	Disruptions    int
	Density        int
	Candidates     []RealtimeAisVessel
	Vessels        []RealtimeAisVessel
}

// ReadLatestAdsbSnapshot reads realtime-signals:opensky-latest:{orgId} through
// the production decoder.
func ReadLatestAdsbSnapshot(ctx context.Context, client *redis.Client, orgID string) (*RealtimeAdsbSnapshot, error) {
	if client == nil {
		return nil, errors.New("dashboardwarmap: redis is not configured")
	}
	snapshot, err := (redisSnapshots{cache: redisBlobs{client: client}}).LatestAdsb(ctx, orgID)
	if err != nil || snapshot == nil {
		return nil, err
	}
	out := &RealtimeAdsbSnapshot{
		SourceEndpoint: snapshot.Endpoint,
		UpdatedAt:      snapshot.UpdatedAt,
		LatestObserved: snapshot.LatestObserved,
		TotalAircraft:  snapshot.Total,
		ValidPositions: snapshot.Valid,
		StaleThreshold: snapshot.StaleSec,
		Retained:       snapshot.Retained,
		Aircraft:       make([]RealtimeAdsbAircraft, 0, len(snapshot.Aircraft)),
	}
	for _, craft := range snapshot.Aircraft {
		out.Aircraft = append(out.Aircraft, RealtimeAdsbAircraft{
			ID: craft.ID, ICAO24: craft.ICAO24, Callsign: craft.Callsign, Registration: craft.Registration,
			AircraftType: craft.AircraftType, Lat: craft.Lat, Lng: craft.Lng, Heading: craft.Heading,
			AltitudeFt: craft.AltitudeFt, GroundSpeedKt: craft.GroundSpeedKt, CountryCode: craft.CountryCode,
			CountryName: craft.CountryName, ObservedAt: craft.ObservedAt, Source: craft.Source,
		})
	}
	return out, nil
}

// ReadLatestAisSnapshot reads realtime-signals:ais-latest:{orgId} through the
// production decoder.
func ReadLatestAisSnapshot(ctx context.Context, client *redis.Client, orgID string) (*RealtimeAisSnapshot, error) {
	if client == nil {
		return nil, errors.New("dashboardwarmap: redis is not configured")
	}
	snapshot, err := (redisSnapshots{cache: redisBlobs{client: client}}).LatestAis(ctx, orgID)
	if err != nil || snapshot == nil {
		return nil, err
	}
	out := &RealtimeAisSnapshot{
		SourceEndpoint: snapshot.Endpoint,
		UpdatedAt:      snapshot.UpdatedAt,
		Connected:      snapshot.Connected,
		VesselCount:    snapshot.Vessels,
		Messages:       snapshot.Messages,
		HasVessels:     snapshot.HasVessels,
		Health:         snapshot.Health,
		ReasonCode:     snapshot.ReasonCode,
		Reason:         snapshot.Reason,
		Disruptions:    len(snapshot.Disruptions),
		Density:        len(snapshot.Density),
		Candidates:     convertAisVessels(snapshot.Candidates),
		Vessels:        convertAisVessels(snapshot.Ships),
	}
	return out, nil
}

func convertAisVessels(rows []aisVessel) []RealtimeAisVessel {
	out := make([]RealtimeAisVessel, 0, len(rows))
	for _, row := range rows {
		out = append(out, RealtimeAisVessel{
			MMSI: row.MMSI, Name: row.Name, ObservedAt: row.ObservedAt, Lat: row.Lat, Lng: row.Lng,
			ShipType: row.ShipType, Heading: row.Heading, Speed: row.Speed, Course: row.Course,
		})
	}
	return out
}
