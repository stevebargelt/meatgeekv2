package collector

// Contract test, pusher side (HAR-148). The golden file is the controller's
// real get_status body: apps/device-controller/internal/deviceapi's
// TestGetStatus_PusherRequest_MatchesGolden asserts the controller serves it
// byte for byte. Here the pusher's real request, unwrap and wire mapping read
// it, so a change to either side's shape fails one of the two tests.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/wire"
)

const controllerGoldenFile = "../../../../libs/api-interfaces/test-vectors/controller-get-status.json"

func TestContract_ControllerGetStatusGolden_MapsToReading(t *testing.T) {
	golden, err := os.ReadFile(controllerGoldenFile)
	if err != nil {
		t.Fatalf("read golden %s: %v", controllerGoldenFile, err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/robots/MeatGeekBot/commands/get_status" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(golden)
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, time.Second, noop.NewTracerProvider().Tracer(""))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// One fetch through the collector's real request and unwrap; no poll
	// loop, so nothing here waits on the interval.
	status, err := c.fetchDeviceStatus(context.Background())
	if err != nil {
		t.Fatalf("fetchDeviceStatus: %v", err)
	}

	if status.SmokerID != "meatgeek3" || status.Mode != "test" || status.SetPoint != 200 || !status.FireHealthy {
		t.Errorf("status fields: %+v", status)
	}
	wantCurrent := time.Date(2026, 11, 23, 15, 4, 5, 0, time.UTC)
	if !status.CurrentTime.Equal(wantCurrent) {
		t.Errorf("CurrentTime = %v, want %v", status.CurrentTime, wantCurrent)
	}

	ts := time.Date(2026, 11, 23, 15, 4, 6, 0, time.UTC)
	reading := wire.MapV1ToTemperatureReading(*status, ts, nil)

	if reading.DeviceID != "meatgeek3" {
		t.Errorf("DeviceID = %q, want meatgeek3", reading.DeviceID)
	}
	assertTemp(t, "grill", reading.GrillTemp, float64Ptr(64.4))
	assertTemp(t, "probe1", reading.Probe1Temp, float64Ptr(66.2))
	assertTemp(t, "probe2", reading.Probe2Temp, float64Ptr(65.9))
	// An unplugged probe the controller serves as 0 stays 0 (cleanProbe
	// keeps a real zero); a NaN the controller serves as null is absent.
	assertTemp(t, "probe3", reading.Probe3Temp, float64Ptr(0))
	assertTemp(t, "probe4", reading.Probe4Temp, nil)
}

func assertTemp(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case want == nil && got != nil:
		t.Errorf("%s = %v, want absent", name, *got)
	case want != nil && got == nil:
		t.Errorf("%s absent, want %v", name, *want)
	case want != nil && *got != *want:
		t.Errorf("%s = %v, want %v", name, *got, *want)
	}
}
