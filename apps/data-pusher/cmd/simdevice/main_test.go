package main

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision"
)

// TestMain lets the test binary stand in for the real simdevice binary: when
// SIMDEVICE_TEST_AS_BINARY is set it runs the command's real main() (process
// exit code, real stdout/stderr, logrus, tracing setup) and exits.
func TestMain(m *testing.M) {
	if os.Getenv("SIMDEVICE_TEST_AS_BINARY") == "1" {
		os.Args = append([]string{"simdevice"}, strings.Fields(os.Getenv("SIMDEVICE_TEST_ARGS"))...)
		main()
		return
	}
	os.Exit(m.Run())
}

func runBinary(t *testing.T, args string) (code int, stdout, stderr string) {
	t.Helper()
	return runBinaryEnv(t, nil, args)
}

// runBinaryEnv is runBinary with extra environment entries. The binary does
// not inherit any SIMDEVICE_, MEATGEEK_ or OTLP endpoint variable.
func runBinaryEnv(t *testing.T, extra []string, args string) (code int, stdout, stderr string) {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	env := []string{"SIMDEVICE_TEST_AS_BINARY=1", "SIMDEVICE_TEST_ARGS=" + args}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "SIMDEVICE_") && !strings.HasPrefix(kv, "OTEL_EXPORTER_OTLP_ENDPOINT=") && !strings.HasPrefix(kv, "MEATGEEK_") {
			env = append(env, kv)
		}
	}
	cmd.Env = append(env, extra...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		code = 0
	case errors.As(err, &exitErr):
		code = exitErr.ExitCode()
	default:
		t.Fatalf("run binary: %v", err)
	}
	return code, out.String(), errb.String()
}

// DPS mode is the only mode: without an ID scope the binary refuses, naming it.
func TestBinary_MissingIDScopeExitsWithUsage(t *testing.T) {
	code, stdout, stderr := runBinaryEnv(t, []string{"MEATGEEK_DEVICE_ID=sim-device-1"}, "--count 1")
	if code != 2 {
		t.Fatalf("exit %d, want 2; stderr=%q", code, stderr)
	}
	for _, want := range []string{"MEATGEEK_DPS_ID_SCOPE", "docs/devices/runbook.md"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr must name %s; got %q", want, stderr)
		}
	}
	if stdout != "" {
		t.Errorf("stdout must be empty; got %q", stdout)
	}
}

// The real binary, with the production twin client, exits non-zero with a
// clear message when no twin response arrives within --timeout. The device's
// cached DPS assignment names 127.0.0.1, where nothing listens on 8883, so the
// connect itself fails and is retried until the timeout; no response can ever
// arrive, so the outcome does not depend on when the timeout fires.
func TestBinary_TwinTimeoutExitsNonZero(t *testing.T) {
	state := t.TempDir()
	if err := provision.SaveAssignment(state, provision.Assignment{AssignedHub: "127.0.0.1", DeviceID: "sim-device-1", RegisteredAt: time.Unix(1_700_000_000, 0)}); err != nil {
		t.Fatal(err)
	}
	extra := []string{"MEATGEEK_DPS_ID_SCOPE=0ne00ABCDEF", "MEATGEEK_DEVICE_ID=sim-device-1", "MEATGEEK_STATE_DIR=" + state}
	code, stdout, stderr := runBinaryEnv(t, extra, "--twin --timeout 1s")
	if code != 1 {
		t.Fatalf("exit %d, want 1; stderr=%q", code, stderr)
	}
	if !strings.Contains(stderr, "no twin response from IoT Hub within 1s") {
		t.Errorf("stderr should say no twin response arrived; got %q", stderr)
	}
	if stdout != "" {
		t.Errorf("stdout must be empty; got %q", stdout)
	}
}

func TestBinary_IdentityInitPrintsOnlyTheCertificateAndTheSameOnEveryRun(t *testing.T) {
	args := "identity init --device-id sim-device-1 --state-dir " + t.TempDir()
	code, first, stderr := runBinary(t, args)
	if code != 0 {
		t.Fatalf("exit %d; stderr=%q", code, stderr)
	}
	if strings.Contains(first, "PRIVATE KEY") {
		t.Fatal("stdout carries a private key")
	}
	block, rest := pem.Decode([]byte(first))
	if block == nil || block.Type != "CERTIFICATE" || len(rest) != 0 {
		t.Fatalf("stdout is not exactly one PEM certificate: %q", first)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil || cert.Subject.CommonName != "sim-device-1" {
		t.Fatalf("certificate: %v, CN %q", err, cert.Subject.CommonName)
	}
	code, second, stderr := runBinary(t, args)
	if code != 0 {
		t.Fatalf("second run: exit %d; stderr=%q", code, stderr)
	}
	if first != second {
		t.Error("the second run printed different bytes")
	}
}

// The device id and state dir can come from the DPS-mode environment.
func TestBinary_IdentityInitReadsTheEnvironment(t *testing.T) {
	state := t.TempDir()
	extra := []string{"MEATGEEK_DEVICE_ID=sim-env-1", "MEATGEEK_STATE_DIR=" + state}
	code, stdout, stderr := runBinaryEnv(t, extra, "identity init")
	if code != 0 {
		t.Fatalf("exit %d; stderr=%q", code, stderr)
	}
	if _, err := os.Stat(state + "/identity/device.key"); err != nil {
		t.Errorf("no key under MEATGEEK_STATE_DIR: %v", err)
	}
	if !strings.HasPrefix(stdout, "-----BEGIN CERTIFICATE-----") {
		t.Errorf("stdout = %q", stdout)
	}
}
