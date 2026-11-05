package queue

import (
	"testing"
)

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
