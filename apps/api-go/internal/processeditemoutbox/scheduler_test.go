package processeditemoutbox

import (
	"context"
	"testing"
	"time"
)

func TestSchedulerLeaseContract(t *testing.T) {
	if lockKey != "lock:cron:processed-item-outbox" {
		t.Fatalf("lockKey = %q", lockKey)
	}
	if lockTTL != 290*time.Second {
		t.Fatalf("lockTTL = %s", lockTTL)
	}
	if tickPeriod != 5*time.Minute {
		t.Fatalf("tickPeriod = %s", tickPeriod)
	}
}

func TestSchedulerSkipsTickWithoutLease(t *testing.T) {
	lock := &fakeLock{acquired: false}
	scheduler := NewScheduler(&Service{store: &mysqlStore{}}, lock, nil)
	scheduler.runTick(context.Background())
	if lock.releases != 0 || lock.renews != 0 {
		t.Fatalf("lease operations = renew:%d release:%d", lock.renews, lock.releases)
	}
}

func TestSchedulerReleasesAcquiredLease(t *testing.T) {
	lock := &fakeLock{acquired: true}
	scheduler := NewScheduler(&Service{store: &mysqlStore{}}, lock, nil)
	scheduler.runTick(context.Background())
	if lock.releases != 1 {
		t.Fatalf("release count = %d, want 1", lock.releases)
	}
}

type fakeLock struct {
	acquired bool
	renews   int
	releases int
}

func (l *fakeLock) SetIfAbsent(context.Context, string, string, time.Duration) (bool, error) {
	return l.acquired, nil
}

func (l *fakeLock) RenewLock(context.Context, string, string, time.Duration) error {
	l.renews++
	return nil
}

func (l *fakeLock) ReleaseLock(context.Context, string, string) error {
	l.releases++
	return nil
}
