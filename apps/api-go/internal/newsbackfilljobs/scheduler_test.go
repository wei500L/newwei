package newsbackfilljobs

import (
	"testing"
	"time"
)

func TestNextFiveMinuteTick(t *testing.T) {
	base := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		now  time.Time
		want time.Time
	}{
		{base, base.Add(5 * time.Minute)},
		{base.Add(3 * time.Minute), base.Add(5 * time.Minute)},
		{base.Add(5 * time.Minute).Add(-time.Nanosecond), base.Add(5 * time.Minute)},
		{base.Add(5 * time.Minute), base.Add(10 * time.Minute)},
	}
	for _, tc := range cases {
		if got := nextFiveMinuteTick(tc.now); !got.Equal(tc.want) {
			t.Fatalf("nextFiveMinuteTick(%s) = %s, want %s", tc.now, got, tc.want)
		}
	}
}

func TestNextSixHourTickUsesLocalWallClock(t *testing.T) {
	msk := time.FixedZone("MSK", 3*3600)
	cases := []struct {
		now  time.Time
		want time.Time
	}{
		{time.Date(2026, 10, 20, 0, 0, 0, 0, msk), time.Date(2026, 10, 20, 6, 0, 0, 0, msk)},
		{time.Date(2026, 10, 20, 5, 59, 59, 0, msk), time.Date(2026, 10, 20, 6, 0, 0, 0, msk)},
		{time.Date(2026, 10, 20, 6, 0, 1, 0, msk), time.Date(2026, 10, 20, 12, 0, 0, 0, msk)},
		{time.Date(2026, 10, 20, 18, 30, 0, 0, msk), time.Date(2026, 10, 21, 0, 0, 0, 0, msk)},
	}
	for _, tc := range cases {
		if got := nextSixHourTick(tc.now); !got.Equal(tc.want) {
			t.Fatalf("nextSixHourTick(%s) = %s, want %s", tc.now, got, tc.want)
		}
	}
}

func TestQueuePayloadConversionKeepsEveryField(t *testing.T) {
	job := domainJobForTest()
	payload := queuePayloadFromJob(job)
	if payload.JobType != job.JobType || payload.OrgID != job.OrgID || payload.ActorID != job.ActorID ||
		payload.GroupID != job.GroupID || payload.TraceID != job.TraceID || payload.Trigger != job.Trigger {
		t.Fatalf("payload = %+v", payload)
	}
	roundTrip := jobFromQueuePayload(payload)
	if roundTrip != job {
		t.Fatalf("round trip = %+v, want %+v", roundTrip, job)
	}
}
