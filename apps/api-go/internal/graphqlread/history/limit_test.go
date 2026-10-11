package history

import "testing"

func TestNotificationTakeFollowsNest(t *testing.T) {
	cases := []struct {
		name string
		args map[string]any
		want int
	}{
		{name: "omitted", args: nil, want: 20},
		{name: "empty", args: map[string]any{}, want: 20},
		{name: "null", args: map[string]any{"limit": nil}, want: 20},
		{name: "default boundary", args: map[string]any{"limit": 20}, want: 20},
		{name: "cap", args: map[string]any{"limit": 80}, want: 50},
		{name: "zero", args: map[string]any{"limit": 0}, want: 0},
		{name: "negative", args: map[string]any{"limit": -4}, want: -4},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := notificationTake(tc.args)
			if err != nil {
				t.Fatalf("notificationTake() error = %v", err)
			}
			if got != tc.want {
				t.Fatalf("notificationTake() = %d, want %d", got, tc.want)
			}
		})
	}
}
