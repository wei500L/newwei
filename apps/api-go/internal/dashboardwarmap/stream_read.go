package dashboardwarmap

import (
	"context"
	"encoding/json"
	"time"
)

// StreamView 是 SSE 一次更新传给战争地图服务的参数。Cluster 固定为 false，
// 与 DashboardController.dashboardStream 的 warMapEventsOptions 一致。
type StreamView struct {
	Translate  bool
	BBox       *[4]float64
	Zoom       *float64
	FlightMode string
	AisMode    string
}

// ReadForStream 在同一次调用里读取事件、新闻标记，并把这两份结果交给图层。
// 图层不再单独查询事件和新闻。
func (h *Handler) ReadForStream(ctx context.Context, orgID string, start, end time.Time, view StreamView) (events, markers, layers []byte, err error) {
	opt := viewOptions{
		Translate:  view.Translate,
		BBox:       view.BBox,
		Zoom:       view.Zoom,
		Cluster:    false,
		FlightMode: view.FlightMode,
		AisMode:    view.AisMode,
	}
	eventBody, err := h.svc.Events(ctx, orgID, start, end, opt)
	if err != nil {
		return nil, nil, nil, err
	}
	markerBody, err := h.svc.Markers(ctx, orgID, start, end, opt)
	if err != nil {
		return nil, nil, nil, err
	}
	layerBody, err := h.svc.layersFrom(ctx, orgID, opt, eventBody, markerBody)
	if err != nil {
		return nil, nil, nil, err
	}
	events, err = json.Marshal(eventBody)
	if err != nil {
		return nil, nil, nil, err
	}
	markers, err = json.Marshal(markerBody)
	if err != nil {
		return nil, nil, nil, err
	}
	layers, err = json.Marshal(layerBody)
	if err != nil {
		return nil, nil, nil, err
	}
	return events, markers, layers, nil
}
