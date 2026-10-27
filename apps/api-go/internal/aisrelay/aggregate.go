package aisrelay

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Aggregation passes: cleanup, disruption detection, density zoning and snapshot
// assembly. Each function reproduces the corresponding Node pass, including the
// stable-sort tie breaking and the oldest-first eviction order that follow from
// iterating a JS Map.

// chokepointIDPattern reproduces the `\s+` run replaced by "-" when a chokepoint name
// is turned into an id. The class is the JS whitespace set, not Go's ASCII `\s`.
var chokepointIDPattern = regexp.MustCompile(jsWhitespaceClass + `+`)

// Millisecond forms of the aggregation windows.
const (
	densityWindowMillis        = int64(densityWindow / time.Millisecond)
	gapThresholdMillis         = int64(gapThreshold / time.Millisecond)
	darkShipFreshnessMillis    = int64(darkShipFreshness / time.Millisecond)
	candidateRetentionMillis   = int64(candidateRetention / time.Millisecond)
	densityCellRetentionMillis = densityWindowMillis * 2
)

// gridKeyOf reproduces getGridKey: the cell coordinates are floored to the grid and
// rendered with JS number formatting.
//
// JS string interpolation renders -0 as "0", so jsNumberString is used instead of
// strconv: a negative-zero coordinate would otherwise produce the key "-0,-0" and
// split a cell that the Node relay keeps as one.
func gridKeyOf(lat float64, lon float64) string {
	gridLat := math.Floor(lat/gridSizeDeg) * gridSizeDeg
	gridLon := math.Floor(lon/gridSizeDeg) * gridSizeDeg
	return jsNumberString(gridLat) + "," + jsNumberString(gridLon)
}

// getOrCreateDensityCellLocked returns the cell for key, creating it with the cell
// centre as its coordinates. An existing cell keeps its original centre.
func (e *engine) getOrCreateDensityCellLocked(key string, lat float64, lon float64, now int64) *densityCell {
	if cell, ok := e.densityGrid.Get(key); ok {
		return cell
	}
	cell := &densityCell{
		key:        key,
		lat:        math.Floor(lat/gridSizeDeg)*gridSizeDeg + gridSizeDeg/2,
		lon:        math.Floor(lon/gridSizeDeg)*gridSizeDeg + gridSizeDeg/2,
		vesselIDs:  newOrderedSet(),
		lastUpdate: now,
	}
	e.densityGrid.Set(key, cell)
	return cell
}

// removeVesselFromDensityCellLocked drops a vessel from the cell it currently
// occupies, if it occupies one.
func (e *engine) removeVesselFromDensityCellLocked(mmsi string) {
	currentKey, ok := e.vesselGridKeys.Get(mmsi)
	if !ok {
		return
	}
	if cell, ok := e.densityGrid.Get(currentKey); ok {
		cell.vesselIDs.Delete(mmsi)
	}
	e.vesselGridKeys.Delete(mmsi)
}

// cleanupAggregatesLocked expires aging vessels, histories, cells and candidates.
func (e *engine) cleanupAggregatesLocked() {
	now := e.nowMillis()
	cutoff := now - densityWindowMillis

	// Expire vessels last seen before the density window.
	for _, mmsi := range e.expiredVesselKeysLocked(cutoff) {
		e.vessels.Delete(mmsi)
		e.removeVesselFromDensityCellLocked(mmsi)
	}

	// Enforce the vessel cap, dropping the oldest sightings first.
	if e.vessels.Len() > e.cfg.MaxVessels {
		entries := e.vessels.Keys()
		sort.SliceStable(entries, func(left int, right int) bool {
			leftVessel, _ := e.vessels.Get(entries[left])
			rightVessel, _ := e.vessels.Get(entries[right])
			return leftVessel.timestamp < rightVessel.timestamp
		})
		remove := e.vessels.Len() - e.cfg.MaxVessels
		for index := 0; index < remove && index < len(entries); index++ {
			e.vessels.Delete(entries[index])
			e.removeVesselFromDensityCellLocked(entries[index])
		}
	}

	// Expire sightings outside the window, then enforce the history cap.
	type historyUpdate struct {
		mmsi    string
		history []int64
	}
	updates := make([]historyUpdate, 0, e.vesselHistory.Len())
	expired := make([]string, 0)
	e.vesselHistory.Range(func(mmsi string, history []int64) bool {
		filtered := make([]int64, 0, len(history))
		for _, timestamp := range history {
			if timestamp >= cutoff {
				filtered = append(filtered, timestamp)
			}
		}
		if len(filtered) == 0 {
			expired = append(expired, mmsi)
			return true
		}
		updates = append(updates, historyUpdate{mmsi: mmsi, history: filtered})
		return true
	})
	for _, mmsi := range expired {
		e.vesselHistory.Delete(mmsi)
	}
	for _, update := range updates {
		e.vesselHistory.Set(update.mmsi, update.history)
	}
	evictOrderedMapByTimestamp(e.vesselHistory, e.cfg.MaxVesselHistory, func(history []int64) int64 {
		if len(history) == 0 {
			return 0
		}
		return history[len(history)-1]
	})

	// Drop stale members from each cell, then empty cells that have been idle for
	// two density windows.
	dropCells := make([]string, 0)
	e.densityGrid.Range(func(key string, cell *densityCell) bool {
		for _, mmsi := range cell.vesselIDs.Values() {
			if _, ok := e.vessels.Get(mmsi); !ok {
				cell.vesselIDs.Delete(mmsi)
				continue
			}
			if vesselKey, ok := e.vesselGridKeys.Get(mmsi); !ok || vesselKey != key {
				cell.vesselIDs.Delete(mmsi)
			}
		}
		if cell.vesselIDs.Len() == 0 && now-cell.lastUpdate > densityCellRetentionMillis {
			dropCells = append(dropCells, key)
		}
		return true
	})
	for _, key := range dropCells {
		e.densityGrid.Delete(key)
	}
	evictOrderedMapByTimestamp(e.densityGrid, maxDensityCells, func(cell *densityCell) int64 {
		return cell.lastUpdate
	})

	// Expire candidate reports beyond the retention window, then enforce the cap.
	expiredCandidates := make([]string, 0)
	e.candidateReports.Range(func(mmsi string, candidate *candidateReport) bool {
		if candidate.timestamp < now-candidateRetentionMillis {
			expiredCandidates = append(expiredCandidates, mmsi)
		}
		return true
	})
	for _, mmsi := range expiredCandidates {
		e.candidateReports.Delete(mmsi)
	}
	evictOrderedMapByTimestamp(e.candidateReports, e.cfg.MaxCandidateReports, func(candidate *candidateReport) int64 {
		return candidate.timestamp
	})
}

// expiredVesselKeysLocked lists vessels whose last report predates cutoff, in
// insertion order.
func (e *engine) expiredVesselKeysLocked(cutoff int64) []string {
	keys := make([]string, 0)
	e.vessels.Range(func(mmsi string, vessel *vesselState) bool {
		if vessel.timestamp < cutoff {
			keys = append(keys, mmsi)
		}
		return true
	})
	return keys
}

// evictOrderedMapByTimestamp reproduces evictMapByTimestamp: while the container is
// over its cap, delete the entries with the oldest timestamp. The sort is stable so
// entries sharing a timestamp are removed in insertion order, exactly as the JS
// Array.prototype.sort leaves them.
func evictOrderedMapByTimestamp[V any](m *orderedMap[V], maxSize int, timestamp func(V) int64) {
	if m.Len() <= maxSize {
		return
	}
	keys := m.Keys()
	sort.SliceStable(keys, func(left int, right int) bool {
		leftValue, _ := m.Get(keys[left])
		rightValue, _ := m.Get(keys[right])
		return timestamp(leftValue) < timestamp(rightValue)
	})
	remove := m.Len() - maxSize
	for index := 0; index < remove && index < len(keys); index++ {
		m.Delete(keys[index])
	}
}

// detectDisruptionsLocked builds the synthetic disruption list.
func (e *engine) detectDisruptionsLocked() []disruption {
	now := e.nowMillis()

	vesselList := make([]*vesselState, 0, e.vessels.Len())
	e.vessels.Range(func(_ string, vessel *vesselState) bool {
		vesselList = append(vesselList, vessel)
		return true
	})

	disruptions := make([]disruption, 0, len(chokepoints)+1)
	for _, point := range chokepoints {
		vesselCount := 0
		for _, vessel := range vesselList {
			deltaLat := vessel.lat - point.lat
			deltaLon := vessel.lon - point.lon
			if deltaLat*deltaLat+deltaLon*deltaLon <= point.radius*point.radius {
				vesselCount++
			}
		}
		if vesselCount < 5 {
			continue
		}

		normalTraffic := point.radius * 10
		severity := "low"
		if float64(vesselCount) > normalTraffic*1.5 {
			severity = "high"
		} else if float64(vesselCount) > normalTraffic {
			severity = "elevated"
		}

		changePct := 0
		if normalTraffic > 0 {
			changePct = jsRoundToInt((float64(vesselCount)/normalTraffic - 1) * 100)
		}

		name := point.name
		disruptions = append(disruptions, disruption{
			ID:          "chokepoint-" + chokepointIDPattern.ReplaceAllString(strings.ToLower(point.name), "-"),
			Name:        name,
			Type:        "chokepoint_congestion",
			Lat:         jsNumber(point.lat),
			Lon:         jsNumber(point.lon),
			Severity:    severity,
			ChangePct:   changePct,
			WindowHours: 1,
			VesselCount: ref(vesselCount),
			Region:      ref(name),
			Description: strconv.Itoa(vesselCount) + " vessels in " + name,
		})
	}

	// Dark-ship detection is unreachable through the snapshot path in the Node relay, and
	// this port preserves that behaviour rather than silently changing the payload.
	//
	// buildSnapshot calls cleanupAggregates before detectDisruptions, and cleanup drops
	// every sighting older than the 30 minute density window. The rule below needs two
	// surviving sightings more than 60 minutes apart, which is impossible, so `darkShips`
	// stays 0. The branch is kept verbatim so a future fix on both sides produces identical
	// output; the aggregate tests pin both halves of this behaviour.
	darkShipCount := 0
	e.vesselHistory.Range(func(_ string, history []int64) bool {
		if len(history) < 2 {
			return true
		}
		lastSeen := history[len(history)-1]
		previousSeen := history[len(history)-2]
		if lastSeen-previousSeen > gapThresholdMillis && now-lastSeen < darkShipFreshnessMillis {
			darkShipCount++
		}
		return true
	})

	if darkShipCount > 0 {
		severity := "low"
		if darkShipCount > 20 {
			severity = "high"
		} else if darkShipCount > 10 {
			severity = "elevated"
		}
		disruptions = append(disruptions, disruption{
			ID:          "global-gap-spike",
			Name:        "AIS Gap Spike Detected",
			Type:        "gap_spike",
			Lat:         0,
			Lon:         0,
			Severity:    severity,
			ChangePct:   darkShipCount * 10,
			WindowHours: 1,
			DarkShips:   ref(darkShipCount),
			Description: strconv.Itoa(darkShipCount) + " vessels returned after extended AIS silence",
		})
	}

	return disruptions
}

// calculateDensityZonesLocked aggregates the density grid into at most
// maxDensityZones areas, ordered by descending intensity.
func (e *engine) calculateDensityZonesLocked() []densityZone {
	eligible := make([]*densityCell, 0)
	e.densityGrid.Range(func(_ string, cell *densityCell) bool {
		if cell.vesselIDs.Len() >= 2 {
			eligible = append(eligible, cell)
		}
		return true
	})
	if len(eligible) == 0 {
		return []densityZone{}
	}

	maxVessels := eligible[0].vesselIDs.Len()
	minVessels := maxVessels
	for _, cell := range eligible {
		count := cell.vesselIDs.Len()
		if count > maxVessels {
			maxVessels = count
		}
		if count < minVessels {
			minVessels = count
		}
	}
	logMax := math.Log(float64(maxVessels) + 1)
	logMin := math.Log(float64(minVessels) + 1)

	zones := make([]densityZone, 0, len(eligible))
	for _, cell := range eligible {
		currentCount := cell.vesselIDs.Len()
		logCurrent := math.Log(float64(currentCount) + 1)
		intensity := 0.5
		if logMax > logMin {
			intensity = 0.2 + (0.8*(logCurrent-logMin))/(logMax-logMin)
		}
		deltaPct := 0
		if cell.previousCount > 0 {
			deltaPct = jsRoundToInt((float64(currentCount-cell.previousCount) / float64(cell.previousCount)) * 100)
		}
		var note *string
		if currentCount >= 10 {
			note = ref("High traffic area")
		}
		zones = append(zones, densityZone{
			ID:          "density-" + cell.key,
			Name:        "Zone " + cell.key,
			Lat:         jsNumber(cell.lat),
			Lon:         jsNumber(cell.lon),
			Intensity:   jsNumber(intensity),
			DeltaPct:    deltaPct,
			ShipsPerDay: currentCount * 48,
			Note:        note,
		})
	}

	sort.SliceStable(zones, func(left int, right int) bool {
		return zones[left].Intensity > zones[right].Intensity
	})
	if len(zones) > maxDensityZones {
		zones = zones[:maxDensityZones]
	}
	return zones
}

// candidateReportsSnapshotLocked returns the newest candidate reports, capped at the
// configured maximum. The sort is stable, so reports sharing a millisecond keep their
// insertion order exactly as in Node.
func (e *engine) candidateReportsSnapshotLocked() []vesselSnapshotItem {
	items := make([]vesselSnapshotItem, 0, e.candidateReports.Len())
	e.candidateReports.Range(func(_ string, candidate *candidateReport) bool {
		items = append(items, vesselSnapshotItem{
			MMSI:      candidate.mmsi,
			Name:      candidate.name,
			Lat:       jsNumber(candidate.lat),
			Lon:       jsNumber(candidate.lon),
			ShipType:  optionalNumber(candidate.shipType),
			Heading:   optionalNumber(candidate.heading),
			Speed:     optionalNumber(candidate.speed),
			Course:    optionalNumber(candidate.course),
			Timestamp: jsNumber(candidate.timestamp),
		})
		return true
	})
	sort.SliceStable(items, func(left int, right int) bool {
		return items[left].Timestamp > items[right].Timestamp
	})
	if len(items) > e.cfg.MaxCandidateReports {
		items = items[:e.cfg.MaxCandidateReports]
	}
	return items
}

// vesselsSnapshotLocked returns the newest vessel snapshots, capped at the configured
// maximum.
func (e *engine) vesselsSnapshotLocked() []vesselSnapshotItem {
	items := make([]vesselSnapshotItem, 0, e.vessels.Len())
	e.vessels.Range(func(_ string, vessel *vesselState) bool {
		items = append(items, vesselSnapshotItem{
			MMSI:      vessel.mmsi,
			Name:      vessel.name,
			Lat:       jsNumber(vessel.lat),
			Lon:       jsNumber(vessel.lon),
			ShipType:  optionalNumber(vessel.shipType),
			Heading:   optionalNumber(vessel.heading),
			Speed:     optionalNumber(vessel.speed),
			Course:    optionalNumber(vessel.course),
			Timestamp: jsNumber(vessel.timestamp),
		})
		return true
	})
	sort.SliceStable(items, func(left int, right int) bool {
		return items[left].Timestamp > items[right].Timestamp
	})
	if len(items) > e.cfg.MaxVessels {
		items = items[:e.cfg.MaxVessels]
	}
	return items
}

// optionalNumber converts an optional float64 into the wire representation that keeps
// a present 0 while dropping an absent value.
func optionalNumber(value *float64) *jsNumber {
	if value == nil {
		return nil
	}
	return ref(jsNumber(*value))
}

// refreshDensityBaselinesLocked snapshots the current cell populations as the
// baseline for the next deltaPct calculation.
func (e *engine) refreshDensityBaselinesLocked() {
	e.densityGrid.Range(func(_ string, cell *densityCell) bool {
		cell.previousCount = cell.vesselIDs.Len()
		return true
	})
}

// buildSnapshotLocked returns the current snapshot and refreshes the cached JSON.
//
// The result is cached for half the snapshot TTL, mirroring the Node short-circuit:
// consumers poll faster than the TTL and would otherwise force a full cleanup and
// serialisation on every request.
func (e *engine) buildSnapshotLocked() *Snapshot {
	now := e.nowMillis()
	ttlMillis := int64(e.cfg.SnapshotCacheTTL / time.Millisecond)
	if e.lastSnapshot != nil && now-e.lastSnapshotAt < ttlMillis/2 {
		return e.lastSnapshot
	}

	e.cleanupAggregatesLocked()
	e.snapshotSequence++

	candidateSnapshot := e.candidateReportsSnapshotLocked()
	vesselsSnapshot := e.vesselsSnapshotLocked()

	snapshot := &Snapshot{
		Sequence:  e.snapshotSequence,
		Timestamp: isoMillis(now),
		Status: snapshotStatus{
			Connected:       e.state == connOpen,
			Vessels:         e.vessels.Len(),
			Messages:        e.messageCount,
			Clients:         0,
			DroppedMessages: e.droppedMessages,
		},
		Diagnostics:      e.buildRelayDiagnosticsLocked(),
		Disruptions:      e.detectDisruptionsLocked(),
		Density:          e.calculateDensityZonesLocked(),
		CandidateReports: candidateSnapshot,
		Vessels:          vesselsSnapshot,
	}

	e.lastSnapshot = snapshot
	e.lastSnapshotAt = now

	withoutCandidates := *snapshot
	withoutCandidates.CandidateReports = []vesselSnapshotItem{}
	e.lastSnapshotJSONWithoutCandidates = marshalSnapshot(&withoutCandidates)
	e.lastSnapshotJSONWithCandidates = marshalSnapshot(snapshot)

	e.refreshDensityBaselinesLocked()
	return snapshot
}
