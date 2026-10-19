package economicdata

import (
	"strings"
	"testing"
	"time"
)

func TestUpdateFetchConfigPresenceSemantics(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	frequency := FrequencyDaily
	enabled := true
	omitted, _ := buildFetchConfigUpdate(FetchConfigUpdate{Frequency: &frequency, IsEnabled: &enabled}, now)
	joined := strings.Join(omitted, ",")
	if strings.Contains(joined, "repeatCron") {
		t.Fatalf("omitted repeatCron touched the column: %s", joined)
	}
	if !strings.Contains(joined, "`frequency` = ?") || !strings.Contains(joined, "`isEnabled` = ?") {
		t.Fatalf("frequency/enabled missing: %s", joined)
	}

	cleared, args := buildFetchConfigUpdate(FetchConfigUpdate{RepeatCronSet: true}, now)
	if !strings.Contains(strings.Join(cleared, ","), "`repeatCron` = NULL") {
		t.Fatalf("explicit null did not clear: %v", cleared)
	}
	if len(args) != 1 {
		t.Fatalf("null must not bind an argument: %v", args)
	}

	cron := "* * * * *"
	written, args := buildFetchConfigUpdate(FetchConfigUpdate{RepeatCronSet: true, RepeatCron: &cron}, now)
	if !strings.Contains(strings.Join(written, ","), "`repeatCron` = ?") || len(args) != 2 || args[1] != cron {
		t.Fatalf("explicit cron not written: %v %v", written, args)
	}
}
