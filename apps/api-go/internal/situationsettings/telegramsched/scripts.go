package telegramsched

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// The embedded files are the official BullMQ 5.63.2 commands expanded exactly
// as the npm package ships them. See scripts/NOTICE.md for version, source,
// license and SHA-256 digests. No script is downloaded at runtime.
//
//go:embed scripts/*.lua
var scriptFiles embed.FS

// scriptDigests pins the vendored bytes so an accidental edit (or a partial
// vendoring) fails the unit test instead of silently changing the shared
// bull:situationMonitorSignals:* state.
var scriptDigests = map[string]string{
	"addJobScheduler-11.lua":   "76ef53583f09baeb53599e1b49f61317e3dc195c149721cbd86a02e72a3cfad3",
	"addStandardJob-9.lua":     "9e2e57d86565bcc3d16634449c11d52317299ab9895a19ca50e6619164da675e",
	"removeJob-2.lua":          "8eb5cf906f29e65df42e30580ce416eb18791b1684f9a8ced6d8c799f3f9ab7a",
	"removeJobScheduler-3.lua": "98c40c2f329d9bad5499d23856fa3e8189df77cda8e92a8e97c66555497920b3",
	"removeRepeatable-3.lua":   "482a7f1c8b6c9a101dbec680f36c65dbb37af71065bde67e04028cee18c906cf",
}

// schedulerScripts holds the loaded Lua commands.
type schedulerScripts struct {
	addJobScheduler    *redis.Script
	addStandardJob     *redis.Script
	removeJob          *redis.Script
	removeJobScheduler *redis.Script
	removeRepeatable   *redis.Script
}

func loadScripts() (schedulerScripts, error) {
	load := func(name string) (*redis.Script, error) {
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			return nil, fmt.Errorf("telegramsched: read embedded script %s: %w", name, err)
		}
		if len(content) == 0 {
			return nil, fmt.Errorf("telegramsched: embedded script %s is empty", name)
		}
		return redis.NewScript(string(content)), nil
	}
	var scripts schedulerScripts
	var err error
	if scripts.addJobScheduler, err = load("addJobScheduler-11.lua"); err != nil {
		return schedulerScripts{}, err
	}
	if scripts.addStandardJob, err = load("addStandardJob-9.lua"); err != nil {
		return schedulerScripts{}, err
	}
	if scripts.removeJob, err = load("removeJob-2.lua"); err != nil {
		return schedulerScripts{}, err
	}
	if scripts.removeJobScheduler, err = load("removeJobScheduler-3.lua"); err != nil {
		return schedulerScripts{}, err
	}
	if scripts.removeRepeatable, err = load("removeRepeatable-3.lua"); err != nil {
		return schedulerScripts{}, err
	}
	return scripts, nil
}

// scriptSHA256 is used by the digest test.
func scriptSHA256(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}
