package realtimeevents

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/vmihailenco/msgpack/v5"
	"github.com/vmihailenco/msgpack/v5/msgpcode"
)

// This file implements the wire format of @socket.io/redis-adapter 8.3.0 for
// the newsnow namespace, byte-compatible with the NestJS side:
//
//	PUBLISH "<adapterKey>#/newsnow#[<room>#]" <notepack msgpack>
//	msgpack = [ uid(string), packet(map), opts(map) ]
//	packet  = { type: 2, data: [eventName, payload], nsp: "/newsnow" }
//	opts    = { rooms: [string], except: [string], flags: {} }
//
// A single-room broadcast is published on "<key>#<nsp>#<room>#"; a broadcast
// with zero or several rooms uses the base channel and carries the room list in
// opts. The publisher must publish even when this process owns no socket (the
// NestJS adapter does the same: broadcast() has no local-room gate and only
// skips the publish for flags.local), which is why the newsnow refresh path
// publishes first and then pushes locally.

const adapterUIDAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// randomAdapterUID returns the 6 character URL-safe id @socket.io/redis-adapter
// generates with uid2(6). It only has to be unique enough to skip our own
// messages; collisions with a NestJS instance are harmless.
func randomAdapterUID() (string, error) {
	var buffer [6]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	out := make([]byte, len(buffer))
	for index, value := range buffer {
		out[index] = adapterUIDAlphabet[int(value)%len(adapterUIDAlphabet)]
	}
	return string(out), nil
}

// adapterChannel builds the broadcast channel for one namespace and room. An
// empty room is the base channel used for whole-namespace or multi-room
// broadcasts.
func adapterChannel(adapterKey, namespace, room string) string {
	channel := adapterKey + "#" + namespace + "#"
	if room != "" {
		channel += room + "#"
	}
	return channel
}

// adapterPattern is the pattern subscription of the NestJS adapter:
// psubscribe "<key>#<nsp>#*" (base and every single-room channel).
func adapterPattern(adapterKey, namespace string) string {
	return adapterKey + "#" + namespace + "#*"
}

// adapterMessage is one decoded broadcast message.
type adapterMessage struct {
	UID       string
	Namespace string
	Event     string
	// PayloadJSON is the payload argument converted to JSON while preserving
	// the msgpack map order (NestJS JSON.stringify keeps the object insertion
	// order the msgpack decoder produced).
	PayloadJSON json.RawMessage
	Rooms       []string
	Except      []string
}

// adapterValueKind is the msgpack value kind used by the ordered decoder.
type adapterValueKind uint8

const (
	adapterKindNull adapterValueKind = iota
	adapterKindBool
	adapterKindNumber
	adapterKindString
	adapterKindArray
	adapterKindObject
	adapterKindTime
	adapterKindBinary
)

type adapterValue struct {
	kind    adapterValueKind
	boolean bool
	number  float64
	text    string
	array   []adapterValue
	object  []adapterField
	stamp   time.Time
	binary  []byte
}

type adapterField struct {
	key   string
	value adapterValue
}

// decodeAdapterMessage decodes one notepack payload published by the NestJS
// Redis adapter. It is strict: unknown ext types, non-string map keys, a non
// array payload, a packet type other than EVENT and a missing event name are
// protocol errors and the caller drops the message.
func decodeAdapterMessage(payload []byte) (adapterMessage, error) {
	reader := bytes.NewReader(payload)
	decoder := msgpack.NewDecoder(reader)
	count, err := decoder.DecodeArrayLen()
	if err != nil {
		return adapterMessage{}, fmt.Errorf("realtimeevents: adapter envelope: %w", err)
	}
	if count != 3 {
		return adapterMessage{}, fmt.Errorf("realtimeevents: adapter envelope has %d elements, want 3", count)
	}
	uid, err := decoder.DecodeString()
	if err != nil {
		return adapterMessage{}, fmt.Errorf("realtimeevents: adapter uid: %w", err)
	}
	packet, err := decodeAdapterValue(decoder)
	if err != nil {
		return adapterMessage{}, err
	}
	opts, err := decodeAdapterValue(decoder)
	if err != nil {
		return adapterMessage{}, err
	}
	if reader.Len() != 0 {
		return adapterMessage{}, fmt.Errorf("realtimeevents: adapter message has %d trailing bytes", reader.Len())
	}
	if packet.kind != adapterKindObject || opts.kind != adapterKindObject {
		return adapterMessage{}, errors.New("realtimeevents: adapter packet/opts are not objects")
	}

	packetType, ok := packet.objectNumber("type")
	if !ok || int(packetType) != 2 {
		return adapterMessage{}, fmt.Errorf("realtimeevents: adapter packet type %v is not EVENT", packetType)
	}
	namespace, _ := packet.objectString("nsp")
	if namespace == "" {
		namespace = "/"
	}
	data, ok := packet.objectField("data")
	if !ok || data.kind != adapterKindArray || len(data.array) < 2 {
		return adapterMessage{}, errors.New("realtimeevents: adapter packet data is not [event, payload]")
	}
	event, ok := data.array[0].asString()
	if !ok || event == "" {
		return adapterMessage{}, errors.New("realtimeevents: adapter event name is missing")
	}
	if len(data.array) != 2 {
		return adapterMessage{}, fmt.Errorf("realtimeevents: adapter event %q has %d arguments, want 1 payload", event, len(data.array)-1)
	}
	payloadJSON, err := data.array[1].jsonBytes()
	if err != nil {
		return adapterMessage{}, fmt.Errorf("realtimeevents: adapter payload: %w", err)
	}
	rooms, err := opts.objectStringSlice("rooms")
	if err != nil {
		return adapterMessage{}, err
	}
	except, err := opts.objectStringSlice("except")
	if err != nil {
		return adapterMessage{}, err
	}
	return adapterMessage{
		UID:         uid,
		Namespace:   namespace,
		Event:       event,
		PayloadJSON: payloadJSON,
		Rooms:       rooms,
		Except:      except,
	}, nil
}

// decodeAdapterValue reads one msgpack value into the ordered tree.
func decodeAdapterValue(decoder *msgpack.Decoder) (adapterValue, error) {
	code, err := decoder.PeekCode()
	if err != nil {
		return adapterValue{}, err
	}
	switch {
	case code == msgpcode.Nil:
		if err := decoder.DecodeNil(); err != nil {
			return adapterValue{}, err
		}
		return adapterValue{kind: adapterKindNull}, nil
	case code == msgpcode.False || code == msgpcode.True:
		value, err := decoder.DecodeBool()
		if err != nil {
			return adapterValue{}, err
		}
		return adapterValue{kind: adapterKindBool, boolean: value}, nil
	case msgpcode.IsFixedNum(code) || code == msgpcode.Uint8 || code == msgpcode.Uint16 ||
		code == msgpcode.Uint32 || code == msgpcode.Uint64 || code == msgpcode.Int8 ||
		code == msgpcode.Int16 || code == msgpcode.Int32 || code == msgpcode.Int64 ||
		code == msgpcode.Float || code == msgpcode.Double:
		value, err := decoder.DecodeFloat64()
		if err != nil {
			return adapterValue{}, err
		}
		return adapterValue{kind: adapterKindNumber, number: value}, nil
	case msgpcode.IsString(code):
		value, err := decoder.DecodeString()
		if err != nil {
			return adapterValue{}, err
		}
		return adapterValue{kind: adapterKindString, text: value}, nil
	case msgpcode.IsBin(code):
		value, err := decoder.DecodeBytes()
		if err != nil {
			return adapterValue{}, err
		}
		return adapterValue{kind: adapterKindBinary, binary: value}, nil
	case msgpcode.IsFixedArray(code) || code == msgpcode.Array16 || code == msgpcode.Array32:
		count, err := decoder.DecodeArrayLen()
		if err != nil {
			return adapterValue{}, err
		}
		array := make([]adapterValue, 0, count)
		for index := 0; index < count; index++ {
			element, err := decodeAdapterValue(decoder)
			if err != nil {
				return adapterValue{}, err
			}
			array = append(array, element)
		}
		return adapterValue{kind: adapterKindArray, array: array}, nil
	case msgpcode.IsFixedMap(code) || code == msgpcode.Map16 || code == msgpcode.Map32:
		count, err := decoder.DecodeMapLen()
		if err != nil {
			return adapterValue{}, err
		}
		object := make([]adapterField, 0, count)
		for index := 0; index < count; index++ {
			key, err := decoder.DecodeString()
			if err != nil {
				return adapterValue{}, fmt.Errorf("realtimeevents: adapter map key: %w", err)
			}
			value, err := decodeAdapterValue(decoder)
			if err != nil {
				return adapterValue{}, err
			}
			object = append(object, adapterField{key: key, value: value})
		}
		return adapterValue{kind: adapterKindObject, object: object}, nil
	case msgpcode.IsExt(code):
		// notepack encodes Date as the MessagePack timestamp extension (ext id
		// -1); the vmihailenco decoder accepts the same layout (and the legacy
		// NodeJS id 13). Any other ext type has no JSON representation here.
		stamp, err := decoder.DecodeTime()
		if err != nil {
			return adapterValue{}, fmt.Errorf("realtimeevents: adapter ext value: %w", err)
		}
		return adapterValue{kind: adapterKindTime, stamp: stamp}, nil
	default:
		return adapterValue{}, fmt.Errorf("realtimeevents: unsupported msgpack code 0x%02x", code)
	}
}

func (v adapterValue) objectField(name string) (adapterValue, bool) {
	for _, field := range v.object {
		if field.key == name {
			return field.value, true
		}
	}
	return adapterValue{}, false
}

func (v adapterValue) objectString(name string) (string, bool) {
	field, ok := v.objectField(name)
	if !ok || field.kind != adapterKindString {
		return "", false
	}
	return field.text, true
}

func (v adapterValue) objectNumber(name string) (float64, bool) {
	field, ok := v.objectField(name)
	if !ok || field.kind != adapterKindNumber {
		return 0, false
	}
	return field.number, true
}

func (v adapterValue) objectStringSlice(name string) ([]string, error) {
	field, ok := v.objectField(name)
	if !ok {
		return nil, nil
	}
	if field.kind == adapterKindNull {
		return nil, nil
	}
	if field.kind != adapterKindArray {
		return nil, fmt.Errorf("realtimeevents: adapter opts.%s is not an array", name)
	}
	values := make([]string, 0, len(field.array))
	for _, element := range field.array {
		if element.kind != adapterKindString {
			return nil, fmt.Errorf("realtimeevents: adapter opts.%s contains a non-string room", name)
		}
		values = append(values, element.text)
	}
	return values, nil
}

func (v adapterValue) asString() (string, bool) {
	if v.kind != adapterKindString {
		return "", false
	}
	return v.text, true
}

// jsonBytes renders the value as JSON. Object key order follows the msgpack
// order, Date values render like Date.prototype.toJSON (ISO with milliseconds),
// and binary values are rejected because Socket.IO would send them as an
// attachment this transport does not support.
func (v adapterValue) jsonBytes() (json.RawMessage, error) {
	buffer, err := v.appendJSON(nil)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(buffer), nil
}

func (v adapterValue) appendJSON(dst []byte) ([]byte, error) {
	switch v.kind {
	case adapterKindNull:
		return append(dst, "null"...), nil
	case adapterKindBool:
		if v.boolean {
			return append(dst, "true"...), nil
		}
		return append(dst, "false"...), nil
	case adapterKindNumber:
		return append(dst, formatJSNumber(v.number)...), nil
	case adapterKindString:
		encoded, err := json.Marshal(v.text)
		if err != nil {
			return nil, err
		}
		return append(dst, encoded...), nil
	case adapterKindArray:
		dst = append(dst, '[')
		for index, element := range v.array {
			if index > 0 {
				dst = append(dst, ',')
			}
			next, err := element.appendJSON(dst)
			if err != nil {
				return nil, err
			}
			dst = next
		}
		return append(dst, ']'), nil
	case adapterKindObject:
		dst = append(dst, '{')
		for index, field := range v.object {
			if index > 0 {
				dst = append(dst, ',')
			}
			encodedKey, err := json.Marshal(field.key)
			if err != nil {
				return nil, err
			}
			dst = append(dst, encodedKey...)
			dst = append(dst, ':')
			next, err := field.value.appendJSON(dst)
			if err != nil {
				return nil, err
			}
			dst = next
		}
		return append(dst, '}'), nil
	case adapterKindTime:
		encoded, err := json.Marshal(v.stamp.UTC().Format("2006-01-02T15:04:05.000Z"))
		if err != nil {
			return nil, err
		}
		return append(dst, encoded...), nil
	case adapterKindBinary:
		return nil, errors.New("realtimeevents: binary Socket.IO payloads are not supported")
	default:
		return nil, errors.New("realtimeevents: unknown adapter value kind")
	}
}

// formatJSNumber renders a number the way JSON.stringify does for the finite
// values a msgpack number can carry.
func formatJSNumber(value float64) string {
	if value == 0 {
		// JSON.stringify(-0) is "0".
		return "0"
	}
	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return strconv.FormatFloat(value, 'f', 0, 64)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// adapterBroadcastPacket is the packet object of one broadcast message. The
// field order is irrelevant to the Node decoder but kept identical to the
// NestJS object literal for readable dumps.
type adapterBroadcastPacket struct {
	Type uint8  `msgpack:"type"`
	Data []any  `msgpack:"data"`
	Nsp  string `msgpack:"nsp"`
}

// adapterBroadcastOptions is the opts object. flags is always the empty object
// for the one-way emits used by this package.
type adapterBroadcastOptions struct {
	Rooms  []string `msgpack:"rooms"`
	Except []string `msgpack:"except"`
	Flags  struct{} `msgpack:"flags"`
}

// encodeAdapterBroadcast encodes one event broadcast for the given namespace
// and rooms. payload must be a typed struct (its field order becomes the JSON
// key order on the browser wire).
func encodeAdapterBroadcast(uid, namespace string, rooms, except []string, event string, payload any) ([]byte, error) {
	if uid == "" {
		return nil, errors.New("realtimeevents: adapter uid is empty")
	}
	if len(rooms) == 0 {
		return nil, errors.New("realtimeevents: adapter broadcast requires at least one room")
	}
	packet := adapterBroadcastPacket{
		Type: 2,
		Data: []any{event, payload},
		Nsp:  namespace,
	}
	options := adapterBroadcastOptions{
		Rooms:  rooms,
		Except: append([]string{}, except...),
	}
	// Protocol boundary: the notepack envelope is a heterogeneous 3 element
	// array, which cannot be expressed as a named struct.
	envelope := []any{uid, packet, options}
	encoded, err := msgpack.Marshal(envelope)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

// adapterMessageChannelRoom returns the room suffix encoded in a channel that
// matches the namespace pattern, or "" for the base channel. It is only used as
// a fallback when a message carries no rooms.
func adapterMessageChannelRoom(channel, adapterKey, namespace string) string {
	base := adapterKey + "#" + namespace + "#"
	if !strings.HasPrefix(channel, base) {
		return ""
	}
	room := channel[len(base):]
	if len(room) < 2 || room[len(room)-1] != '#' {
		return ""
	}
	return room[:len(room)-1]
}
