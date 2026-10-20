package graphqlsubscriptions

// QueueObserver returns the per-process itemPipeline observer, or nil when the
// runtime was built with a test source. It lets another consumer attach to the
// same XREAD loop instead of opening a second one (see
// AddPipelineCompletedHandler).
func (r *Runtime) QueueObserver() *QueueObserver {
	if r == nil {
		return nil
	}
	return r.queue
}
