package classificationrssops

import "context"

// EvaluateClassificationQualityAlerts is the background-scheduler entry point for
// the classification quality alert evaluation. It mirrors
// ClassificationQualityAlertSchedulerService.evaluateOrg calling
// ClassificationQualityService.getSummary({orgId, window:"1h"}): it reuses the
// cached summary path, so the threshold-alert throttle, recipient lookup and
// Notification rows (and the notification:events:v1 relay when installed) are
// exactly the side effects of the HTTP summary route.
//
// window follows the GET summary DTO: "" selects the default 24h window, and any
// value outside the 1h/24h/7d whitelist is rejected like the controller's
// validation. The scheduler always passes "1h".
func (s *Service) EvaluateClassificationQualityAlerts(ctx context.Context, orgID, window string) error {
	request, err := evaluationSummaryRequest(orgID, window)
	if err != nil {
		return err
	}
	_, err = s.ClassificationSummary(ctx, request)
	return err
}

// evaluationSummaryRequest builds the typed getSummary input used by the
// scheduler: no source or category filter, only the window.
func evaluationSummaryRequest(orgID, window string) (summaryRequest, error) {
	parsedWindow, err := parseQualityWindow(window)
	if err != nil {
		return summaryRequest{}, err
	}
	return summaryRequest{OrgID: orgID, Window: parsedWindow}, nil
}
