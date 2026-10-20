package realtimeevents

import "context"

// openSubscriptions creates every Redis subscription synchronously so Start
// fails fast when Redis is unreachable. The message readers themselves run in
// goroutines tracked by the Sources wait group.
func (s *Sources) openSubscriptions(ctx context.Context) error {
	if err := s.openNewsnowSubscriptions(ctx); err != nil {
		return err
	}
	if err := s.openSituationSubscription(ctx); err != nil {
		return err
	}
	s.ensureStore()
	return nil
}
