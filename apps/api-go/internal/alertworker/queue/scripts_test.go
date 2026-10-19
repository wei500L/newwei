package queue

import (
	"bytes"
	"testing"
)

func TestScriptsAreTheVendoredBullMQ515(t *testing.T) {
	entries, err := scriptFiles.ReadDir("scripts")
	if err != nil {
		t.Fatalf("read embedded scripts: %v", err)
	}
	seen := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if len(name) < 4 || name[len(name)-4:] != ".lua" {
			continue
		}
		expected, ok := scriptDigests[name]
		if !ok {
			t.Errorf("script %s is embedded but has no pinned digest", name)
			continue
		}
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if got := scriptSHA256(content); got != expected {
			t.Errorf("%s digest = %s, want %s", name, got, expected)
		}
		if bytes.Contains(content, []byte("--- @include")) {
			t.Errorf("%s still contains an unexpanded include directive", name)
		}
		seen++
	}
	if seen != len(scriptDigests) {
		t.Fatalf("checked %d scripts, want %d", seen, len(scriptDigests))
	}
}

func TestScriptsLoad(t *testing.T) {
	scripts, err := loadQueueScripts()
	if err != nil {
		t.Fatalf("load scripts: %v", err)
	}
	for name, script := range map[string]*struct{ hash string }{
		"addStandardJob":        {scripts.addStandardJob.Hash()},
		"addDelayedJob":         {scripts.addDelayedJob.Hash()},
		"addRepeatableJob":      {scripts.addRepeatableJob.Hash()},
		"removeRepeatable":      {scripts.removeRepeatable.Hash()},
		"removeJob":             {scripts.removeJob.Hash()},
		"moveToActive":          {scripts.moveToActive.Hash()},
		"moveToFinished":        {scripts.moveToFinished.Hash()},
		"moveToDelayed":         {scripts.moveToDelayed.Hash()},
		"extendLock":            {scripts.extendLock.Hash()},
		"moveStalledJobsToWait": {scripts.moveStalledJobsToWait.Hash()},
		"retryJob":              {scripts.retryJob.Hash()},
		"updateData":            {scripts.updateData.Hash()},
		"updateJobScheduler":    {scripts.updateJobScheduler.Hash()},
	} {
		if len(script.hash) != 40 {
			t.Errorf("%s hash = %q, want a sha1", name, script.hash)
		}
	}
}
