package metrics

import (
	"runtime"
	runtimemetrics "runtime/metrics"
	"time"
)

// processStart is the process start time used by process_start_time_seconds.
var processStart = time.Now()

// runtimeFamilies renders the Go runtime and process metrics that replace the
// nodejs_* series the Node client collects.
//
// Mapping for dashboards (the nodejs_* names no longer exist):
//
//	nodejs_process_cpu_seconds_total      -> process_cpu_seconds_total
//	nodejs_process_start_time_seconds     -> process_start_time_seconds
//	nodejs_heap_size_total_bytes          -> go_memstats_heap_sys_bytes
//	nodejs_heap_size_used_bytes           -> go_memstats_heap_alloc_bytes
//	nodejs_heap_space_size_available_bytes-> go_memstats_heap_inuse_bytes (available memory is not exposed)
//	nodejs_external_memory_bytes          -> go_memstats_sys_bytes
//	nodejs_gc_duration_seconds            -> not exposed (summary type is out of scope)
//	nodejs_eventloop_lag_seconds          -> not applicable (no event loop)
//	nodejs_active_handles / _requests     -> not applicable
//	nodejs_version_info                   -> go_info{version="..."}
func runtimeFamilies() []snapshot {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)

	cpuSeconds := readCPUSeconds()
	lastGCSeconds := float64(memory.LastGC) / float64(time.Second)

	return []snapshot{
		single("go_goroutines",
			"Number of goroutines that currently exist.", TypeGauge,
			float64(runtime.NumGoroutine()), nil, nil),
		single("go_info",
			"Information about the Go environment.", TypeGauge,
			1, []string{"version"}, []string{runtime.Version()}),
		single("go_memstats_alloc_bytes",
			"Number of bytes allocated in heap and currently in use.", TypeGauge,
			float64(memory.Alloc), nil, nil),
		single("go_memstats_alloc_bytes_total",
			"Total number of bytes allocated in heap until now, even if released already.", TypeCounter,
			float64(memory.TotalAlloc), nil, nil),
		single("go_memstats_sys_bytes",
			"Number of bytes obtained from system.", TypeGauge,
			float64(memory.Sys), nil, nil),
		single("go_memstats_heap_alloc_bytes",
			"Number of heap bytes allocated and currently in use.", TypeGauge,
			float64(memory.HeapAlloc), nil, nil),
		single("go_memstats_heap_sys_bytes",
			"Number of heap bytes obtained from system.", TypeGauge,
			float64(memory.HeapSys), nil, nil),
		single("go_memstats_heap_inuse_bytes",
			"Number of heap bytes that are in use.", TypeGauge,
			float64(memory.HeapInuse), nil, nil),
		single("go_memstats_heap_objects",
			"Number of currently allocated objects.", TypeGauge,
			float64(memory.HeapObjects), nil, nil),
		single("go_memstats_stack_inuse_bytes",
			"Number of bytes in use by the stack allocator.", TypeGauge,
			float64(memory.StackInuse), nil, nil),
		single("go_memstats_next_gc_bytes",
			"Number of heap bytes when next garbage collection will take place.", TypeGauge,
			float64(memory.NextGC), nil, nil),
		single("go_memstats_gc_sys_bytes",
			"Number of bytes used for garbage collection system metadata.", TypeGauge,
			float64(memory.GCSys), nil, nil),
		single("go_memstats_last_gc_time_seconds",
			"Number of seconds since 1970 of last garbage collection.", TypeGauge,
			lastGCSeconds, nil, nil),
		single("go_gc_cycles_total",
			"Total number of completed garbage collection cycles.", TypeCounter,
			float64(memory.NumGC), nil, nil),
		single("process_cpu_seconds_total",
			"Total CPU time spent by the process in seconds.", TypeCounter,
			cpuSeconds, nil, nil),
		single("process_start_time_seconds",
			"Start time of the process since unix epoch in seconds.", TypeGauge,
			float64(processStart.UnixNano())/float64(time.Second), nil, nil),
	}
}

// readCPUSeconds reads /cpu/classes/total:cpu-seconds, the CPU time used by the
// Go program across user, GC and scavenger work. Zero is reported when the
// runtime does not expose the metric.
func readCPUSeconds() float64 {
	samples := []runtimemetrics.Sample{{Name: "/cpu/classes/total:cpu-seconds"}}
	runtimemetrics.Read(samples)
	if samples[0].Value.Kind() != runtimemetrics.KindFloat64 {
		return 0
	}
	return samples[0].Value.Float64()
}

// single builds one snapshot with exactly one series.
func single(name, help string, kind MetricType, value float64, labelNames, labelValues []string) snapshot {
	return snapshot{
		name:       name,
		help:       help,
		kind:       kind,
		labelNames: labelNames,
		series: []seriesSnapshot{{
			labelValues: labelValues,
			value:       value,
		}},
	}
}
