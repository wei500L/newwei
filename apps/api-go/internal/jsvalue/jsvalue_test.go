package jsvalue

import "testing"

func TestString(t *testing.T) {
	if got := String("hello"); got != "hello" {
		t.Fatalf("String(string) = %q", got)
	}
	if got := String(42); got != "" {
		t.Fatalf("String(non-string) = %q, want empty", got)
	}
	if got := String(nil); got != "" {
		t.Fatalf("String(nil) = %q, want empty", got)
	}
}

func TestInt(t *testing.T) {
	cases := []struct {
		in   any
		want int
	}{
		{7, 7},
		{int32(8), 8},
		{int64(9), 9},
		{3.9, 3},
		{"10", 0},
		{nil, 0},
	}
	for _, tc := range cases {
		if got := Int(tc.in); got != tc.want {
			t.Errorf("Int(%v) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
