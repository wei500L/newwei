package crawlworker

import (
	"encoding/json"
	"testing"
)

func TestWithJSONIntegerFieldKeepsTheKeyOrder(t *testing.T) {
	cases := []struct {
		name  string
		data  string
		value int
		want  string
	}{
		{
			name:  "existing key keeps its position",
			data:  `{"taskId":"task-1","orgId":"org-1","traceId":"trace-1","memoryPressureRequeues":0,"priorityClass":"hot"}`,
			value: 1,
			want:  `{"taskId":"task-1","orgId":"org-1","traceId":"trace-1","memoryPressureRequeues":1,"priorityClass":"hot"}`,
		},
		{
			name:  "missing key is appended",
			data:  `{"taskId":"task-1","orgId":"org-1"}`,
			value: 2,
			want:  `{"taskId":"task-1","orgId":"org-1","memoryPressureRequeues":2}`,
		},
		{
			name:  "nested values are preserved",
			data:  `{"sourcePriority":-100,"options":{"scrollDelayMs":250,"jsCode":["a","b"]},"memoryPressureRequeues":4}`,
			value: 5,
			want:  `{"sourcePriority":-100,"options":{"scrollDelayMs":250,"jsCode":["a","b"]},"memoryPressureRequeues":5}`,
		},
		{
			name:  "empty object",
			data:  `{}`,
			value: 1,
			want:  `{"memoryPressureRequeues":1}`,
		},
	}
	for _, testCase := range cases {
		got, err := withJSONIntegerField(json.RawMessage(testCase.data), "memoryPressureRequeues", testCase.value)
		if err != nil {
			t.Fatalf("%s: %v", testCase.name, err)
		}
		if string(got) != testCase.want {
			t.Errorf("%s: data = %s, want %s", testCase.name, got, testCase.want)
		}
	}
}

func TestWithJSONIntegerFieldRejectsNonObjects(t *testing.T) {
	for _, data := range []string{"", "null", "[]", `"text"`, "42", "{"} {
		if _, err := withJSONIntegerField(json.RawMessage(data), "memoryPressureRequeues", 1); err == nil {
			t.Errorf("data %q: expected an error", data)
		}
	}
}
