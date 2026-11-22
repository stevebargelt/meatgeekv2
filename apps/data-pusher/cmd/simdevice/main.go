// Command simdevice sends synthetic temperature readings to Azure IoT Hub as
// one device, through the same payload/property builders and MQTT client the
// data-pusher uses on the Pi. With --twin it first reads the device twin
// through the Pi's twin code and stamps the applied cook on its readings. The
// device credential is read only from $SIMDEVICE_CONNECTION_STRING, or, in DPS
// mode ($MEATGEEK_DPS_ID_SCOPE, $MEATGEEK_DEVICE_ID), is the device's own X.509
// identity under $MEATGEEK_STATE_DIR. `simdevice identity init` prints that
// identity's certificate. See apps/data-pusher/README.md.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/simdevice"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/telemetry"
)

func main() {
	os.Exit(run())
}

func run() int {
	// stdout carries only the JSON lines (twin, then one per message); logs go
	// to stderr.
	logrus.SetOutput(os.Stderr)
	logrus.SetFormatter(&logrus.JSONFormatter{})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Same tracing setup as the data-pusher, so each message carries a
	// traceparent like the Pi's (exported only when OTEL_EXPORTER_OTLP_ENDPOINT
	// is set).
	shutdown, err := telemetry.SetupTracing(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "simdevice: set up tracing: %v\n", err)
		return simdevice.ExitUsage
	}
	defer shutdown()

	return simdevice.Main(ctx, simdevice.Env{
		Args:          os.Args[1:],
		Getenv:        os.Getenv,
		Stdout:        os.Stdout,
		Stderr:        os.Stderr,
		NewClient:     simdevice.AzureClientFactory,
		NewTwinClient: simdevice.AzureTwinClientFactory,
		NewDPSClient:  simdevice.AzureDPSClientFactory,
		Tracer:        otel.Tracer("meatgeek-simdevice"),
	})
}
