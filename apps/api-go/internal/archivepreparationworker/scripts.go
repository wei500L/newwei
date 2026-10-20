package archivepreparationworker

import (
	"embed"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// The embedded files are the official BullMQ 5.63.2 commands expanded exactly
// as the npm package ships them. See scripts/NOTICE.md for version, source,
// license and SHA-256 digests. No script is downloaded at runtime.
//
//go:embed scripts/*.lua
var scriptFiles embed.FS

type queueScripts struct {
	addStandardJob        *redis.Script
	moveToActive          *redis.Script
	extendLock            *redis.Script
	moveToFinished        *redis.Script
	retryJob              *redis.Script
	moveStalledJobsToWait *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	load := func(name string) (*redis.Script, error) {
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			return nil, fmt.Errorf("archivepreparationworker: read embedded script %s: %w", name, err)
		}
		if len(content) == 0 {
			return nil, fmt.Errorf("archivepreparationworker: embedded script %s is empty", name)
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
	if scripts.retryJob, err = load("retryJob-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveStalledJobsToWait, err = load("moveStalledJobsToWait-8.lua"); err != nil {
		return queueScripts{}, err
	}
	return scripts, nil
}
