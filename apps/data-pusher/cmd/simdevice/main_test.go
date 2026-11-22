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
)

const fakeKey = "ZmFrZS1rZXktZG8tbm90LXVzZS0xMjM0NTY3ODkw"

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

func runBinary(t *testing.T, connStr *string, args string) (code int, stdout, stderr string) {
	t.Helper()
	return runBinaryEnv(t, connStr, nil, args)
}

// runBinaryEnv is runBinary with extra environment entries.
func runBinaryEnv(t *testing.T, connStr *string, extra []string, args string) (code int, stdout, stderr string) {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	env := []string{"SIMDEVICE_TEST_AS_BINARY=1", "SIMDEVICE_TEST_ARGS=" + args}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "SIMDEVICE_CONNECTION_STRING=") && !strings.HasPrefix(kv, "OTEL_EXPORTER_OTLP_ENDPOINT=") && !strings.HasPrefix(kv, "MEATGEEK_") {
			env = append(env, kv)
		}
	}
	env = append(env, extra...)
	if connStr != nil {
		env = append(env, "SIMDEVICE_CONNECTION_STRING="+*connStr)
	}
	cmd.Env = env
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

func TestBinary_MissingConnectionStringExitsNonZero(t *testing.T) {
	code, stdout, stderr := runBinary(t, nil, "--count 1")
	if code == 0 {
		t.Fatal("exit 0 without SIMDEVICE_CONNECTION_STRING")
	}
	if !strings.Contains(stderr, "SIMDEVICE_CONNECTION_STRING") {
		t.Errorf("stderr must name SIMDEVICE_CONNECTION_STRING; got %q", stderr)
	}
	if stdout != "" {
		t.Errorf("stdout must be empty; got %q", stdout)
	}
}

func TestBinary_MalformedConnectionStringDoesNotLeak(t *testing.T) {
	bad := "DeviceId=sim-device-1;SharedAccessKey=" + fakeKey // no HostName
	code, stdout, stderr := runBinary(t, &bad, "--count 1")
	if code == 0 {
		t.Fatal("exit 0 with a malformed connection string")
	}
	for _, secret := range []string{fakeKey, bad} {
		if strings.Contains(stdout, secret) || strings.Contains(stderr, secret) {
			t.Errorf("%q leaked: stdout=%q stderr=%q", secret, stdout, stderr)
		}
	}
	if stdout != "" {
		t.Errorf("stdout must be empty; got %q", stdout)
	}
}

// The real binary, with the production twin client, exits non-zero with a
// clear message when no twin response arrives within --timeout. Nothing
// listens on 127.0.0.1:8883, so the connect itself fails and is retried.
func TestBinary_TwinTimeoutExitsNonZero(t *testing.T) {
	conn := "HostName=127.0.0.1;DeviceId=sim-device-1;SharedAccessKey=" + fakeKey
	code, stdout, stderr := runBinary(t, &conn, "--twin --timeout 1s")
	if code != 1 {
		t.Fatalf("exit %d, want 1; stderr=%q", code, stderr)
	}
	if !strings.Contains(stderr, "no twin response from IoT Hub within 1s") {
		t.Errorf("stderr should say no twin response arrived; got %q", stderr)
	}
	if stdout != "" {
		t.Errorf("stdout must be empty; got %q", stdout)
	}
	if strings.Contains(stdout+stderr, fakeKey) {
		t.Errorf("key leaked: %q", stderr)
	}
}

func TestBinary_IdentityInitPrintsOnlyTheCertificateAndTheSameOnEveryRun(t *testing.T) {
	args := "identity init --device-id sim-device-1 --state-dir " + t.TempDir()
	code, first, stderr := runBinary(t, nil, args)
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
	code, second, stderr := runBinary(t, nil, args)
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
	code, stdout, stderr := runBinaryEnv(t, nil, extra, "identity init")
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

func TestBinary_RefusesBothModes(t *testing.T) {
	// Never parsed: the refusal comes first.
	conn := "not-a-connection-string-x9"
	extra := []string{"MEATGEEK_DPS_ID_SCOPE=0ne00ABCDEF", "MEATGEEK_DEVICE_ID=sim-device-1", "MEATGEEK_STATE_DIR=" + t.TempDir()}
	code, stdout, stderr := runBinaryEnv(t, &conn, extra, "--count 1")
	if code != 2 {
		t.Fatalf("exit %d, want 2; stderr=%q", code, stderr)
	}
	if !strings.Contains(stderr, "set only one") {
		t.Errorf("stderr = %q, want the refusal", stderr)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want nothing", stdout)
	}
}
