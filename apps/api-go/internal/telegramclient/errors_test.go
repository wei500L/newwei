package telegramclient

import (
	"errors"
	"fmt"
	"testing"

	"github.com/gotd/td/tgerr"
)

func TestErrorClassification(t *testing.T) {
	tests := []struct {
		name           string
		err            error
		authKey        bool
		floodWait      bool
		floodSeconds   int
		usernameFree   bool
		channelInvalid bool
		description    string
	}{
		{
			name:        "auth key duplicated",
			err:         tgerr.New(401, "AUTH_KEY_DUPLICATED"),
			authKey:     true,
			description: "AUTH_KEY_DUPLICATED",
		},
		{
			name:         "flood wait",
			err:          tgerr.New(420, "FLOOD_WAIT_17"),
			floodWait:    true,
			floodSeconds: 17,
			description:  "FLOOD_WAIT",
		},
		{
			name:         "premium flood wait",
			err:          tgerr.New(420, "FLOOD_PREMIUM_WAIT_3"),
			floodWait:    true,
			floodSeconds: 3,
			description:  "FLOOD_PREMIUM_WAIT",
		},
		{
			name:         "username not occupied",
			err:          tgerr.New(400, "USERNAME_NOT_OCCUPIED"),
			usernameFree: true,
			description:  "USERNAME_NOT_OCCUPIED",
		},
		{
			name:           "channel invalid",
			err:            tgerr.New(400, "CHANNEL_INVALID"),
			channelInvalid: true,
			description:    "CHANNEL_INVALID",
		},
		{
			name:        "phone code invalid",
			err:         tgerr.New(400, "PHONE_CODE_INVALID"),
			description: "PHONE_CODE_INVALID",
		},
		{
			name:        "plain error",
			err:         errors.New("network is down"),
			description: "network is down",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsAuthKeyDuplicated(tt.err); got != tt.authKey {
				t.Errorf("IsAuthKeyDuplicated() = %v, want %v", got, tt.authKey)
			}
			if got := IsFloodWait(tt.err); got != tt.floodWait {
				t.Errorf("IsFloodWait() = %v, want %v", got, tt.floodWait)
			}
			if got := FloodWaitSeconds(tt.err); got != tt.floodSeconds {
				t.Errorf("FloodWaitSeconds() = %d, want %d", got, tt.floodSeconds)
			}
			if got := IsUsernameNotOccupied(tt.err); got != tt.usernameFree {
				t.Errorf("IsUsernameNotOccupied() = %v, want %v", got, tt.usernameFree)
			}
			if got := IsChannelInvalid(tt.err); got != tt.channelInvalid {
				t.Errorf("IsChannelInvalid() = %v, want %v", got, tt.channelInvalid)
			}
			if got := ErrorDescription(tt.err); got != tt.description {
				t.Errorf("ErrorDescription() = %q, want %q", got, tt.description)
			}
		})
	}
}

func TestErrorClassificationThroughWrapping(t *testing.T) {
	// gotd callers wrap errors, so the classification must use errors.As under
	// the hood and see through fmt.Errorf("%w").
	wrapped := fmt.Errorf("fetch history: %w", tgerr.New(400, "CHANNEL_INVALID"))
	if !IsChannelInvalid(wrapped) {
		t.Error("IsChannelInvalid(wrapped) = false, want true")
	}
	if got := ErrorDescription(wrapped); got != "CHANNEL_INVALID" {
		t.Errorf("ErrorDescription(wrapped) = %q, want CHANNEL_INVALID", got)
	}
}

func TestIsAuthKeyDuplicatedTextFallback(t *testing.T) {
	// The connection layer wraps the fatal error, so the Run path must still be
	// detectable even when the tgerr type is no longer visible.
	wrapped := errors.New("telegram: connection error: AUTH_KEY_DUPLICATED")
	if !IsAuthKeyDuplicated(wrapped) {
		t.Error("IsAuthKeyDuplicated(connection-level error) = false, want true")
	}
	if IsAuthKeyDuplicated(errors.New("connection timeout")) {
		t.Error("IsAuthKeyDuplicated(unrelated error) = true, want false")
	}
}

func TestErrorClassificationNil(t *testing.T) {
	if IsAuthKeyDuplicated(nil) {
		t.Error("IsAuthKeyDuplicated(nil) = true, want false")
	}
	if IsFloodWait(nil) {
		t.Error("IsFloodWait(nil) = true, want false")
	}
	if got := FloodWaitSeconds(nil); got != 0 {
		t.Errorf("FloodWaitSeconds(nil) = %d, want 0", got)
	}
	if IsUsernameNotOccupied(nil) {
		t.Error("IsUsernameNotOccupied(nil) = true, want false")
	}
	if IsChannelInvalid(nil) {
		t.Error("IsChannelInvalid(nil) = true, want false")
	}
	if got := ErrorDescription(nil); got != "" {
		t.Errorf("ErrorDescription(nil) = %q, want empty", got)
	}
}

func TestErrorDescriptionKeepsTypeForArgumentType(t *testing.T) {
	// The server text FLOOD_WAIT_5 carries the retry delay as an argument; the
	// description reports the stable type and FloodWaitSeconds reports the delay.
	err := tgerr.New(420, "FLOOD_WAIT_5")
	if got := ErrorDescription(err); got != "FLOOD_WAIT" {
		t.Errorf("ErrorDescription() = %q, want FLOOD_WAIT", got)
	}
	if got := FloodWaitSeconds(err); got != 5 {
		t.Errorf("FloodWaitSeconds() = %d, want 5", got)
	}
}
