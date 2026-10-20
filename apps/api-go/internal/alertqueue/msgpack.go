package alertqueue

import "github.com/vmihailenco/msgpack/v5"

// marshalMsgpack encodes the BullMQ Lua script arguments the way the NestJS
// client does. BullMQ 5.63.2 creates its Packr with
// `{ useRecords: false, encodeUndefinedAsNil: true }` (dist/cjs/classes/
// scripts.js), so every argument is a plain MessagePack value: strings,
// integers, booleans and nil. An undefined array slot (parent, repeat job key,
// deduplication key) is written as nil, which is exactly the 0xc0 this encoder
// produces for a nil interface.
//
// Container headers are not byte-identical: msgpackr always uses a map16
// header while this encoder uses the compact fixmap/map8 form, and both use
// their own integer width selection. Redis cmsgpack decodes either form to the
// same Lua table, and the scripts only read by key, so the script observes
// identical arguments and the stored job hash fields are identical.
func marshalMsgpack(value any) ([]byte, error) {
	return msgpack.Marshal(value)
}
