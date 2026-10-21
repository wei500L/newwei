package crawlworker

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
	"moveToActive-11.lua":           "ee4a8eb48cad650aec886580e128418d44582f68b5202a11dcac48bb3dcae117",
	"moveToFinished-14.lua":         "572920a790ad025386a2b9355de086c1c4ca6658fc15ace7d2c4932365c8c0b3",
	"moveJobFromActiveToWait-9.lua": "5825f9ec905734a8647a8feef89dc2f4e84f7ad1ecb8497b0c2fc57b7d2ac592",
	"retryJob-11.lua":               "5c98c7eae068e06d53dd55d468e397fa73e173697519d1ea8857172e8faa4abe",
	"moveToDelayed-8.lua":           "3140607f9078063c1cd35f984ad4fec26f49240aa037fb0c9f787c50b17660a7",
	"moveStalledJobsToWait-8.lua":   "c77949cefb61af6b82ee423625aa8a9b90d9ec8a0691af0e8609dbb4775ca27e",
	"extendLock-2.lua":              "f3c0b3f993871533eabfc85f5fbfc9b1dcb7e1b230c9305e23fc96365f96a1f2",
	"updateData-1.lua":              "33dc385c7749b1c525495725afb5894ee96295c8f61336273496aaed04ed6b2f",
}

// queueScripts is the Lua command set of one queue worker.
type queueScripts struct {
	moveToActive            *redis.Script
	moveToFinished          *redis.Script
	moveJobFromActiveToWait *redis.Script
	retryJob                *redis.Script
	moveToDelayed           *redis.Script
	moveStalledJobsToWait   *redis.Script
	extendLock              *redis.Script
	updateData              *redis.Script
}

// loadQueueScripts reads and parses the embedded Lua commands. Every queue
// runtime shares the parsed script objects: go-redis keeps the SHA1 and sends
// EVALSHA after the first EVAL, so parsing once per worker is enough.
func loadQueueScripts() (queueScripts, error) {
	load := func(name string) (*redis.Script, error) {
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			return nil, fmt.Errorf("crawlworker: read embedded script %s: %w", name, err)
		}
		if len(content) == 0 {
			return nil, fmt.Errorf("crawlworker: embedded script %s is empty", name)
		}
		return redis.NewScript(string(content)), nil
	}
	var scripts queueScripts
	var err error
	if scripts.moveToActive, err = load("moveToActive-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToFinished, err = load("moveToFinished-14.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveJobFromActiveToWait, err = load("moveJobFromActiveToWait-9.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.retryJob, err = load("retryJob-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToDelayed, err = load("moveToDelayed-8.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveStalledJobsToWait, err = load("moveStalledJobsToWait-8.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.extendLock, err = load("extendLock-2.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.updateData, err = load("updateData-1.lua"); err != nil {
		return queueScripts{}, err
	}
	return scripts, nil
}

// scriptSHA256 is used by the digest test.
func scriptSHA256(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}
