package telegramclient

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
)

// AuthKeySize is the size of an MTProto authorization key in bytes.
const AuthKeySize = 256

const (
	// sessionStringVersion is CURRENT_VERSION in GramJS sessions/StringSession.js.
	sessionStringVersion = "1"

	// telethonSessionBase64Length is the length of the base64 payload after the
	// version character of a legacy Telethon session string. GramJS switches on
	// this exact string length (not on the decoded payload length), so we do too.
	telethonSessionBase64Length = 352

	// rawIPv6AddressThreshold mirrors the GramJS branch that treats the first
	// int16BE of the payload as a raw 16-byte IPv6 address when the value read as
	// a signed int16 is greater than 100.
	rawIPv6AddressThreshold = 100

	ipv4AddressSize = 4
	ipv6AddressSize = 16
)

// Session is the decoded GramJS 2.26.22 StringSession payload.
//
// It carries exactly the data GramJS persists in a session string: the DC id,
// the MTProto server host, the port and the 256-byte authorization key. It is
// intentionally independent of gotd's session.Data so that the codec can be
// implemented and tested with the standard library only.
type Session struct {
	// DC is the Telegram data center id; one byte in the wire format.
	DC int
	// Address is the server host only (no port); UTF-8 bytes as stored in the
	// string. For legacy raw-IPv6 payloads it holds the hex form that the GramJS
	// decoder produces (for example "2001:b28:f23d:f001::a").
	Address string
	// Port is the MTProto server port; read as a signed int16BE by GramJS.
	Port int
	// AuthKey is the MTProto authorization key; exactly AuthKeySize bytes.
	AuthKey []byte
}

// IsZero reports whether the session is the zero value, which the client treats
// as "no authorization key yet" (a fresh, unauthenticated temporary session).
func (s Session) IsZero() bool {
	return s.DC == 0 && s.Address == "" && s.Port == 0 && len(s.AuthKey) == 0
}

// DecodeStringSession decodes a GramJS 2.26.22 StringSession string.
//
// It mirrors the StringSession constructor byte for byte: the leading "1"
// version character is required, the rest must be standard base64 (with
// padding), and the decoded payload is dcId(1) || address || port || authKey.
// The address section has three shapes, all reproduced here:
//
//   - standard save() layout: len(addr) as signed int16BE, then len UTF-8 bytes;
//   - Telethon legacy layout (base64 payload length == 352 after the version
//     character): four raw IPv4 bytes and no length field;
//   - raw IPv6 layout (the signed int16 length reads > 100): sixteen raw address
//     bytes at the same position, formatted exactly like the GramJS decoder.
//
// Unlike the JavaScript constructor, the auth key length is validated (it must
// be AuthKeySize bytes); GramJS rejects such keys later, during key setup.
func DecodeStringSession(raw string) (Session, error) {
	if raw == "" || raw[0] != sessionStringVersion[0] {
		return Session{}, fmt.Errorf("telegramclient: invalid session string: missing %q version prefix", sessionStringVersion)
	}
	encoded := raw[1:]
	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return Session{}, fmt.Errorf("telegramclient: invalid session string: base64: %w", err)
	}

	r := &sessionReader{data: payload}
	dcByte, err := r.readUint8()
	if err != nil {
		return Session{}, fmt.Errorf("telegramclient: invalid session string: %w", err)
	}

	var address string
	if len(encoded) == telethonSessionBase64Length {
		// Legacy Telethon format: raw IPv4 address, no length field.
		ipv4, err := r.read(ipv4AddressSize)
		if err != nil {
			return Session{}, fmt.Errorf("telegramclient: invalid session string: telethon address: %w", err)
		}
		address = fmt.Sprintf("%d.%d.%d.%d", ipv4[0], ipv4[1], ipv4[2], ipv4[3])
	} else {
		addressLength, err := r.readInt16()
		if err != nil {
			return Session{}, fmt.Errorf("telegramclient: invalid session string: address length: %w", err)
		}
		if addressLength > rawIPv6AddressThreshold {
			// The length field read as an int16 is really the first two address
			// bytes; rewind and consume sixteen raw bytes.
			r.back(2)
			rawIPv6, err := r.read(ipv6AddressSize)
			if err != nil {
				return Session{}, fmt.Errorf("telegramclient: invalid session string: raw IPv6 address: %w", err)
			}
			address = formatRawIPv6Address(rawIPv6)
		} else {
			if addressLength < 0 {
				return Session{}, fmt.Errorf("telegramclient: invalid session string: negative address length %d", addressLength)
			}
			addrBytes, err := r.read(addressLength)
			if err != nil {
				return Session{}, fmt.Errorf("telegramclient: invalid session string: address: %w", err)
			}
			// Keep the raw bytes: GramJS decodes them as UTF-8, which is lossy for
			// invalid sequences, while Go's conversion preserves them so that a
			// decode/encode round trip stays byte-identical.
			address = string(addrBytes)
		}
	}

	port, err := r.readInt16()
	if err != nil {
		return Session{}, fmt.Errorf("telegramclient: invalid session string: port: %w", err)
	}

	authKey := r.rest()
	if len(authKey) != AuthKeySize {
		return Session{}, fmt.Errorf("telegramclient: invalid session string: auth key is %d bytes, want %d", len(authKey), AuthKeySize)
	}

	return Session{
		DC:      int(dcByte),
		Address: address,
		Port:    port,
		AuthKey: authKey, // already a fresh slice owned by the caller
	}, nil
}

// EncodeStringSession encodes a session exactly like StringSession.save():
// the "1" version character followed by standard base64 (with padding) of
//
//	dcId(1) || len(addr) int16BE || addr UTF-8 || port int16BE || authKey(256)
//
// The zero value cannot be encoded, mirroring save() returning an empty string.
func EncodeStringSession(s Session) (string, error) {
	if s.IsZero() {
		return "", fmt.Errorf("telegramclient: cannot encode an empty session")
	}
	if s.DC < 1 || s.DC > 255 {
		return "", fmt.Errorf("telegramclient: cannot encode session: DC %d is not a single byte", s.DC)
	}
	if s.Address == "" {
		return "", fmt.Errorf("telegramclient: cannot encode session: empty address")
	}
	addressBytes := []byte(s.Address)
	if len(addressBytes) > rawIPv6AddressThreshold {
		// GramJS save() would emit such a string, but its own decoder reads a
		// length above 100 as the raw IPv6 form, so the result could never be
		// loaded again. Real DC hosts are far below the limit.
		return "", fmt.Errorf("telegramclient: cannot encode session: address is %d bytes, max %d", len(addressBytes), rawIPv6AddressThreshold)
	}
	if s.Port <= 0 || s.Port > 32767 {
		return "", fmt.Errorf("telegramclient: cannot encode session: port %d is outside the signed int16 range", s.Port)
	}
	if len(s.AuthKey) != AuthKeySize {
		return "", fmt.Errorf("telegramclient: cannot encode session: auth key is %d bytes, want %d", len(s.AuthKey), AuthKeySize)
	}

	payload := make([]byte, 0, 1+2+len(addressBytes)+2+AuthKeySize)
	payload = append(payload, byte(s.DC))
	payload = binary.BigEndian.AppendUint16(payload, uint16(len(addressBytes)))
	payload = append(payload, addressBytes...)
	payload = binary.BigEndian.AppendUint16(payload, uint16(s.Port))
	payload = append(payload, s.AuthKey...)

	// A one-, two- or three-byte host would produce the legacy Telethon base64
	// length (352), which every GramJS decoder - including ours - reads as a raw
	// IPv4 address instead of the standard layout. Reject it so that every
	// string this function returns decodes back to the same Session.
	if base64.StdEncoding.EncodedLen(len(payload)) == telethonSessionBase64Length {
		return "", fmt.Errorf("telegramclient: cannot encode session: host %q would produce an ambiguous Telethon-length string", s.Address)
	}

	return sessionStringVersion + base64.StdEncoding.EncodeToString(payload), nil
}

// formatRawIPv6Address mirrors the GramJS decoder's formatting of a raw
// sixteen-byte address: four lowercase hex digits per group, leading zeros of
// each group stripped, groups joined with ":", then any run of two or more
// colons collapsed into "::".
//
// The JavaScript code also applies /0000:/ -> ":" after stripping. That
// replacement is unreachable (a group that would be "0000" is stripped to the
// empty string first), so it is intentionally omitted.
func formatRawIPv6Address(raw []byte) string {
	hexAddress := hex.EncodeToString(raw)
	groups := make([]string, 0, len(hexAddress)/4)
	for i := 0; i < len(hexAddress); i += 4 {
		groups = append(groups, strings.TrimLeft(hexAddress[i:i+4], "0"))
	}
	joined := strings.Join(groups, ":")

	var b strings.Builder
	b.Grow(len(joined))
	for i := 0; i < len(joined); {
		if joined[i] != ':' {
			b.WriteByte(joined[i])
			i++
			continue
		}
		end := i
		for end < len(joined) && joined[end] == ':' {
			end++
		}
		if end-i >= 2 {
			b.WriteString("::")
		} else {
			b.WriteByte(':')
		}
		i = end
	}
	return b.String()
}

// sessionReader is a bounds-checked cursor over a decoded session payload. It
// mirrors the subset of GramJS BinaryReader used by StringSession.
type sessionReader struct {
	data []byte
	off  int
}

func (r *sessionReader) readUint8() (byte, error) {
	b, err := r.read(1)
	if err != nil {
		return 0, err
	}
	return b[0], nil
}

func (r *sessionReader) readInt16() (int, error) {
	b, err := r.read(2)
	if err != nil {
		return 0, err
	}
	return int(int16(binary.BigEndian.Uint16(b))), nil
}

func (r *sessionReader) read(n int) ([]byte, error) {
	if n < 0 || r.off+n > len(r.data) {
		return nil, fmt.Errorf("truncated payload: need %d bytes at offset %d of %d", n, r.off, len(r.data))
	}
	out := r.data[r.off : r.off+n]
	r.off += n
	return out, nil
}

func (r *sessionReader) back(n int) {
	r.off -= n
	if r.off < 0 {
		r.off = 0
	}
}

func (r *sessionReader) rest() []byte {
	out := r.data[r.off:]
	r.off = len(r.data)
	return out
}
