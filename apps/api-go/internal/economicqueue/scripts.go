package economicqueue

import (
	"embed"
	"fmt"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// The embedded files are the official BullMQ 5.63.2 commands expanded exactly
// as the npm package ships them, plus one small local guard script for this
// queue's pre-existing repeat layout. See scripts/NOTICE.md for provenance,
// versions, licence and SHA-256 digests. No script is downloaded at runtime.
//
//go:embed scripts/*.lua
var scriptFiles embed.FS

type queueScripts struct {
	addStandardJob        *redis.Script
	moveToActive          *redis.Script
	extendLock            *redis.Script
	moveToFinished        *redis.Script
	moveStalledJobsToWait *redis.Script
	// updateRepeat advances a repeat iteration only when the scheduler still
	// exists and the caller owns the expected current iteration.
	updateRepeat *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	load := func(name string) (*redis.Script, error) {
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			return nil, fmt.Errorf("economicqueue: read embedded script %s: %w", name, err)
		}
		if len(content) == 0 {
			return nil, fmt.Errorf("economicqueue: embedded script %s is empty", name)
		}
		return redis.NewScript(string(content)), nil
	}
	var scripts queueScripts
	var err error
	if scripts.addStandardJob, err = load("addStandardJob-9.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToActive, err = load("moveToActive-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.extendLock, err = load("extendLock-2.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToFinished, err = load("moveToFinished-14.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveStalledJobsToWait, err = load("moveStalledJobsToWait-8.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.updateRepeat, err = load("updateRepeat.lua"); err != nil {
		return queueScripts{}, err
	}
	return scripts, nil
}

// defaultQueueScripts is loaded once at init. A missing embedded script is a
// programming error, so it panics at startup instead of failing a job later.
var defaultQueueScripts = mustLoadScripts()

func mustLoadScripts() queueScripts {
	scripts, err := loadQueueScripts()
	if err != nil {
		panic(err)
	}
	return scripts
}

// pack encodes the argument tuples the scripts unpack with cmsgpack.
func pack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("economicqueue: pack msgpack: %w", err)
	}
	return encoded, nil
}
