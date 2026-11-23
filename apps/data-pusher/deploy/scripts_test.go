// Package deploy holds the operator scripts for the data pusher. These tests
// (HAR-135) run enrol-device.sh and revoke-device.sh with bash against a fake
// `az` on PATH: it records each invocation and answers from a per-test fixture
// directory, so the tests assert both the result line and the exact az calls
// without touching Azure.
package deploy

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // DPS identifies certificates by SHA-1 thumbprint.
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	deviceID = "meatgeek-pi-7"
	rg       = "meatgeek-v2-dev-rg"
	dpsName  = "meatgeek-v2-dev-dps-abc"
	hubName  = "meatgeek-v2-dev-hub-abc"
	hubHost  = "meatgeek-v2-dev-hub-abc.azure-devices.net"
)

// fakeAz records its arguments, one invocation per line with the arguments
// separated by \x1f, and answers from $FAKE_AZ_DIR/<key>.{out,err,rc}. The
// key is the command words before the first option, joined by '_', plus the
// last segment of --resource-type when there is one (so the DPS and hub
// `resource list` calls can answer differently). No fixture: exit 0, no output.
const fakeAz = `#!/usr/bin/env bash
set -u
{ for a in "$@"; do printf '%s\x1f' "$a"; done; printf '\n'; } >>"$FAKE_AZ_LOG"
key=""
words=1
prev=""
for a in "$@"; do
  case "$a" in
    -*) words=0 ;;
    *)
      if [[ $words -eq 1 ]]; then key="${key:+${key}_}$a"; fi
      if [[ "$prev" == "--resource-type" ]]; then key="${key}_${a##*/}"; fi
      ;;
  esac
  prev=$a
done
f="$FAKE_AZ_DIR/$key"
[[ -f "$f.out" ]] && cat "$f.out"
[[ -f "$f.err" ]] && cat "$f.err" >&2
if [[ -f "$f.rc" ]]; then exit "$(cat "$f.rc")"; fi
exit 0
`

type env struct {
	t        *testing.T
	bin      string
	fixtures string
	log      string
	dir      string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	e := &env{
		t:        t,
		bin:      filepath.Join(dir, "bin"),
		fixtures: filepath.Join(dir, "fixtures"),
		log:      filepath.Join(dir, "az.log"),
		dir:      dir,
	}
	for _, d := range []string{e.bin, e.fixtures} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(e.bin, "az"), []byte(fakeAz), 0o755); err != nil {
		t.Fatal(err)
	}
	// One DPS and one hub in the resource group, as in dev.
	e.reply("resource_list_provisioningServices", dpsName+"\n", 0, "")
	e.reply("resource_list_IotHubs", hubName+"\n", 0, "")
	e.reply("resource_show_IotHubs", hubHost+"\n", 0, "")
	return e
}

func (e *env) reply(key, stdout string, rc int, stderr string) {
	e.t.Helper()
	base := filepath.Join(e.fixtures, key)
	write := func(path, s string) {
		if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
			e.t.Fatal(err)
		}
	}
	write(base+".out", stdout)
	write(base+".err", stderr)
	write(base+".rc", strconv.Itoa(rc))
}

func (e *env) notFound(key string) {
	e.reply(key, "", 3, "ERROR: (ResourceNotFound) "+deviceID+" not found\n")
}

type result struct {
	code   int
	stdout string
	stderr string
	calls  [][]string
}

// run runs a script with bash, the fake az first on PATH, and checks on every
// run that the certificate PEM never reaches stdout or stderr.
func (e *env) run(script string, extraEnv []string, args ...string) result {
	e.t.Helper()
	cmd := exec.Command("bash", append([]string{script}, args...)...)
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "REINSTATE=") || strings.HasPrefix(kv, "PATH=") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env,
		"PATH="+e.bin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"FAKE_AZ_DIR="+e.fixtures,
		"FAKE_AZ_LOG="+e.log,
	)
	cmd.Env = append(env, extraEnv...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	r := result{stdout: stdout.String(), stderr: stderr.String()}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		r.code = exitErr.ExitCode()
	default:
		e.t.Fatalf("running %s: %v", script, err)
	}
	r.calls = e.calls()
	for _, out := range []string{r.stdout, r.stderr} {
		assertNoPEM(e.t, out)
	}
	return r
}

func (e *env) calls() [][]string {
	e.t.Helper()
	b, err := os.ReadFile(e.log)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		e.t.Fatal(err)
	}
	var calls [][]string
	for _, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
		calls = append(calls, strings.Split(strings.TrimSuffix(line, "\x1f"), "\x1f"))
	}
	// The log is per test; start the next run clean.
	if err := os.Remove(e.log); err != nil {
		e.t.Fatal(err)
	}
	return calls
}

var pemBodies []string

func assertNoPEM(t *testing.T, out string) {
	t.Helper()
	if strings.Contains(out, "-----BEGIN") || strings.Contains(out, "-----END") {
		t.Errorf("output contains a PEM marker:\n%s", out)
	}
	for _, body := range pemBodies {
		if strings.Contains(out, body) {
			t.Errorf("output contains certificate PEM content:\n%s", out)
		}
	}
}

// writeCert writes a self-signed certificate with the given subject CN and
// returns its path and its SHA-1 thumbprint as DPS reports it.
func (e *env) writeCert(name, cn string) (path, thumbprint string) {
	e.t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		e.t.Fatal(err)
	}
	// Fixed validity: the scripts never look at dates, and the test never
	// reads the clock.
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: cn, Organization: []string{"MeatGeek"}},
		NotBefore:    time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2036, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		e.t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	lines := strings.Split(string(pemBytes), "\n")
	pemBodies = append(pemBodies, lines[1:len(lines)-2]...) // the base64 body lines
	path = filepath.Join(e.dir, name)
	if err := os.WriteFile(path, pemBytes, 0o644); err != nil {
		e.t.Fatal(err)
	}
	sum := sha1.Sum(der) //nolint:gosec // matching DPS's thumbprint
	return path, strings.ToUpper(hex.EncodeToString(sum[:]))
}

// --- expected az invocations -------------------------------------------------

func split(s string) []string { return strings.Fields(s) }

var (
	callExtension = split("extension show --name azure-iot --output none")
	callListDPS   = split("resource list --resource-group " + rg +
		" --resource-type Microsoft.Devices/provisioningServices --query [].name --output tsv")
	callListHub = split("resource list --resource-group " + rg +
		" --resource-type Microsoft.Devices/IotHubs --query [].name --output tsv")
	callHubHost = split("resource show --resource-group " + rg + " --name " + hubName +
		" --resource-type Microsoft.Devices/IotHubs --query properties.hostName --output tsv")
)

func callEnrollmentShow(auth string) []string {
	return append(split("iot dps enrollment show --dps-name "+dpsName+" --resource-group "+rg+
		" --enrollment-id "+deviceID+" --auth-type "+auth+" --query"),
		"[provisioningStatus, attestation.x509.clientCertificates.primary.info.sha1Thumbprint]",
		"--output", "tsv")
}

func callIdentityShow(auth string) []string {
	return split("iot hub device-identity show --hub-name " + hubName + " --resource-group " + rg +
		" --device-id " + deviceID + " --auth-type " + auth + " --query status --output tsv")
}

func callIdentityStatus(auth, status, reason string) []string {
	return split("iot hub device-identity update --hub-name " + hubName + " --resource-group " + rg +
		" --device-id " + deviceID + " --auth-type " + auth +
		" --status " + status + " --status-reason " + reason + " --output none")
}

func callCreate(auth, cert string) []string {
	return split("iot dps enrollment create --dps-name " + dpsName + " --resource-group " + rg +
		" --enrollment-id " + deviceID + " --auth-type " + auth +
		" --attestation-type x509 --certificate-path " + cert +
		" --device-id " + deviceID + " --provisioning-status enabled" +
		" --allocation-policy static --iot-hubs " + hubHost + " --output none")
}

func callUpdateCert(auth, cert string, extra ...string) []string {
	c := split("iot dps enrollment update --dps-name " + dpsName + " --resource-group " + rg +
		" --enrollment-id " + deviceID + " --auth-type " + auth + " --certificate-path " + cert)
	return append(append(c, extra...), "--output", "none")
}

func callDisableEnrollment(auth string) []string {
	return split("iot dps enrollment update --dps-name " + dpsName + " --resource-group " + rg +
		" --enrollment-id " + deviceID + " --auth-type " + auth +
		" --provisioning-status disabled --output none")
}

func discovery() [][]string { return [][]string{callExtension, callListDPS, callListHub} }

func calls(groups ...[][]string) [][]string {
	var all [][]string
	for _, g := range groups {
		all = append(all, g...)
	}
	return all
}

func assertCalls(t *testing.T, got, want [][]string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("az calls:\n got: %s\nwant: %s", formatCalls(got), formatCalls(want))
	}
}

func formatCalls(cs [][]string) string {
	var b strings.Builder
	for _, c := range cs {
		b.WriteString("\n  az " + strings.Join(c, " "))
	}
	return b.String()
}

func assertResult(t *testing.T, r result, code int, stdout string) {
	t.Helper()
	if r.code != code || r.stdout != stdout {
		t.Errorf("got exit %d stdout %q, want exit %d stdout %q\nstderr:\n%s", r.code, r.stdout, code, stdout, r.stderr)
	}
}

// writes are the az calls that change something.
func writes(cs [][]string) [][]string {
	var w [][]string
	for _, c := range cs {
		for _, a := range c {
			if a == "create" || a == "update" || a == "delete" {
				w = append(w, c)
				break
			}
		}
	}
	return w
}

const (
	enrol  = "enrol-device.sh"
	revoke = "revoke-device.sh"
	del    = "delete-device.sh"
)

// --- enrol-device.sh ---------------------------------------------------------

func TestEnrolNewDevice(t *testing.T) {
	for _, auth := range []string{"key", "login"} {
		t.Run(auth, func(t *testing.T) {
			e := newEnv(t)
			cert, _ := e.writeCert("cert.pem", deviceID)
			e.notFound("iot_dps_enrollment_show")
			args := []string{"--device-id", deviceID, "--certificate", cert}
			if auth == "login" {
				args = append(args, "--auth-type", "login")
			}
			r := e.run(enrol, nil, args...)
			assertResult(t, r, 0, "enrolled "+deviceID+"\n")
			assertCalls(t, r.calls, calls(discovery(), [][]string{
				callEnrollmentShow(auth), callHubHost, callCreate(auth, cert),
			}))
		})
	}
}

func TestEnrolSameCertificateChangesNothing(t *testing.T) {
	e := newEnv(t)
	cert, thumb := e.writeCert("cert.pem", deviceID)
	e.reply("iot_dps_enrollment_show", "enabled\t"+thumb+"\n", 0, "")
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert)
	assertResult(t, r, 0, "unchanged "+deviceID+"\n")
	assertCalls(t, r.calls, calls(discovery(), [][]string{callEnrollmentShow("key")}))
}

func TestEnrolSameCertificateThumbprintCaseAndColons(t *testing.T) {
	e := newEnv(t)
	cert, thumb := e.writeCert("cert.pem", deviceID)
	var colons []string
	for i := 0; i < len(thumb); i += 2 {
		colons = append(colons, strings.ToLower(thumb[i:i+2]))
	}
	e.reply("iot_dps_enrollment_show", "enabled\t"+strings.Join(colons, ":")+"\n", 0, "")
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert)
	assertResult(t, r, 0, "unchanged "+deviceID+"\n")
	assertCalls(t, writes(r.calls), nil)
}

func TestEnrolDifferentCertificateReplacesIt(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", deviceID)
	_, oldThumb := e.writeCert("old.pem", deviceID)
	e.reply("iot_dps_enrollment_show", "enabled\t"+oldThumb+"\n", 0, "")
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert)
	assertResult(t, r, 0, "certificate replaced "+deviceID+"\n")
	assertCalls(t, r.calls, calls(discovery(), [][]string{
		callEnrollmentShow("key"), callUpdateCert("key", cert),
	}))
}

func TestEnrolRevokedIsRefused(t *testing.T) {
	for _, reinstate := range []string{"", "0", "yes"} {
		t.Run("REINSTATE="+reinstate, func(t *testing.T) {
			e := newEnv(t)
			cert, thumb := e.writeCert("cert.pem", deviceID)
			e.reply("iot_dps_enrollment_show", "disabled\t"+thumb+"\n", 0, "")
			var extra []string
			if reinstate != "" {
				extra = []string{"REINSTATE=" + reinstate}
			}
			r := e.run(enrol, extra, "--device-id", deviceID, "--certificate", cert)
			assertResult(t, r, 4, "")
			if !strings.Contains(r.stderr, "revoked") || !strings.Contains(r.stderr, "REINSTATE=1") {
				t.Errorf("stderr does not say revoked and how to reinstate:\n%s", r.stderr)
			}
			assertCalls(t, r.calls, calls(discovery(), [][]string{callEnrollmentShow("key")}))
		})
	}
}

func TestEnrolReinstate(t *testing.T) {
	for _, auth := range []string{"key", "login"} {
		t.Run(auth, func(t *testing.T) {
			e := newEnv(t)
			cert, _ := e.writeCert("cert.pem", deviceID)
			_, oldThumb := e.writeCert("old.pem", deviceID)
			e.reply("iot_dps_enrollment_show", "disabled\t"+oldThumb+"\n", 0, "")
			e.reply("iot_hub_device-identity_show", "disabled\n", 0, "")
			r := e.run(enrol, []string{"REINSTATE=1"},
				"--device-id", deviceID, "--certificate", cert, "--auth-type", auth)
			assertResult(t, r, 0, "reinstated "+deviceID+"\n")
			assertCalls(t, r.calls, calls(discovery(), [][]string{
				callEnrollmentShow(auth),
				callUpdateCert(auth, cert, "--provisioning-status", "enabled"),
				callIdentityShow(auth),
				callIdentityStatus(auth, "enabled", "reinstated"),
			}))
		})
	}
}

func TestEnrolReinstateWithoutHubIdentity(t *testing.T) {
	e := newEnv(t)
	cert, thumb := e.writeCert("cert.pem", deviceID)
	e.reply("iot_dps_enrollment_show", "disabled\t"+thumb+"\n", 0, "")
	e.notFound("iot_hub_device-identity_show")
	r := e.run(enrol, []string{"REINSTATE=1"}, "--device-id", deviceID, "--certificate", cert)
	assertResult(t, r, 0, "reinstated "+deviceID+"\n")
	assertCalls(t, r.calls, calls(discovery(), [][]string{
		callEnrollmentShow("key"),
		callUpdateCert("key", cert, "--provisioning-status", "enabled"),
		callIdentityShow("key"),
	}))
}

func TestEnrolRefusesCNMismatch(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", "meatgeek-pi-8")
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert)
	assertResult(t, r, 2, "")
	if !strings.Contains(r.stderr, "meatgeek-pi-8") || !strings.Contains(r.stderr, "refusing") {
		t.Errorf("stderr does not name the CN and refuse:\n%s", r.stderr)
	}
	assertCalls(t, r.calls, nil)
}

func TestEnrolRefusesANonCertificate(t *testing.T) {
	e := newEnv(t)
	// A PEM that is a key, not a certificate, and plain text.
	_, _ = e.writeCert("unused.pem", deviceID)
	for name, content := range map[string]string{
		"text.pem": "not a certificate\n",
		"key.pem":  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(e.dir, name)
			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", path)
			assertResult(t, r, 2, "")
			if !strings.Contains(r.stderr, "not a PEM X.509 certificate") {
				t.Errorf("stderr does not refuse the file:\n%s", r.stderr)
			}
			if strings.Contains(r.stderr, "MC4CAQAw") {
				t.Errorf("stderr echoes the file:\n%s", r.stderr)
			}
			assertCalls(t, r.calls, nil)
		})
	}
}

func TestEnrolMissingCertificateFile(t *testing.T) {
	e := newEnv(t)
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", filepath.Join(e.dir, "nope.pem"))
	assertResult(t, r, 2, "")
	assertCalls(t, r.calls, nil)
}

func TestDiscoveryNeedsExactlyOne(t *testing.T) {
	cases := []struct {
		name, key, list, want string
	}{
		{"zero DPS", "resource_list_provisioningServices", "", "no DPS (Microsoft.Devices/provisioningServices) in resource group " + rg + "; pass --dps"},
		{"two DPS", "resource_list_provisioningServices", "dps-a\ndps-b\n", "2 DPSs (Microsoft.Devices/provisioningServices) in resource group " + rg + " (dps-a dps-b); pass --dps"},
		{"zero hubs", "resource_list_IotHubs", "", "no IoT hub (Microsoft.Devices/IotHubs) in resource group " + rg + "; pass --hub"},
		{"two hubs", "resource_list_IotHubs", "hub-a\nhub-b\n", "2 IoT hubs (Microsoft.Devices/IotHubs) in resource group " + rg + " (hub-a hub-b); pass --hub"},
	}
	for _, script := range []string{enrol, revoke} {
		for _, c := range cases {
			t.Run(script+"/"+c.name, func(t *testing.T) {
				e := newEnv(t)
				cert, _ := e.writeCert("cert.pem", deviceID)
				e.reply(c.key, c.list, 0, "")
				args := []string{"--device-id", deviceID}
				if script == enrol {
					args = append(args, "--certificate", cert)
				}
				r := e.run(script, nil, args...)
				assertResult(t, r, 1, "")
				if !strings.Contains(r.stderr, c.want) {
					t.Errorf("stderr:\n%s\nwant it to contain %q", r.stderr, c.want)
				}
				assertCalls(t, writes(r.calls), nil)
				for _, call := range r.calls {
					if call[0] == "iot" {
						t.Errorf("an az iot call ran without a resolved DPS and hub: az %s", strings.Join(call, " "))
					}
				}
			})
		}
	}
}

func TestExplicitNamesAreChecked(t *testing.T) {
	e := newEnv(t)
	cert, thumb := e.writeCert("cert.pem", deviceID)
	e.reply("iot_dps_enrollment_show", "enabled\t"+thumb+"\n", 0, "")
	// Azure resource names are case-insensitive; the listed name is used.
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert,
		"--dps", strings.ToUpper(dpsName), "--hub", strings.ToUpper(hubName))
	assertResult(t, r, 0, "unchanged "+deviceID+"\n")
	assertCalls(t, r.calls, calls(discovery(), [][]string{callEnrollmentShow("key")}))
}

// A mistyped --dps or --hub must fail before any device state is read, not
// make the device look missing: revoke would otherwise print "revoked" while
// the real hub identity stays enabled.
func TestExplicitNameNotInResourceGroup(t *testing.T) {
	cases := []struct {
		name, flag, value, key, list, want string
	}{
		{"wrong hub", "--hub", hubName + "-typo", "", "",
			"no IoT hub named " + hubName + "-typo in resource group " + rg + " (it has: " + hubName + "); check --hub"},
		{"wrong DPS", "--dps", dpsName + "-typo", "", "",
			"no DPS named " + dpsName + "-typo in resource group " + rg + " (it has: " + dpsName + "); check --dps"},
		{"hub in an empty resource group", "--hub", hubName, "resource_list_IotHubs", "",
			"no IoT hub named " + hubName + " in resource group " + rg + ": it has no IoT hub (Microsoft.Devices/IotHubs)"},
		{"DPS among several", "--dps", "dps-c", "resource_list_provisioningServices", "dps-a\ndps-b\n",
			"no DPS named dps-c in resource group " + rg + " (it has: dps-a dps-b); check --dps"},
	}
	for _, script := range []string{enrol, revoke} {
		for _, c := range cases {
			t.Run(script+"/"+c.name, func(t *testing.T) {
				e := newEnv(t)
				cert, _ := e.writeCert("cert.pem", deviceID)
				if c.key != "" {
					e.reply(c.key, c.list, 0, "")
				}
				// Were the device state read, it would look missing.
				e.notFound("iot_dps_enrollment_show")
				e.notFound("iot_hub_device-identity_show")
				args := []string{"--device-id", deviceID, c.flag, c.value}
				if script == enrol {
					args = append(args, "--certificate", cert)
				}
				r := e.run(script, nil, args...)
				assertResult(t, r, 1, "")
				if !strings.Contains(r.stderr, c.want) {
					t.Errorf("stderr:\n%s\nwant it to contain %q", r.stderr, c.want)
				}
				for _, call := range r.calls {
					if call[0] == "iot" {
						t.Errorf("an az iot call ran against an unchecked name: az %s", strings.Join(call, " "))
					}
				}
			})
		}
	}
}

// The azure-iot extension exits 3 (ResourceNotFoundError) when it cannot find
// the DPS or hub, or a usable access policy on it. That is a failure, not a
// missing device.
func TestRevokeExtensionCannotFindTheServiceIsAFailure(t *testing.T) {
	cases := []struct {
		name, key, stderr string
	}{
		{"hub not found", "iot_hub_device-identity_show",
			"ERROR: Unable to find IoT Hub: " + hubName + " in resource group: " + rg + "\n"},
		{"no hub policy", "iot_hub_device-identity_show",
			"ERROR: Unable to discover a priviledged policy for IoT Hub: " + hubName + ", in subscription x.\n"},
		{"DPS not found", "iot_dps_enrollment_show",
			"ERROR: Unable to find DPS: " + dpsName + " in resource group: " + rg + "\n"},
		{"no DPS policy", "iot_dps_enrollment_show",
			"ERROR: Unable to discover a privileged policy for DPS: " + dpsName + ".\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
			e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
			e.reply(c.key, "", 3, c.stderr)
			r := e.run(revoke, nil, "--device-id", deviceID)
			assertResult(t, r, 1, "")
			if strings.Contains(r.stdout+r.stderr, "revoked "+deviceID) {
				t.Errorf("reported a revoke that did not happen:\n%s%s", r.stdout, r.stderr)
			}
			if !strings.Contains(r.stderr, "failed (exit 3)") {
				t.Errorf("stderr:\n%s", r.stderr)
			}
			assertCalls(t, writes(r.calls), nil)
		})
	}
}

func TestAuthTypeLoginOnEveryAzIotCall(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", deviceID)
	var all [][]string
	// enrol: new device, then revoke, then reinstate.
	e.notFound("iot_dps_enrollment_show")
	all = append(all, e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert, "--auth-type", "login").calls...)
	e.reply("iot_dps_enrollment_show", "enabled\tX\n", 0, "")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	all = append(all, e.run(revoke, nil, "--device-id", deviceID, "--auth-type", "login").calls...)
	e.reply("iot_dps_enrollment_show", "disabled\tX\n", 0, "")
	e.reply("iot_hub_device-identity_show", "disabled\n", 0, "")
	all = append(all, e.run(enrol, []string{"REINSTATE=1"}, "--device-id", deviceID, "--certificate", cert, "--auth-type", "login").calls...)

	iot := 0
	for _, c := range all {
		if c[0] != "iot" {
			continue
		}
		iot++
		joined := " " + strings.Join(c, " ") + " "
		if !strings.Contains(joined, " --auth-type login ") || strings.Count(joined, "--auth-type") != 1 {
			t.Errorf("az iot call without exactly --auth-type login: az %s", strings.Join(c, " "))
		}
	}
	if iot != 10 {
		t.Errorf("got %d az iot calls, want 10:%s", iot, formatCalls(all))
	}
}

// --- host names (HAR-139) ----------------------------------------------------
//
// CI's identity holds only data-plane roles, so it cannot list or show
// resources in ARM. With --dps and --hub given as host names and
// --auth-type login, the scripts make no ARM call and pass no
// --resource-group to az iot (azure-iot 1.0.0 looks a hub up in ARM by name
// when it gets one, even with a host name).

const dpsHost = dpsName + ".azure-devices-provisioning.net"

var hostArgs = []string{"--dps", dpsHost, "--hub", hubHost, "--auth-type", "login"}

func TestHostNamesEnrolNewDeviceWithoutARM(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", deviceID)
	e.notFound("iot_dps_enrollment_show")
	r := e.run(enrol, nil, append([]string{"--device-id", deviceID, "--certificate", cert}, hostArgs...)...)
	assertResult(t, r, 0, "enrolled "+deviceID+"\n")
	assertCalls(t, r.calls, [][]string{
		callExtension,
		append(split("iot dps enrollment show --dps-name "+dpsHost+
			" --enrollment-id "+deviceID+" --auth-type login --query"),
			"[provisioningStatus, attestation.x509.clientCertificates.primary.info.sha1Thumbprint]",
			"--output", "tsv"),
		split("iot dps enrollment create --dps-name " + dpsHost +
			" --enrollment-id " + deviceID + " --auth-type login" +
			" --attestation-type x509 --certificate-path " + cert +
			" --device-id " + deviceID + " --provisioning-status enabled" +
			" --allocation-policy static --iot-hubs " + hubHost + " --output none"),
	})
}

func TestHostNamesEnrolReplacedCertificateWithoutARM(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", deviceID)
	_, oldThumb := e.writeCert("old.pem", deviceID)
	e.reply("iot_dps_enrollment_show", "enabled\t"+oldThumb+"\n", 0, "")
	r := e.run(enrol, nil, append([]string{"--device-id", deviceID, "--certificate", cert}, hostArgs...)...)
	assertResult(t, r, 0, "certificate replaced "+deviceID+"\n")
	assertNoARM(t, r.calls)
	assertCalls(t, writes(r.calls), [][]string{
		split("iot dps enrollment update --dps-name " + dpsHost +
			" --enrollment-id " + deviceID + " --auth-type login --certificate-path " + cert + " --output none"),
	})
}

func TestHostNamesEnrolReinstateWithoutARM(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", deviceID)
	e.reply("iot_dps_enrollment_show", "disabled\tX\n", 0, "")
	e.reply("iot_hub_device-identity_show", "disabled\n", 0, "")
	r := e.run(enrol, []string{"REINSTATE=1"}, append([]string{"--device-id", deviceID, "--certificate", cert}, hostArgs...)...)
	assertResult(t, r, 0, "reinstated "+deviceID+"\n")
	assertNoARM(t, r.calls)
	assertCalls(t, writes(r.calls), [][]string{
		split("iot dps enrollment update --dps-name " + dpsHost +
			" --enrollment-id " + deviceID + " --auth-type login --certificate-path " + cert +
			" --provisioning-status enabled --output none"),
		split("iot hub device-identity update --hub-name " + hubHost +
			" --device-id " + deviceID + " --auth-type login --status enabled --status-reason reinstated --output none"),
	})
}

func TestHostNamesRevokeWithoutARM(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	r := e.run(revoke, nil, append([]string{"--device-id", deviceID}, hostArgs...)...)
	assertResult(t, r, 0, "revoked "+deviceID+"\n")
	assertCalls(t, r.calls, [][]string{
		callExtension,
		append(split("iot dps enrollment show --dps-name "+dpsHost+
			" --enrollment-id "+deviceID+" --auth-type login --query"),
			"[provisioningStatus, attestation.x509.clientCertificates.primary.info.sha1Thumbprint]",
			"--output", "tsv"),
		split("iot hub device-identity show --hub-name " + hubHost +
			" --device-id " + deviceID + " --auth-type login --query status --output tsv"),
		split("iot dps enrollment update --dps-name " + dpsHost +
			" --enrollment-id " + deviceID + " --auth-type login --provisioning-status disabled --output none"),
		split("iot hub device-identity update --hub-name " + hubHost +
			" --device-id " + deviceID + " --auth-type login --status disabled --status-reason revoked --output none"),
	})
}

// One host name, one resource name: only the named one is looked up in ARM.
func TestHostNameForTheHubOnly(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", deviceID)
	e.notFound("iot_dps_enrollment_show")
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert, "--hub", hubHost, "--auth-type", "login")
	assertResult(t, r, 0, "enrolled "+deviceID+"\n")
	assertCalls(t, r.calls, [][]string{
		callExtension, callListDPS, callEnrollmentShow("login"), callCreate("login", cert),
	})
}

func TestHostNameNeedsLogin(t *testing.T) {
	for _, flag := range []string{"--dps", "--hub"} {
		for _, script := range []string{enrol, revoke} {
			t.Run(script+" "+flag, func(t *testing.T) {
				e := newEnv(t)
				cert, _ := e.writeCert("cert.pem", deviceID)
				host := dpsHost
				if flag == "--hub" {
					host = hubHost
				}
				args := []string{"--device-id", deviceID, flag, host}
				if script == enrol {
					args = append(args, "--certificate", cert)
				}
				r := e.run(script, nil, args...)
				assertResult(t, r, 2, "")
				if !strings.Contains(r.stderr, flag+" "+host+" is a host name, which needs --auth-type login") {
					t.Errorf("stderr:\n%s", r.stderr)
				}
				assertCalls(t, r.calls, nil)
			})
		}
	}
}

func assertNoARM(t *testing.T, cs [][]string) {
	t.Helper()
	for _, c := range cs {
		if c[0] == "resource" {
			t.Errorf("ARM call in host-name mode: az %s", strings.Join(c, " "))
		}
		for _, a := range c {
			if a == "--resource-group" {
				t.Errorf("--resource-group in host-name mode: az %s", strings.Join(c, " "))
			}
		}
	}
}

func TestEnrolRejectsBadAuthType(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", deviceID)
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert, "--auth-type", "token")
	assertResult(t, r, 2, "")
	assertCalls(t, r.calls, nil)
}

func TestMissingAzureIotExtension(t *testing.T) {
	for _, script := range []string{enrol, revoke} {
		t.Run(script, func(t *testing.T) {
			e := newEnv(t)
			cert, _ := e.writeCert("cert.pem", deviceID)
			e.reply("extension_show", "", 1, "ERROR: The extension azure-iot is not installed.\n")
			args := []string{"--device-id", deviceID}
			if script == enrol {
				args = append(args, "--certificate", cert)
			}
			r := e.run(script, nil, args...)
			assertResult(t, r, 1, "")
			if !strings.Contains(r.stderr, "\n  az extension add --name azure-iot\n") {
				t.Errorf("stderr does not give the install line:\n%s", r.stderr)
			}
			assertCalls(t, r.calls, [][]string{callExtension})
		})
	}
}

func TestAzFailureIsReported(t *testing.T) {
	e := newEnv(t)
	cert, _ := e.writeCert("cert.pem", deviceID)
	e.notFound("iot_dps_enrollment_show")
	e.reply("iot_dps_enrollment_create", "", 1,
		"ERROR: Forbidden; connection HostName=x;SharedAccessKeyName=owner;SharedAccessKey=c2VjcmV0a2V5\n")
	r := e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert)
	assertResult(t, r, 1, "")
	if !strings.Contains(r.stderr, "az iot dps enrollment create failed (exit 1)") {
		t.Errorf("stderr does not name the az command and its exit status:\n%s", r.stderr)
	}
	if strings.Contains(r.stderr, "c2VjcmV0a2V5") {
		t.Errorf("stderr shows a key:\n%s", r.stderr)
	}
}

func TestEnrolNeverPrintsThePEM(t *testing.T) {
	// run() checks every run's stdout and stderr; this drives each path once
	// more with the PEM content known to be in the file being read.
	e := newEnv(t)
	cert, thumb := e.writeCert("cert.pem", deviceID)
	mismatch, _ := e.writeCert("other.pem", "someone-else")
	for _, setup := range []func(){
		func() { e.notFound("iot_dps_enrollment_show") },
		func() { e.reply("iot_dps_enrollment_show", "enabled\t"+thumb+"\n", 0, "") },
		func() { e.reply("iot_dps_enrollment_show", "enabled\tOLD\n", 0, "") },
		func() { e.reply("iot_dps_enrollment_show", "disabled\tOLD\n", 0, "") },
	} {
		setup()
		e.run(enrol, nil, "--device-id", deviceID, "--certificate", cert)
		e.run(enrol, []string{"REINSTATE=1"}, "--device-id", deviceID, "--certificate", cert)
	}
	e.run(enrol, nil, "--device-id", deviceID, "--certificate", mismatch)
	if len(pemBodies) == 0 {
		t.Fatal("no PEM bodies recorded to check against")
	}
}

// --- revoke-device.sh --------------------------------------------------------

func TestRevokeEnabledDevice(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	r := e.run(revoke, nil, "--device-id", deviceID)
	assertResult(t, r, 0, "revoked "+deviceID+"\n")
	assertCalls(t, r.calls, calls(discovery(), [][]string{
		callEnrollmentShow("key"),
		callIdentityShow("key"),
		callDisableEnrollment("key"),
		callIdentityStatus("key", "disabled", "revoked"),
	}))
}

func TestRevokeSecondRunIsAlreadyRevoked(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "disabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "disabled\n", 0, "")
	r := e.run(revoke, nil, "--device-id", deviceID)
	assertResult(t, r, 0, "already revoked "+deviceID+"\n")
	assertCalls(t, r.calls, calls(discovery(), [][]string{
		callEnrollmentShow("key"), callIdentityShow("key"),
	}))
}

func TestRevokeUnknownDevice(t *testing.T) {
	e := newEnv(t)
	e.notFound("iot_dps_enrollment_show")
	e.notFound("iot_hub_device-identity_show")
	r := e.run(revoke, nil, "--device-id", deviceID)
	assertResult(t, r, 3, "")
	if !strings.Contains(r.stderr, "no such device "+deviceID) {
		t.Errorf("stderr:\n%s", r.stderr)
	}
	assertCalls(t, writes(r.calls), nil)
}

func TestRevokeOnlyHubIdentity(t *testing.T) {
	e := newEnv(t)
	e.notFound("iot_dps_enrollment_show")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	r := e.run(revoke, nil, "--device-id", deviceID)
	assertResult(t, r, 0, "revoked "+deviceID+" (no DPS enrollment)\n")
	assertCalls(t, r.calls, calls(discovery(), [][]string{
		callEnrollmentShow("key"),
		callIdentityShow("key"),
		callIdentityStatus("key", "disabled", "revoked"),
	}))
}

func TestRevokeOnlyEnrollment(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "", 1, "ERROR: DeviceNotFound: device meatgeek-pi-7 does not exist\n")
	r := e.run(revoke, nil, "--device-id", deviceID)
	assertResult(t, r, 0, "revoked "+deviceID+" (no IoT hub device identity)\n")
	assertCalls(t, r.calls, calls(discovery(), [][]string{
		callEnrollmentShow("key"),
		callIdentityShow("key"),
		callDisableEnrollment("key"),
	}))
}

func TestRevokeReadFailureStopsBeforeWriting(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "", 1, "ERROR: Unauthorized\n")
	r := e.run(revoke, nil, "--device-id", deviceID)
	assertResult(t, r, 1, "")
	if !strings.Contains(r.stderr, "az iot hub device-identity show failed (exit 1)") {
		t.Errorf("stderr:\n%s", r.stderr)
	}
	assertCalls(t, writes(r.calls), nil)
}

func TestUsageErrors(t *testing.T) {
	cases := map[string][]string{
		"revoke without --device-id":  {revoke},
		"revoke bad device id":        {revoke, "--device-id", "bad id"},
		"revoke unknown option":       {revoke, "--device-id", deviceID, "--force", "1"},
		"revoke option without value": {revoke, "--device-id"},
		"enrol without --certificate": {enrol, "--device-id", deviceID},
		"enrol without --device-id":   {enrol, "--certificate", "x.pem"},
	}
	for name, argv := range cases {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			r := e.run(argv[0], nil, argv[1:]...)
			assertResult(t, r, 2, "")
			assertCalls(t, r.calls, nil)
		})
	}
}

func TestHelp(t *testing.T) {
	for _, script := range []string{enrol, revoke, del} {
		e := newEnv(t)
		r := e.run(script, nil, "--help")
		if r.code != 0 || !strings.Contains(r.stdout, "usage: "+script) || !strings.Contains(r.stdout, "Exit codes") {
			t.Errorf("%s --help: exit %d\n%s", script, r.code, r.stdout)
		}
		assertCalls(t, r.calls, nil)
	}
}

// --- delete-device.sh (HAR-140) ----------------------------------------------
//
// CI's fresh acceptance devices are deleted after each run. --only-prefix is
// the catch that keeps CI from ever deleting a real device.

const (
	acceptanceID     = "acceptance-temp-20261122-abc123"
	acceptancePrefix = "acceptance-"
)

func callDeleteEnrollment(id string, svc ...string) []string {
	c := split("iot dps enrollment delete")
	c = append(c, svc...)
	return append(c, split("--enrollment-id "+id+" --auth-type login --output none")...)
}

func callDeleteIdentity(id string, svc ...string) []string {
	c := split("iot hub device-identity delete")
	c = append(c, svc...)
	return append(c, split("--device-id "+id+" --auth-type login --output none")...)
}

func deleteArgs(id string, extra ...string) []string {
	return append(append([]string{"--device-id", id, "--only-prefix", acceptancePrefix}, hostArgs...), extra...)
}

func TestDeleteRefusesAnIdOutsideThePrefix(t *testing.T) {
	for _, id := range []string{deviceID, "meatgeek-dev-simulated-smoker", "xacceptance-1", "acceptance"} {
		t.Run(id, func(t *testing.T) {
			e := newEnv(t)
			e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
			e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
			r := e.run(del, nil, deleteArgs(id)...)
			assertResult(t, r, 4, "")
			if !strings.Contains(r.stderr, "does not start with --only-prefix 'acceptance-'") {
				t.Errorf("stderr:\n%s", r.stderr)
			}
			// Refused before any az call at all, so certainly no write.
			assertCalls(t, r.calls, nil)
		})
	}
}

func TestDeletePrefixIsMatchedLiterally(t *testing.T) {
	e := newEnv(t)
	r := e.run(del, nil, "--device-id", deviceID, "--only-prefix", "*", "--auth-type", "login")
	assertResult(t, r, 4, "")
	assertCalls(t, r.calls, nil)
}

func TestDeleteNeedsOnlyPrefix(t *testing.T) {
	for name, argv := range map[string][]string{
		"no --only-prefix":    {"--device-id", acceptanceID},
		"empty --only-prefix": {"--device-id", acceptanceID, "--only-prefix", ""},
		"no --device-id":      {"--only-prefix", acceptancePrefix},
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			r := e.run(del, nil, argv...)
			assertResult(t, r, 2, "")
			assertCalls(t, r.calls, nil)
		})
	}
}

func TestDeleteDeletesEnrollmentThenIdentity(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	r := e.run(del, nil, deleteArgs(acceptanceID)...)
	assertResult(t, r, 0, "deleted "+acceptanceID+"\n")
	assertNoARM(t, r.calls)
	assertCalls(t, writes(r.calls), [][]string{
		callDeleteEnrollment(acceptanceID, "--dps-name", dpsHost),
		callDeleteIdentity(acceptanceID, "--hub-name", hubHost),
	})
}

func TestDeleteSecondRunIsAlreadyDeleted(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	first := e.run(del, nil, deleteArgs(acceptanceID)...)
	assertResult(t, first, 0, "deleted "+acceptanceID+"\n")
	// Both are gone now.
	e.notFound("iot_dps_enrollment_show")
	e.notFound("iot_hub_device-identity_show")
	second := e.run(del, nil, deleteArgs(acceptanceID)...)
	assertResult(t, second, 0, "already deleted "+acceptanceID+"\n")
	assertCalls(t, writes(second.calls), nil)
}

func TestDeleteOnlyOneExists(t *testing.T) {
	t.Run("only the enrollment", func(t *testing.T) {
		e := newEnv(t)
		e.reply("iot_dps_enrollment_show", "disabled\tABC\n", 0, "")
		e.notFound("iot_hub_device-identity_show")
		r := e.run(del, nil, deleteArgs(acceptanceID)...)
		assertResult(t, r, 0, "deleted "+acceptanceID+" (no IoT hub device identity)\n")
		assertCalls(t, writes(r.calls), [][]string{callDeleteEnrollment(acceptanceID, "--dps-name", dpsHost)})
	})
	t.Run("only the hub identity", func(t *testing.T) {
		e := newEnv(t)
		e.notFound("iot_dps_enrollment_show")
		e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
		r := e.run(del, nil, deleteArgs(acceptanceID)...)
		assertResult(t, r, 0, "deleted "+acceptanceID+" (no DPS enrollment)\n")
		assertCalls(t, writes(r.calls), [][]string{callDeleteIdentity(acceptanceID, "--hub-name", hubHost)})
	})
}

func TestDeleteGoneInBetweenIsNotAFailure(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	e.notFound("iot_hub_device-identity_delete")
	r := e.run(del, nil, deleteArgs(acceptanceID)...)
	assertResult(t, r, 0, "deleted "+acceptanceID+"\n")
}

func TestDeleteFailureIsReported(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	e.reply("iot_dps_enrollment_delete", "", 1, "ERROR: Forbidden\n")
	r := e.run(del, nil, deleteArgs(acceptanceID)...)
	assertResult(t, r, 1, "")
	if !strings.Contains(r.stderr, "az iot dps enrollment delete failed (exit 1)") {
		t.Errorf("stderr:\n%s", r.stderr)
	}
	// Stopped at the enrollment: the hub identity is left for the next run.
	assertCalls(t, writes(r.calls), [][]string{callDeleteEnrollment(acceptanceID, "--dps-name", dpsHost)})
}

func TestDeletePassesAuthTypeLoginOnEveryAzIotCall(t *testing.T) {
	e := newEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tABC\n", 0, "")
	e.reply("iot_hub_device-identity_show", "enabled\n", 0, "")
	r := e.run(del, nil, "--device-id", acceptanceID, "--only-prefix", acceptancePrefix, "--auth-type", "login")
	assertResult(t, r, 0, "deleted "+acceptanceID+"\n")
	iot := 0
	for _, c := range r.calls {
		if c[0] != "iot" {
			continue
		}
		iot++
		joined := " " + strings.Join(c, " ") + " "
		if !strings.Contains(joined, " --auth-type login ") || strings.Count(joined, "--auth-type") != 1 {
			t.Errorf("az iot call without exactly --auth-type login: az %s", strings.Join(c, " "))
		}
	}
	if iot != 4 {
		t.Errorf("got %d az iot calls, want 4 (two shows, two deletes):%s", iot, formatCalls(r.calls))
	}
}

// --- static checks -----------------------------------------------------------

func TestScriptsParse(t *testing.T) {
	scripts := []string{enrol, revoke, del, "device-common.sh"}
	for _, s := range scripts {
		if out, err := exec.Command("bash", "-n", s).CombinedOutput(); err != nil {
			t.Errorf("bash -n %s: %v\n%s", s, err, out)
		}
	}
	t.Run("shellcheck", func(t *testing.T) {
		sc, err := exec.LookPath("shellcheck")
		if err != nil {
			t.Skip("shellcheck is not installed")
		}
		if out, err := exec.Command(sc, append([]string{"-x"}, scripts...)...).CombinedOutput(); err != nil {
			t.Errorf("shellcheck: %v\n%s", err, out)
		}
	})
}
