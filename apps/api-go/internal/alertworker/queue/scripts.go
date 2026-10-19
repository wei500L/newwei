package queue

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
// vendoring) fails the unit test instead of silently changing the Redis state
// machine.
var scriptDigests = map[string]string{
	"addStandardJob-9.lua":        "9e2e57d86565bcc3d16634449c11d52317299ab9895a19ca50e6619164da675e",
	"addDelayedJob-6.lua":         "b2994e8e08c9d6c140978d0b3ac2b6d965c005d8dfb006b1e5cb85b06fdb9cfb",
	"addRepeatableJob-2.lua":      "53249b4e9adc4934ac2ee99bf946832f5a2623dfbe26e73de54465d86dc53470",
	"removeRepeatable-3.lua":      "482a7f1c8b6c9a101dbec680f36c65dbb37af71065bde67e04028cee18c906cf",
	"removeJob-2.lua":             "8eb5cf906f29e65df42e30580ce416eb18791b1684f9a8ced6d8c799f3f9ab7a",
	"moveToActive-11.lua":         "ee4a8eb48cad650aec886580e128418d44582f68b5202a11dcac48bb3dcae117",
	"moveToFinished-14.lua":       "572920a790ad025386a2b9355de086c1c4ca6658fc15ace7d2c4932365c8c0b3",
	"moveToDelayed-8.lua":         "3140607f9078063c1cd35f984ad4fec26f49240aa037fb0c9f787c50b17660a7",
	"extendLock-2.lua":            "f3c0b3f993871533eabfc85f5fbfc9b1dcb7e1b230c9305e23fc96365f96a1f2",
	"moveStalledJobsToWait-8.lua": "c77949cefb61af6b82ee423625aa8a9b90d9ec8a0691af0e8609dbb4775ca27e",
	"retryJob-11.lua":             "5c98c7eae068e06d53dd55d468e397fa73e173697519d1ea8857172e8faa4abe",
	"updateData-1.lua":            "33dc385c7749b1c525495725afb5894ee96295c8f61336273496aaed04ed6b2f",
	"updateJobScheduler-12.lua":   "09bc293d2ccf3cc493c12d59b39b43e449ced9b640d7693fe5f294316423a562",
}

type queueScripts struct {
	addStandardJob        *redis.Script
	addDelayedJob         *redis.Script
	addRepeatableJob      *redis.Script
	removeRepeatable      *redis.Script
	removeJob             *redis.Script
	moveToActive          *redis.Script
	moveToFinished        *redis.Script
	moveToDelayed         *redis.Script
	extendLock            *redis.Script
	moveStalledJobsToWait *redis.Script
	retryJob              *redis.Script
	updateData            *redis.Script
	updateJobScheduler    *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	load := func(name string) (*redis.Script, error) {
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			return nil, fmt.Errorf("alertworker/queue: read embedded script %s: %w", name, err)
		}
		if len(content) == 0 {
			return nil, fmt.Errorf("alertworker/queue: embedded script %s is empty", name)
		}
		return redis.NewScript(string(content)), nil
	}
	var scripts queueScripts
	var err error
	if scripts.addStandardJob, err = load("addStandardJob-9.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.addDelayedJob, err = load("addDelayedJob-6.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.addRepeatableJob, err = load("addRepeatableJob-2.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.removeRepeatable, err = load("removeRepeatable-3.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.removeJob, err = load("removeJob-2.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToActive, err = load("moveToActive-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToFinished, err = load("moveToFinished-14.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToDelayed, err = load("moveToDelayed-8.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.extendLock, err = load("extendLock-2.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveStalledJobsToWait, err = load("moveStalledJobsToWait-8.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.retryJob, err = load("retryJob-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.updateData, err = load("updateData-1.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.updateJobScheduler, err = load("updateJobScheduler-12.lua"); err != nil {
		return queueScripts{}, err
	}
	return scripts, nil
}

// scriptSHA256 is used by the digest test.
func scriptSHA256(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}
