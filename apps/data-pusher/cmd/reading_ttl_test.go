package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/wire"
)

// ADR 0001 (#286): the record data-pusher queues for IoT Hub carries the
// Reading's own Cosmos ttl: 7 days with the twin's active cook, 24h without.
func TestBuildQueueRecord_TTLFollowsTheActiveCook(t *testing.T) {
	ts := time.Date(2026, 11, 28, 10, 0, 0, 0, time.UTC)
	status := wire.V1Status{SmokerID: "meatgeek3"}
	cook := "cook-1"

	for _, tc := range []struct {
		name   string
		cookID *string
		want   int
	}{
		{"in a cook", &cook, 604800},
		{"outside a cook", nil, 86400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, err := buildQueueRecord(context.Background(), status, ts, tc.cookID, 1, "")
			if err != nil {
				t.Fatalf("buildQueueRecord: %v", err)
			}
			var body struct {
				TTL *int `json:"ttl"`
			}
			if err := json.Unmarshal(rec.Payload, &body); err != nil {
				t.Fatalf("payload: %v", err)
			}
			if body.TTL == nil || *body.TTL != tc.want {
				t.Errorf("payload ttl = %v, want %d; payload %s", body.TTL, tc.want, rec.Payload)
			}
		})
	}
}
