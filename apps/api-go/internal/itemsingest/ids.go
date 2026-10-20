package itemsingest

import (
	"crypto/rand"
	"encoding/hex"
)

// newRowID builds a Prisma-cuid-shaped identifier (c + 24 hex characters), the
// same shape the other Go migrations write for client-generated cuid columns.
func newRowID() string {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "c00000000000000000000000"
	}
	return "c" + hex.EncodeToString(buffer[:])
}

// newUUIDv4 builds a canonical random UUID v4, the shape randomUUID() produces
// for the crawl-import ItemMeta ids.
func newUUIDv4() string {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return newRowID()
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	value := hex.EncodeToString(buffer[:])
	return value[0:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:32]
}
