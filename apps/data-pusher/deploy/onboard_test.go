package deploy

// HAR-144: onboard-pi.sh, run with bash against fake ssh, scp, go and az on a
// PATH that holds nothing else but the ordinary tools the scripts use (so a
// real go or az on the machine running the tests cannot leak in). Every fake
// appends one line per invocation to one log, so the tests assert the order
// of the whole run: preflight, build, install, certificate, enrol, start.

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const (
	piHost      = "pi@10.0.20.48"
	idScope     = "0ne00ABC123"
	piSerial    = "10000000ABCDEF12"
	derivedID   = "meatgeek-abcdef12"
	claimCode   = "7K3M-9QXR-2HTV"
	claimExpiry = "2026-11-24T12:00:00Z"
	webOrigin   = "https://meatgeekv2-web.vercel.app"
	onboard     = "onboard-pi.sh"
	remoteDir   = "/tmp/meatgeek-onboard"
)

// logLine is the logging prologue every fake shares: the tool name, then each
// argument, separated by \x1f.
const logLine = `{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\x1f%s' "$a"; done; printf '\n'; } >>"$FAKE_LOG"
`

// fakeSSH answers by the remote command, from $FAKE_DIR/ssh_<key>.{out,err,rc}.
const fakeSSH = `#!/usr/bin/env bash
set -u
` + logLine + `
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) shift 2 ;;
    -t | -tt | -q) shift ;;
    *) break ;;
  esac
done
shift # the host
cmd="$*"
case "$cmd" in
  true) key=true ;;
  "uname -m") key=uname ;;
  "test -e /dev/spidev0.0") key=spidev ;;
  "cat /proc/device-tree/serial-number") key=dt_serial ;;
  "cat /proc/cpuinfo") key=cpuinfo ;;
  "rm -rf "*) key=prepare ;;
  *"remote-install.sh install "*) key=install ;;
  *"remote-install.sh start "*) key=start ;;
  *) key=other ;;
esac
f="$FAKE_DIR/ssh_$key"
[[ -f "$f.out" ]] && cat "$f.out"
[[ -f "$f.err" ]] && cat "$f.err" >&2
if [[ -f "$f.rc" ]]; then exit "$(cat "$f.rc")"; fi
exit 0
`

// fakeSCP copies an upload into $FAKE_UPLOAD, and answers a download (the
// device certificate) with $FAKE_CERT.
const fakeSCP = `#!/usr/bin/env bash
set -u
` + logLine + `
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) shift 2 ;;
    -q) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
n=${#args[@]}
dest=${args[$((n - 1))]}
if [[ "$dest" == *:* ]]; then
  for ((i = 0; i < n - 1; i++)); do
    cp "${args[$i]}" "$FAKE_UPLOAD/" || exit 1
  done
else
  cp "$FAKE_CERT" "$dest"
fi
`

// fakeGo answers "go env GOVERSION" from $FAKE_DIR/go_version.out (default
// go1.26.1) and "go build -o <path>" by writing a stand-in binary there. A
// build's log line ends with the environment and directory it ran in.
const fakeGo = `#!/usr/bin/env bash
set -u
if [[ "${1:-}" == build ]]; then
  set -- "$@" "@GOOS=${GOOS:-} GOARCH=${GOARCH:-} CGO_ENABLED=${CGO_ENABLED:-} dir=$(basename "$PWD")"
fi
` + logLine + `
case "${1:-}" in
  env)
    if [[ -f "$FAKE_DIR/go_version.out" ]]; then cat "$FAKE_DIR/go_version.out"; else echo go1.26.1; fi
    ;;
  build)
    out=""
    prev=""
    for a in "$@"; do
      [[ "$prev" == -o ]] && out=$a
      prev=$a
    done
    printf 'stand-in for %s\n' "$(basename "$PWD")" >"$out"
    if [[ -f "$FAKE_DIR/go_build.rc" ]]; then exit "$(cat "$FAKE_DIR/go_build.rc")"; fi
    ;;
esac
exit 0
`

// The ordinary tools the scripts and the fakes run; linked into the test's
// own bin directory so nothing else from the host PATH is visible.
var hostTools = []string{
	"bash", "basename", "cat", "chmod", "cmp", "cp", "cut", "dirname", "env", "git",
	"grep", "head", "ls", "mkdir", "mktemp", "mv", "openssl", "rm", "sed", "sort",
	"tail", "tee", "touch", "tr", "wc",
}

type onboardEnv struct {
	*env
	upload string
	cert   string
	tmp    string
}

// newOnboardEnv sets up a fresh Pi (serial 10000000ABCDEF12, aarch64, SPI on)
// that answers the start phase with an unclaimed code, and an Azure with one
// DPS, one hub and no enrollment for the device yet.
func newOnboardEnv(t *testing.T, tools ...string) *onboardEnv {
	t.Helper()
	e := &onboardEnv{env: newEnv(t)}
	e.log = filepath.Join(e.dir, "calls.log")
	e.upload = filepath.Join(e.dir, "pi-upload")
	e.tmp = filepath.Join(e.dir, "tmp")
	for _, d := range []string{e.upload, e.tmp} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// newEnv wrote the HAR-135 fake az; this one logs under the tool name.
	az := strings.Replace(fakeAz, `{ for a in "$@"; do printf '%s\x1f' "$a"; done; printf '\n'; }`,
		`{ printf 'az\x1f'; for a in "$@"; do printf '%s\x1f' "$a"; done; printf '\n'; }`, 1)
	if az == fakeAz {
		t.Fatal("could not adapt the fake az")
	}
	if len(tools) == 0 {
		tools = []string{"ssh", "scp", "go", "az"}
	}
	scripts := map[string]string{"ssh": fakeSSH, "scp": fakeSCP, "go": fakeGo, "az": az}
	if err := os.Remove(filepath.Join(e.bin, "az")); err != nil {
		t.Fatal(err)
	}
	for _, name := range tools {
		if err := os.WriteFile(filepath.Join(e.bin, name), []byte(scripts[name]), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	linkHostTools(t, e.bin)

	e.cert, _ = e.writeCert("device.crt", derivedID)
	e.reply("iot_dps_show", idScope+"\n", 0, "")
	e.notFound("iot_dps_enrollment_show")
	e.reply("ssh_uname", "aarch64\n", 0, "")
	e.reply("ssh_dt_serial", piSerial+"\x00", 0, "")
	e.startReply(`{"deviceId":"`+derivedID+`","state":"unclaimed","claimCode":"`+claimCode+`","expiresAt":"`+claimExpiry+`"}`, 0)
	return e
}

func linkHostTools(t *testing.T, bin string) {
	t.Helper()
	for _, tool := range hostTools {
		if _, err := os.Stat(filepath.Join(bin, tool)); err == nil {
			continue // a fake
		}
		p, err := exec.LookPath(tool)
		if err != nil {
			if tool == "git" {
				continue // the script falls back to version "dev"
			}
			t.Fatalf("%s is not installed: %v", tool, err)
		}
		if err := os.Symlink(p, filepath.Join(bin, tool)); err != nil {
			t.Fatal(err)
		}
	}
}

// startReply is the start phase's output as it arrives through ssh -t: sudo's
// prompt, the remote's progress, the claim line between markers, and the
// service states, every line ending \r\n.
func (e *onboardEnv) startReply(claimLine string, rc int) {
	e.t.Helper()
	lines := []string{
		"[sudo] password for pi: ",
		"remote-install.sh: started the pusher; waiting for it to register with DPS (at most 120 s)",
		"MEATGEEK-CLAIM-BEGIN", claimLine, "MEATGEEK-CLAIM-END",
		"meatgeek-controller.service: active", "meatgeek-pusher.service: active",
	}
	e.reply("ssh_start", strings.Join(lines, "\r\n")+"\r\n", rc, "")
}

type call struct {
	tool string
	args []string
}

func (c call) String() string { return c.tool + " " + strings.Join(c.args, " ") }

type onboardResult struct {
	code           int
	stdout, stderr string
	calls          []call
}

func (e *onboardEnv) run(extraEnv []string, args ...string) onboardResult {
	e.t.Helper()
	cmd := exec.Command(filepath.Join(e.bin, "bash"), append([]string{onboard}, args...)...)
	cmd.Env = append([]string{
		"PATH=" + e.bin,
		"HOME=" + e.dir,
		"TMPDIR=" + e.tmp,
		"FAKE_LOG=" + e.log,
		"FAKE_AZ_LOG=" + e.log,
		"FAKE_DIR=" + e.fixtures,
		"FAKE_AZ_DIR=" + e.fixtures,
		"FAKE_UPLOAD=" + e.upload,
		"FAKE_CERT=" + e.cert,
	}, extraEnv...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	r := onboardResult{stdout: stdout.String(), stderr: stderr.String()}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		r.code = exitErr.ExitCode()
	default:
		e.t.Fatalf("running %s: %v", onboard, err)
	}
	r.calls = readCalls(e.t, e.log)
	assertNoPEM(e.t, r.stdout)
	assertNoPEM(e.t, r.stderr)
	return r
}

func readCalls(t *testing.T, log string) []call {
	t.Helper()
	b, err := os.ReadFile(log)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(log); err != nil {
		t.Fatal(err)
	}
	var cs []call
	for _, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
		f := strings.Split(strings.TrimSuffix(line, "\x1f"), "\x1f")
		cs = append(cs, call{tool: f[0], args: f[1:]})
	}
	return cs
}

// remoteCommand is an ssh call's command on the Pi, without the options and
// the host.
func remoteCommand(c call) string {
	a := c.args
	for len(a) > 0 {
		switch a[0] {
		case "-o":
			a = a[2:]
			continue
		case "-t", "-tt", "-q":
			a = a[1:]
			continue
		}
		break
	}
	if len(a) == 0 {
		return ""
	}
	return strings.Join(a[1:], " ")
}

func sshReadOnly(c call) bool {
	switch remoteCommand(c) {
	case "true", "uname -m", "test -e /dev/spidev0.0", "cat /proc/device-tree/serial-number", "cat /proc/cpuinfo":
		return true
	}
	return false
}

// remoteWrites are the calls that change the Pi: any scp, and any ssh that is
// not one of the preflight reads.
func remoteWrites(cs []call) []call {
	var w []call
	for _, c := range cs {
		if c.tool == "scp" || (c.tool == "ssh" && !sshReadOnly(c)) {
			w = append(w, c)
		}
	}
	return w
}

// steps names each call by the step of the run it belongs to, merging runs of
// the same step.
func steps(cs []call) []string {
	var out []string
	downloaded := false
	for _, c := range cs {
		var s string
		switch {
		case c.tool == "go" && len(c.args) > 0 && c.args[0] == "build":
			s = "build"
		case c.tool == "go":
			s = "go version"
		case c.tool == "az" && downloaded:
			s = "enrol"
		case c.tool == "az":
			s = "az preflight"
		case c.tool == "ssh" && sshReadOnly(c):
			s = "ssh preflight"
		case c.tool == "ssh" && strings.HasPrefix(remoteCommand(c), "rm -rf "):
			s = "prepare"
		case c.tool == "ssh" && strings.Contains(remoteCommand(c), "remote-install.sh install "):
			s = "install"
		case c.tool == "ssh" && strings.Contains(remoteCommand(c), "remote-install.sh start "):
			s = "start"
		case c.tool == "scp" && strings.HasPrefix(c.args[len(c.args)-1], piHost+":"):
			s = "upload"
		case c.tool == "scp":
			s = "certificate"
			downloaded = true
		default:
			s = "other: " + c.String()
		}
		if len(out) == 0 || out[len(out)-1] != s {
			out = append(out, s)
		}
	}
	return out
}

func find(cs []call, pred func(call) bool) []call {
	var got []call
	for _, c := range cs {
		if pred(c) {
			got = append(got, c)
		}
	}
	return got
}

func unclaimedOutput(id string) string {
	return "\nDevice id:   " + id + "\n" +
		"Claim code:  " + claimCode + "\n" +
		"Expires:     " + claimExpiry + "\n" +
		"Claim it at: " + webOrigin + "/devices/claim?deviceId=" + id + "\n"
}

// --- a full run ----------------------------------------------------------------

func TestOnboardFreshPi(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	r := e.run(nil, piHost)
	if r.code != 0 || r.stdout != unclaimedOutput(derivedID) {
		t.Fatalf("exit %d, stdout:\n%s\nwant:\n%s\nstderr:\n%s", r.code, r.stdout, unclaimedOutput(derivedID), r.stderr)
	}

	want := []string{"go version", "az preflight", "ssh preflight", "build", "prepare", "upload",
		"install", "certificate", "enrol", "start"}
	if got := steps(r.calls); strings.Join(got, " → ") != strings.Join(want, " → ") {
		t.Errorf("steps:\n got: %s\nwant: %s", strings.Join(got, " → "), strings.Join(want, " → "))
	}

	// Build: both binaries, linux/arm64 without cgo, into the bundle.
	builds := find(r.calls, func(c call) bool { return c.tool == "go" && c.args[0] == "build" })
	if len(builds) != 2 {
		t.Fatalf("got %d go builds, want 2: %v", len(builds), builds)
	}
	for i, w := range []struct{ dir, out, pkg string }{
		{"device-controller", "/bundle/meatgeek-controller", "."},
		{"data-pusher", "/bundle/meatgeek-pusher", "./cmd"},
	} {
		a := builds[i].args
		envField := a[len(a)-1]
		if envField != "@GOOS=linux GOARCH=arm64 CGO_ENABLED=0 dir="+w.dir {
			t.Errorf("build %d ran with %s", i, envField)
		}
		if a[len(a)-2] != w.pkg || !strings.HasSuffix(a[len(a)-3], w.out) {
			t.Errorf("build %d: go %s", i, strings.Join(a, " "))
		}
	}

	// The bundle on the Pi: both binaries, the units, the rule, the script.
	entries, err := os.ReadDir(e.upload)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, en := range entries {
		names = append(names, en.Name())
	}
	if got := strings.Join(names, " "); got != "99-meatgeek.rules meatgeek-controller meatgeek-controller.service meatgeek-pusher meatgeek-pusher.service remote-install.sh" {
		t.Errorf("uploaded: %s", got)
	}
	for _, f := range []string{"remote-install.sh", "meatgeek-pusher.service", "99-meatgeek.rules"} {
		got, _ := os.ReadFile(filepath.Join(e.upload, f))
		want, _ := os.ReadFile(f)
		if !bytes.Equal(got, want) {
			t.Errorf("uploaded %s differs from the repository's", f)
		}
	}

	// The two root phases, each one ssh -t with sudo.
	for _, w := range []string{
		"sudo bash " + remoteDir + "/remote-install.sh install --device-id " + derivedID,
		"sudo bash " + remoteDir + "/remote-install.sh start --device-id " + derivedID + " --id-scope " + idScope,
	} {
		got := find(r.calls, func(c call) bool { return c.tool == "ssh" && remoteCommand(c) == w })
		if len(got) != 1 || !contains(got[0].args, "-t") {
			t.Errorf("want one ssh -t %q, got %v", w, got)
		}
	}
	if n := len(find(r.calls, func(c call) bool { return strings.Contains(c.String(), "sudo") })); n != 2 {
		t.Errorf("%d calls use sudo, want 2 (one per root phase)", n)
	}

	// Enrolled with the certificate the Pi printed, in the discovered DPS.
	creates := find(r.calls, func(c call) bool {
		return c.tool == "az" && strings.HasPrefix(strings.Join(c.args, " "), "iot dps enrollment create")
	})
	if len(creates) != 1 || !strings.Contains(strings.Join(creates[0].args, " "),
		"--dps-name "+dpsName+" --resource-group "+rg+" --enrollment-id "+derivedID+" --auth-type key") {
		t.Errorf("enrollment create: %v", creates)
	}
	// The ID scope came from the DPS resource.
	if got := find(r.calls, func(c call) bool {
		return c.tool == "az" && strings.Join(c.args, " ") ==
			"iot dps show --name "+dpsName+" --resource-group "+rg+" --query properties.idScope --output tsv"
	}); len(got) != 1 {
		t.Errorf("want one az iot dps show for the ID scope")
	}

	// The laptop's temporary files are gone.
	if left, _ := os.ReadDir(e.tmp); len(left) != 0 {
		t.Errorf("left in TMPDIR: %v", left)
	}
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func TestOnboardSecondRunOnASetUpPi(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	// The enrollment holds this very certificate: enrol says unchanged.
	certThumb := certThumbprint(t, e.cert)
	e.reply("iot_dps_enrollment_show", "enabled\t"+certThumb+"\n", 0, "")
	r := e.run(nil, piHost)
	if r.code != 0 || r.stdout != unclaimedOutput(derivedID) {
		t.Fatalf("exit %d, stdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if !strings.Contains(r.stderr, "unchanged "+derivedID) {
		t.Errorf("stderr does not show the enrollment unchanged:\n%s", r.stderr)
	}
	for _, c := range r.calls {
		if c.tool == "az" && (contains(c.args, "create") || contains(c.args, "update")) {
			t.Errorf("a second run changed Azure: %s", c)
		}
	}
}

func certThumbprint(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("openssl", "x509", "-in", path, "-noout", "-fingerprint", "-sha1").Output()
	if err != nil {
		t.Fatal(err)
	}
	f := strings.TrimSpace(string(out))
	thumb := strings.ToUpper(strings.ReplaceAll(f[strings.Index(f, "=")+1:], ":", ""))
	return thumb
}

func TestOnboardReplacedCertificateIsFine(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("iot_dps_enrollment_show", "enabled\tOLDTHUMBPRINT\n", 0, "")
	r := e.run(nil, piHost)
	if r.code != 0 || r.stdout != unclaimedOutput(derivedID) {
		t.Fatalf("exit %d, stdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if !strings.Contains(r.stderr, "certificate replaced "+derivedID) {
		t.Errorf("stderr:\n%s", r.stderr)
	}
}

// --- claim state ---------------------------------------------------------------

func TestOnboardAlreadyClaimed(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.startReply(`{"deviceId":"`+derivedID+`","state":"claimed"}`, 0)
	r := e.run(nil, piHost)
	want := "\nDevice id:   " + derivedID + "\nalready claimed: release it in the web app to claim it again\n"
	if r.code != 0 || r.stdout != want {
		t.Errorf("exit %d, stdout %q, want %q\nstderr:\n%s", r.code, r.stdout, want, r.stderr)
	}
}

func TestOnboardWebOrigin(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	r := e.run(nil, piHost, "--web-origin", "http://localhost:4200/")
	if r.code != 0 || !strings.Contains(r.stdout, "Claim it at: http://localhost:4200/devices/claim?deviceId="+derivedID+"\n") {
		t.Errorf("exit %d, stdout:\n%s", r.code, r.stdout)
	}
}

func TestOnboardRefusesAnOddClaimLine(t *testing.T) {
	t.Parallel()
	for name, line := range map[string]string{
		"expired":        `{"deviceId":"` + derivedID + `","state":"expired"}`,
		"another device": `{"deviceId":"meatgeek-00000000","state":"unclaimed","claimCode":"` + claimCode + `","expiresAt":"` + claimExpiry + `"}`,
		"no line":        "",
	} {
		t.Run(name, func(t *testing.T) {
			e := newOnboardEnv(t)
			e.startReply(line, 0)
			r := e.run(nil, piHost)
			if r.code != 1 || r.stdout != "" {
				t.Errorf("exit %d, stdout %q\nstderr:\n%s", r.code, r.stdout, r.stderr)
			}
		})
	}
}

// The code reaches only this terminal: stdout, and the remote's output shown
// as it arrives. Never a file on the laptop, never a URL, never a command's
// arguments.
func TestOnboardClaimCodeNeverInAFileOrURL(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	r := e.run(nil, piHost)
	if r.code != 0 || !strings.Contains(r.stdout, "Claim code:  "+claimCode+"\n") {
		t.Fatalf("exit %d, stdout:\n%s", r.code, r.stdout)
	}
	bare := strings.ReplaceAll(claimCode, "-", "")
	for _, line := range strings.Split(r.stdout+r.stderr, "\n") {
		if strings.Contains(line, "://") && (strings.Contains(line, claimCode) || strings.Contains(line, bare)) {
			t.Errorf("the code is in a URL: %s", line)
		}
	}
	for _, c := range r.calls {
		if strings.Contains(c.String(), claimCode) || strings.Contains(c.String(), bare) {
			t.Errorf("the code is in a command's arguments: %s", c)
		}
	}
	// Every file under the test's directory except the fake Pi's fixtures,
	// which stand in for the device.
	err := filepath.WalkDir(e.dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == e.fixtures {
				return filepath.SkipDir
			}
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil // a dangling host-tool link
		}
		if bytes.Contains(b, []byte(claimCode)) || bytes.Contains(b, []byte(bare)) {
			t.Errorf("the code is in a file: %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// --- the device id -------------------------------------------------------------

func TestOnboardDeviceIDFromTheDeviceTree(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("ssh_dt_serial", "00000000DEADBEEF\x00", 0, "")
	e.cert, _ = e.writeCert("device2.crt", "meatgeek-deadbeef")
	e.startReply(`{"deviceId":"meatgeek-deadbeef","state":"claimed"}`, 0)
	r := e.run(nil, piHost)
	if r.code != 0 || !strings.Contains(r.stdout, "Device id:   meatgeek-deadbeef\n") {
		t.Fatalf("exit %d, stdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if len(find(r.calls, func(c call) bool { return remoteCommand(c) == "cat /proc/cpuinfo" })) != 0 {
		t.Errorf("read /proc/cpuinfo although the device tree had the serial")
	}
}

func TestOnboardDeviceIDFromCPUInfo(t *testing.T) {
	t.Parallel()
	cpuinfo := "processor\t: 0\nBogoMIPS\t: 108.00\n\nHardware\t: BCM2835\nRevision\t: c03111\nSerial\t\t: 100000001234ABCD\nModel\t\t: Raspberry Pi 4 Model B Rev 1.1\n"
	for name, dt := range map[string]func(e *onboardEnv){
		"no device-tree serial": func(e *onboardEnv) {
			e.reply("ssh_dt_serial", "", 1, "cat: /proc/device-tree/serial-number: No such file or directory\n")
		},
		"an empty device-tree serial": func(e *onboardEnv) { e.reply("ssh_dt_serial", "\x00", 0, "") },
	} {
		t.Run(name, func(t *testing.T) {
			e := newOnboardEnv(t)
			dt(e)
			e.reply("ssh_cpuinfo", cpuinfo, 0, "")
			e.cert, _ = e.writeCert("device2.crt", "meatgeek-1234abcd")
			e.startReply(`{"deviceId":"meatgeek-1234abcd","state":"claimed"}`, 0)
			r := e.run(nil, piHost)
			if r.code != 0 || !strings.Contains(r.stdout, "Device id:   meatgeek-1234abcd\n") {
				t.Fatalf("exit %d, stdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
			}
			if got := find(r.calls, func(c call) bool {
				return strings.Contains(remoteCommand(c), "install --device-id meatgeek-1234abcd")
			}); len(got) != 1 {
				t.Errorf("install did not get the cpuinfo id")
			}
		})
	}
}

func TestOnboardDeviceIDGiven(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.cert, _ = e.writeCert("device2.crt", "smoker-1")
	e.startReply(`{"deviceId":"smoker-1","state":"claimed"}`, 0)
	r := e.run(nil, piHost, "--device-id", "smoker-1")
	if r.code != 0 || !strings.Contains(r.stdout, "Device id:   smoker-1\n") {
		t.Fatalf("exit %d, stdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if got := find(r.calls, func(c call) bool { return strings.HasPrefix(remoteCommand(c), "cat ") }); len(got) != 0 {
		t.Errorf("read the serial although --device-id was given: %v", got)
	}
}

func TestOnboardNoSerialAsksForDeviceID(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("ssh_dt_serial", "", 1, "")
	e.reply("ssh_cpuinfo", "processor\t: 0\nModel\t\t: something\n", 0, "")
	r := e.run(nil, piHost)
	if r.code != 2 || !strings.Contains(r.stderr, "pass --device-id") {
		t.Errorf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	if w := remoteWrites(r.calls); len(w) != 0 {
		t.Errorf("changed the Pi: %v", w)
	}
}

func TestOnboardInvalidDeviceID(t *testing.T) {
	t.Parallel()
	for name, id := range map[string]string{
		"too long":     strings.Repeat("a", 129),
		"a space":      "bad id",
		"a slash":      "has/slash",
		"shell syntax": "x;reboot",
	} {
		t.Run(name, func(t *testing.T) {
			e := newOnboardEnv(t)
			r := e.run(nil, piHost, "--device-id", id)
			if r.code != 2 || !strings.Contains(r.stderr, "is not valid") {
				t.Errorf("exit %d\nstderr:\n%s", r.code, r.stderr)
			}
			if len(r.calls) != 0 {
				t.Errorf("ran commands before refusing the id: %v", r.calls)
			}
		})
	}
	// 128 characters is the limit, and allowed.
	e := newOnboardEnv(t)
	long := strings.Repeat("a", 128)
	e.cert, _ = e.writeCert("long.crt", long)
	e.startReply(`{"deviceId":"`+long+`","state":"claimed"}`, 0)
	if r := e.run(nil, piHost, "--device-id", long); r.code != 0 {
		t.Errorf("128 characters: exit %d\nstderr:\n%s", r.code, r.stderr)
	}
}

// --- preflight -----------------------------------------------------------------

func TestOnboardPreflightFailures(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		tools []string // the fakes on PATH; nil means all four
		setup func(e *onboardEnv)
		fix   string
	}{
		{"go missing", []string{"ssh", "scp", "az"}, nil, "fix: brew install go"},
		{"go too old", nil, func(e *onboardEnv) { e.reply("go_version", "go1.22.5\n", 0, "") }, "fix: brew upgrade go"},
		{"az missing", []string{"ssh", "scp", "go"}, nil, "fix: brew install azure-cli"},
		{"az not signed in", nil, func(e *onboardEnv) {
			e.reply("account_show", "", 1, "ERROR: Please run 'az login' to setup account.\n")
		}, "fix: az login"},
		{"no azure-iot extension", nil, func(e *onboardEnv) {
			e.reply("extension_show", "", 1, "ERROR: The extension azure-iot is not installed.\n")
		}, "fix: az extension add --name azure-iot"},
		{"no DPS", nil, func(e *onboardEnv) { e.reply("resource_list_provisioningServices", "", 0, "") },
			"no DPS (Microsoft.Devices/provisioningServices) in resource group " + rg + "; pass --dps"},
		{"two hubs", nil, func(e *onboardEnv) { e.reply("resource_list_IotHubs", "hub-a\nhub-b\n", 0, "") },
			"2 IoT hubs (Microsoft.Devices/IotHubs) in resource group " + rg + " (hub-a hub-b); pass --hub"},
		{"ssh refused", nil, func(e *onboardEnv) {
			e.reply("ssh_true", "", 255, "pi@10.0.20.48: Permission denied (publickey,password).\n")
		}, "fix: ssh-copy-id " + piHost},
		{"32-bit Pi", nil, func(e *onboardEnv) { e.reply("ssh_uname", "armv7l\n", 0, "") },
			"fix: flash a 64-bit (arm64) Debian image on the Pi"},
		{"SPI off", nil, func(e *onboardEnv) { e.reply("ssh_spidev", "", 1, "") },
			"fix: add dtparam=spi=on to /boot/firmware/config.txt on the Pi, then sudo reboot"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newOnboardEnv(t, c.tools...)
			if c.setup != nil {
				c.setup(e)
			}
			r := e.run(nil, piHost)
			if r.code != 1 || r.stdout != "" || !strings.Contains(r.stderr, c.fix) {
				t.Errorf("exit %d, stdout %q\nstderr:\n%s\nwant it to contain %q", r.code, r.stdout, r.stderr, c.fix)
			}
			if w := remoteWrites(r.calls); len(w) != 0 {
				t.Errorf("changed the Pi before preflight passed: %v", w)
			}
			for _, call := range r.calls {
				if call.tool == "go" && contains(call.args, "build") {
					t.Errorf("built before preflight passed")
				}
				if call.tool == "az" && contains(call.args, "enrollment") {
					t.Errorf("touched the enrollment before preflight passed: %s", call)
				}
			}
		})
	}
}

func TestOnboardUsageErrors(t *testing.T) {
	t.Parallel()
	for name, args := range map[string][]string{
		"no host":         nil,
		"two hosts":       {piHost, "pi@other"},
		"option as host":  {"-oProxyCommand=x"},
		"bad auth type":   {piHost, "--auth-type", "token"},
		"DPS host name":   {piHost, "--dps", dpsName + ".azure-devices-provisioning.net"},
		"unknown option":  {piHost, "--force", "1"},
		"missing a value": {piHost, "--web-origin"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newOnboardEnv(t)
			r := e.run(nil, args...)
			if r.code != 2 {
				t.Errorf("exit %d\nstderr:\n%s", r.code, r.stderr)
			}
			if len(r.calls) != 0 {
				t.Errorf("ran commands on a usage error: %v", r.calls)
			}
		})
	}
	e := newOnboardEnv(t)
	if r := e.run(nil, "--help"); r.code != 0 || !strings.Contains(r.stdout, "usage: onboard-pi.sh") || !strings.Contains(r.stdout, "Exit codes") {
		t.Errorf("--help: exit %d\n%s", r.code, r.stdout)
	}
}

// --- stops -----------------------------------------------------------------------

func TestOnboardRevokedStopsBeforeStart(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("iot_dps_enrollment_show", "disabled\tOLD\n", 0, "")
	r := e.run(nil, piHost)
	if r.code != 4 || r.stdout != "" ||
		!strings.Contains(r.stderr, "this device was revoked; re-run with REINSTATE=1 if you mean to bring it back") {
		t.Errorf("exit %d, stdout %q\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if got := steps(r.calls); got[len(got)-1] != "enrol" {
		t.Errorf("did not stop at enrol: %v", got)
	}
}

func TestOnboardReinstatePassesThrough(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("iot_dps_enrollment_show", "disabled\tOLD\n", 0, "")
	e.reply("iot_hub_device-identity_show", "disabled\n", 0, "")
	r := e.run([]string{"REINSTATE=1"}, piHost)
	if r.code != 0 || r.stdout != unclaimedOutput(derivedID) || !strings.Contains(r.stderr, "reinstated "+derivedID) {
		t.Errorf("exit %d, stdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
}

func TestOnboardI2CRebootStopsCleanly(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("ssh_install", "remote-install.sh: I2C was off; reboot the Pi (`sudo reboot`) and run the same command again\r\n", 4, "")
	r := e.run(nil, piHost)
	if r.code != 4 || r.stdout != "" || !strings.Contains(r.stderr, "run the same command again") {
		t.Errorf("exit %d, stdout %q\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if got := steps(r.calls); got[len(got)-1] != "install" {
		t.Errorf("did not stop after install: %v", got)
	}
	if left, _ := os.ReadDir(e.tmp); len(left) != 0 {
		t.Errorf("left in TMPDIR: %v", left)
	}
}

func TestOnboardInstallFailureStops(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("ssh_install", "", 1, "sudo: 3 incorrect password attempts\n")
	r := e.run(nil, piHost)
	if r.code != 1 || !strings.Contains(r.stderr, "the install on "+piHost+" failed (exit 1)") {
		t.Errorf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	if got := steps(r.calls); got[len(got)-1] != "install" {
		t.Errorf("did not stop after install: %v", got)
	}
}

func TestOnboardBuildFailureStopsBeforeThePi(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("go_build", "", 1, "")
	r := e.run(nil, piHost)
	if r.code == 0 {
		t.Fatalf("exit 0 after a failed build")
	}
	if w := remoteWrites(r.calls); len(w) != 0 {
		t.Errorf("changed the Pi after a failed build: %v", w)
	}
}

func TestOnboardRegistrationTimeout(t *testing.T) {
	t.Parallel()
	e := newOnboardEnv(t)
	e.reply("ssh_start", "remote-install.sh: the pusher did not register within 120 s; its last 30 log lines:\r\n", 5, "")
	r := e.run(nil, piHost)
	if r.code != 5 || r.stdout != "" || !strings.Contains(r.stderr, "journalctl -u meatgeek-pusher") {
		t.Errorf("exit %d, stdout %q\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
}
