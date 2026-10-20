package telegramclient

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"
)

// The fixtures below were produced by re-running the exact GramJS 2.26.22
// StringSession.js constructor and save() code under Node.js with a fixed
// deterministic 256-byte key, so the expected bytes are the JavaScript
// behaviour and not a re-derivation from the Go implementation.
const (
	// fixtureAuthKeyHex is the fixed 256-byte authorization key used by every
	// fixture.
	fixtureAuthKeyHex = "aa09e3d3186053e76df660eb4d02466d8644dfc078e9bb084f367de636e14c091d3c0befd5aaa710472d30e002e5bf8c75a6b5818f82a706518b5b00280f2a129ad8ae568b624a121e934f74ea0b96de3ab6009b4ed5ce80c80b2e43cf060dc9a714c91e9b06fe29c1de9ce63af79ed63069fa6752485244d053652d6a4af5e1dfecc122f1fb89af5f360c48e9f06ea34f78b3046ccdcf8c83c76fdad0dd5256efca722cc7f93e3fa8238d3600f1c7042ee2eb253b6b40561884e597c52dda49d0503094f6479218874aa2b219441173e207b39c28fc968226b9dce8bf8bda597b93f1d2ce46e0592ad7023882b48043959d1a3a25e5f13fdec4ad822f0a457f"

	// ipv4SessionString is a standard StringSession.save() string: DC 2,
	// address "149.154.167.51", port 443.
	ipv4SessionString = "1AgAOMTQ5LjE1NC4xNjcuNTEBu6oJ49MYYFPnbfZg600CRm2GRN/AeOm7CE82feY24UwJHTwL79WqpxBHLTDgAuW/jHWmtYGPgqcGUYtbACgPKhKa2K5Wi2JKEh6TT3TqC5beOrYAm07VzoDICy5DzwYNyacUyR6bBv4pwd6c5jr3ntYwafpnUkhSRNBTZS1qSvXh3+zBIvH7ia9fNgxI6fBuo094swRszc+Mg8dv2tDdUlbvynIsx/k+P6gjjTYA8ccELuLrJTtrQFYYhOWXxS3aSdBQMJT2R5IYh0qishlEEXPiB7OcKPyWgia53Oi/i9pZe5Px0s5G4Fkq1wI4grSAQ5WdGjol5fE/3sStgi8KRX8="

	// ipv6TextSessionString is a standard StringSession.save() string whose
	// host is a textual IPv6 address: DC 2, "2001:b28:f23d:f001::a", port 443.
	ipv6TextSessionString = "1AgAVMjAwMTpiMjg6ZjIzZDpmMDAxOjphAbuqCePTGGBT5232YOtNAkZthkTfwHjpuwhPNn3mNuFMCR08C+/VqqcQRy0w4ALlv4x1prWBj4KnBlGLWwAoDyoSmtiuVotiShIek0906guW3jq2AJtO1c6AyAsuQ88GDcmnFMkemwb+KcHenOY6957WMGn6Z1JIUkTQU2Utakr14d/swSLx+4mvXzYMSOnwbqNPeLMEbM3PjIPHb9rQ3VJW78pyLMf5Pj+oI402APHHBC7i6yU7a0BWGITll8Ut2knQUDCU9keSGIdKorIZRBFz4geznCj8loImudzov4vaWXuT8dLORuBZKtcCOIK0gEOVnRo6JeXxP97ErYIvCkV/"

	// telethonSessionString is a legacy Telethon string (base64 payload length
	// exactly 352): DC 4, raw IPv4 bytes 149.154.167.91, port 443.
	telethonSessionString = "1BJWap1sBu6oJ49MYYFPnbfZg600CRm2GRN/AeOm7CE82feY24UwJHTwL79WqpxBHLTDgAuW/jHWmtYGPgqcGUYtbACgPKhKa2K5Wi2JKEh6TT3TqC5beOrYAm07VzoDICy5DzwYNyacUyR6bBv4pwd6c5jr3ntYwafpnUkhSRNBTZS1qSvXh3+zBIvH7ia9fNgxI6fBuo094swRszc+Mg8dv2tDdUlbvynIsx/k+P6gjjTYA8ccELuLrJTtrQFYYhOWXxS3aSdBQMJT2R5IYh0qishlEEXPiB7OcKPyWgia53Oi/i9pZe5Px0s5G4Fkq1wI4grSAQ5WdGjol5fE/3sStgi8KRX8="

	// telethonResavedSessionString is what GramJS save() emits after decoding
	// telethonSessionString: the raw IPv4 address is re-encoded as a textual
	// host, which is why decode/encode of the Telethon shape is intentionally
	// not byte-identical.
	telethonResavedSessionString = "1BAAOMTQ5LjE1NC4xNjcuOTEBu6oJ49MYYFPnbfZg600CRm2GRN/AeOm7CE82feY24UwJHTwL79WqpxBHLTDgAuW/jHWmtYGPgqcGUYtbACgPKhKa2K5Wi2JKEh6TT3TqC5beOrYAm07VzoDICy5DzwYNyacUyR6bBv4pwd6c5jr3ntYwafpnUkhSRNBTZS1qSvXh3+zBIvH7ia9fNgxI6fBuo094swRszc+Mg8dv2tDdUlbvynIsx/k+P6gjjTYA8ccELuLrJTtrQFYYhOWXxS3aSdBQMJT2R5IYh0qishlEEXPiB7OcKPyWgia53Oi/i9pZe5Px0s5G4Fkq1wI4grSAQ5WdGjol5fE/3sStgi8KRX8="

	// rawIPv6SessionString uses the raw IPv6 branch: the two leading address
	// bytes are 0x20 0x01, so the signed int16 length reads 8193 > 100 and the
	// decoder consumes sixteen raw address bytes instead.
	rawIPv6SessionString = "1AiABCyjyPfABAAAAAAAAAAoBu6oJ49MYYFPnbfZg600CRm2GRN/AeOm7CE82feY24UwJHTwL79WqpxBHLTDgAuW/jHWmtYGPgqcGUYtbACgPKhKa2K5Wi2JKEh6TT3TqC5beOrYAm07VzoDICy5DzwYNyacUyR6bBv4pwd6c5jr3ntYwafpnUkhSRNBTZS1qSvXh3+zBIvH7ia9fNgxI6fBuo094swRszc+Mg8dv2tDdUlbvynIsx/k+P6gjjTYA8ccELuLrJTtrQFYYhOWXxS3aSdBQMJT2R5IYh0qishlEEXPiB7OcKPyWgia53Oi/i9pZe5Px0s5G4Fkq1wI4grSAQ5WdGjol5fE/3sStgi8KRX8="
)

func fixtureAuthKey(t *testing.T) []byte {
	t.Helper()
	key, err := hex.DecodeString(fixtureAuthKeyHex)
	if err != nil {
		t.Fatalf("decode fixture key: %v", err)
	}
	if len(key) != AuthKeySize {
		t.Fatalf("fixture key is %d bytes, want %d", len(key), AuthKeySize)
	}
	return key
}

func TestDecodeStringSession(t *testing.T) {
	key := fixtureAuthKey(t)
	tests := []struct {
		name string
		raw  string
		want Session
	}{
		{
			name: "ipv4 save format",
			raw:  ipv4SessionString,
			want: Session{DC: 2, Address: "149.154.167.51", Port: 443, AuthKey: key},
		},
		{
			name: "ipv6 textual save format",
			raw:  ipv6TextSessionString,
			want: Session{DC: 2, Address: "2001:b28:f23d:f001::a", Port: 443, AuthKey: key},
		},
		{
			name: "telethon legacy raw ipv4",
			raw:  telethonSessionString,
			want: Session{DC: 4, Address: "149.154.167.91", Port: 443, AuthKey: key},
		},
		{
			name: "raw ipv6 payload",
			raw:  rawIPv6SessionString,
			want: Session{DC: 2, Address: "2001:b28:f23d:f001::a", Port: 443, AuthKey: key},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := DecodeStringSession(tt.raw)
			if err != nil {
				t.Fatalf("DecodeStringSession() error = %v", err)
			}
			if got.DC != tt.want.DC {
				t.Errorf("DC = %d, want %d", got.DC, tt.want.DC)
			}
			if got.Address != tt.want.Address {
				t.Errorf("Address = %q, want %q", got.Address, tt.want.Address)
			}
			if got.Port != tt.want.Port {
				t.Errorf("Port = %d, want %d", got.Port, tt.want.Port)
			}
			if !bytes.Equal(got.AuthKey, tt.want.AuthKey) {
				t.Errorf("AuthKey = %x, want %x", got.AuthKey, tt.want.AuthKey)
			}
		})
	}
}

func TestStringSessionRoundTrip(t *testing.T) {
	// Save()-format strings must survive decode -> encode byte-identically.
	for _, raw := range []string{ipv4SessionString, ipv6TextSessionString} {
		session, err := DecodeStringSession(raw)
		if err != nil {
			t.Fatalf("DecodeStringSession(%q) error = %v", raw[:12], err)
		}
		encoded, err := EncodeStringSession(session)
		if err != nil {
			t.Fatalf("EncodeStringSession() error = %v", err)
		}
		if encoded != raw {
			t.Errorf("round trip changed the string:\n got %q\nwant %q", encoded, raw)
		}
	}
}

func TestRawIPv6PayloadResavesAsTextualHost(t *testing.T) {
	// The raw IPv6 shape is a decode-only legacy input: GramJS save() always
	// writes the textual host, so the re-encoded string differs from the input
	// but matches the standard save()-format fixture for the same session.
	session, err := DecodeStringSession(rawIPv6SessionString)
	if err != nil {
		t.Fatalf("DecodeStringSession() error = %v", err)
	}
	encoded, err := EncodeStringSession(session)
	if err != nil {
		t.Fatalf("EncodeStringSession() error = %v", err)
	}
	if encoded != ipv6TextSessionString {
		t.Errorf("encoded raw IPv6 session = %q, want %q", encoded, ipv6TextSessionString)
	}
}

func TestStringSessionTelethonRoundTrip(t *testing.T) {
	// The Telethon shape cannot round-trip byte-identically because GramJS
	// save() always writes the textual host. Assert the JS save() output instead.
	session, err := DecodeStringSession(telethonSessionString)
	if err != nil {
		t.Fatalf("DecodeStringSession() error = %v", err)
	}
	encoded, err := EncodeStringSession(session)
	if err != nil {
		t.Fatalf("EncodeStringSession() error = %v", err)
	}
	if encoded != telethonResavedSessionString {
		t.Errorf("encoded Telethon session = %q, want %q", encoded, telethonResavedSessionString)
	}

	// The re-encoded form decodes back to the same session.
	redecoded, err := DecodeStringSession(encoded)
	if err != nil {
		t.Fatalf("DecodeStringSession(resaved) error = %v", err)
	}
	if redecoded.DC != session.DC || redecoded.Address != session.Address || redecoded.Port != session.Port || !bytes.Equal(redecoded.AuthKey, session.AuthKey) {
		t.Errorf("redecoded session = %+v, want %+v", redecoded, session)
	}
}

func TestEncodeStringSession(t *testing.T) {
	key := fixtureAuthKey(t)
	encoded, err := EncodeStringSession(Session{DC: 2, Address: "149.154.167.51", Port: 443, AuthKey: key})
	if err != nil {
		t.Fatalf("EncodeStringSession() error = %v", err)
	}
	if encoded != ipv4SessionString {
		t.Errorf("encoded = %q, want %q", encoded, ipv4SessionString)
	}
}

func TestEncodeStringSessionErrors(t *testing.T) {
	key := fixtureAuthKey(t)
	valid := Session{DC: 2, Address: "149.154.167.51", Port: 443, AuthKey: key}
	tests := []struct {
		name    string
		session Session
	}{
		{name: "zero value", session: Session{}},
		{name: "dc zero", session: func() Session { s := valid; s.DC = 0; return s }()},
		{name: "dc too large", session: func() Session { s := valid; s.DC = 256; return s }()},
		{name: "empty address", session: func() Session { s := valid; s.Address = ""; return s }()},
		{name: "address too long", session: func() Session { s := valid; s.Address = strings.Repeat("a", 101); return s }()},
		{name: "address one byte is ambiguous with telethon length", session: func() Session { s := valid; s.Address = "a"; return s }()},
		{name: "address two bytes is ambiguous with telethon length", session: func() Session { s := valid; s.Address = "ab"; return s }()},
		{name: "address three bytes is ambiguous with telethon length", session: func() Session { s := valid; s.Address = "abc"; return s }()},
		{name: "port zero", session: func() Session { s := valid; s.Port = 0; return s }()},
		{name: "port negative", session: func() Session { s := valid; s.Port = -1; return s }()},
		{name: "port too large", session: func() Session { s := valid; s.Port = 1 << 15; return s }()},
		{name: "nil auth key", session: func() Session { s := valid; s.AuthKey = nil; return s }()},
		{name: "short auth key", session: func() Session { s := valid; s.AuthKey = key[:255]; return s }()},
		{name: "long auth key", session: func() Session { s := valid; s.AuthKey = append(append([]byte{}, key...), 0); return s }()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := EncodeStringSession(tt.session); err == nil {
				t.Error("EncodeStringSession() error = nil, want error")
			}
		})
	}
}

func TestDecodeStringSessionErrors(t *testing.T) {
	key := fixtureAuthKey(t)
	encodePayload := func(payload []byte) string {
		return sessionStringVersion + base64.StdEncoding.EncodeToString(payload)
	}
	t.Run("empty string", func(t *testing.T) {
		if _, err := DecodeStringSession(""); err == nil {
			t.Error("DecodeStringSession(\"\") error = nil, want error")
		}
	})
	t.Run("missing version prefix", func(t *testing.T) {
		if _, err := DecodeStringSession("2" + ipv4SessionString[1:]); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("invalid base64", func(t *testing.T) {
		if _, err := DecodeStringSession("1!!!!"); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("base64 without padding", func(t *testing.T) {
		if _, err := DecodeStringSession(strings.TrimRight(ipv4SessionString, "=")); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("empty payload", func(t *testing.T) {
		if _, err := DecodeStringSession(sessionStringVersion); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("truncated address", func(t *testing.T) {
		raw := encodePayload([]byte{2, 0, 40})
		if _, err := DecodeStringSession(raw); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("negative address length", func(t *testing.T) {
		raw := encodePayload([]byte{2, 0xff, 0xff, 1, 2, 3})
		if _, err := DecodeStringSession(raw); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("truncated raw ipv6 address", func(t *testing.T) {
		// The signed int16 length reads as 0x2001 (8193 > 100), selecting the raw
		// IPv6 branch, but the payload has no room for sixteen address bytes.
		raw := encodePayload([]byte{2, 0x20, 0x01, 0x0b, 0x28})
		if _, err := DecodeStringSession(raw); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("truncated port", func(t *testing.T) {
		payload := []byte{2, 0, 1, 'a'}
		raw := encodePayload(payload)
		if _, err := DecodeStringSession(raw); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("wrong auth key size", func(t *testing.T) {
		payload := binary.BigEndian.AppendUint16([]byte{2}, 1)
		payload = append(payload, 'a')
		payload = binary.BigEndian.AppendUint16(payload, 443)
		payload = append(payload, key[:255]...)
		raw := encodePayload(payload)
		if _, err := DecodeStringSession(raw); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
	t.Run("telethon short auth key", func(t *testing.T) {
		// A 352-character base64 payload selects the Telethon branch. 262 bytes
		// decode from 352 base64 characters (two padding bytes), so after the
		// four raw IPv4 bytes and the port only 255 key bytes remain.
		payload := make([]byte, 262)
		payload[0] = 4
		raw := encodePayload(payload)
		if len(raw)-1 != telethonSessionBase64Length {
			t.Fatalf("fixture base64 length = %d, want %d", len(raw)-1, telethonSessionBase64Length)
		}
		if _, err := DecodeStringSession(raw); err == nil {
			t.Error("DecodeStringSession() error = nil, want error")
		}
	})
}

func TestSessionIsZero(t *testing.T) {
	if !(Session{}).IsZero() {
		t.Error("zero Session.IsZero() = false, want true")
	}
	if (Session{DC: 2}).IsZero() {
		t.Error("Session{DC: 2}.IsZero() = true, want false")
	}
}

// FuzzDecodeStringSession checks that arbitrary input never panics and that a
// successful decode whose session can be re-encoded decodes back to the same
// values.
func FuzzDecodeStringSession(f *testing.F) {
	f.Add("")
	f.Add("2")
	f.Add(ipv4SessionString)
	f.Add(ipv6TextSessionString)
	f.Add(telethonSessionString)
	f.Add(rawIPv6SessionString)
	f.Add("1!!!!")
	f.Fuzz(func(t *testing.T, raw string) {
		session, err := DecodeStringSession(raw)
		if err != nil {
			return
		}
		encoded, err := EncodeStringSession(session)
		if err != nil {
			return
		}
		redecoded, err := DecodeStringSession(encoded)
		if err != nil {
			t.Fatalf("DecodeStringSession(EncodeStringSession(session)) error = %v", err)
		}
		if redecoded.DC != session.DC || redecoded.Address != session.Address || redecoded.Port != session.Port || !bytes.Equal(redecoded.AuthKey, session.AuthKey) {
			t.Fatalf("redecoded = %+v, want %+v", redecoded, session)
		}
	})
}
