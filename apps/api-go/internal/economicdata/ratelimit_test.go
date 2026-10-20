package economicdata

import (
	"testing"
)

func TestRateLimitMessagesMatchNest(t *testing.T) {
	if presetRateLimitMessage != "This economic data preset was refreshed recently. Please wait before triggering it again." {
		t.Fatalf("preset message = %q", presetRateLimitMessage)
	}
	if upgradeRateLimitMessage != "Akshare upgrade can only be triggered once per hour. Please wait before trying again." {
		t.Fatalf("upgrade message = %q", upgradeRateLimitMessage)
	}
}
