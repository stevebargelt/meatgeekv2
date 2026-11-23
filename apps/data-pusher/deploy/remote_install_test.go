package deploy

// HAR-144: remote-install.sh, run against a temporary directory as the Pi's
// root (MEATGEEK_ROOT), with fake systemctl, useradd, getent, udevadm,
// runuser, modprobe, chown, journalctl and sleep on PATH, and a fake
// meatgeek-pusher as the installed binary. The fake sleep is the wait's only
// clock: it counts polls and never sleeps.

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const remoteScript = "remote-install.sh"

// fakeSystemctl keeps each unit's enabled and active state as marker files in
// $FAKE_STATE.
const fakeSystemctl = `#!/usr/bin/env bash
set -u
` + logLine + `
quiet=0
verb=$1
shift
if [[ "${1:-}" == --quiet ]]; then quiet=1; shift; fi
unit=${1:-}
answer() { [[ $quiet -eq 1 ]] || echo "$1"; exit "$2"; }
case "$verb" in
  is-active)
    if [[ -f "$FAKE_STATE/$unit.active" ]]; then answer active 0; else answer inactive 3; fi ;;
  is-enabled)
    if [[ -f "$FAKE_STATE/$unit.enabled" ]]; then answer enabled 0; else answer disabled 1; fi ;;
  enable) touch "$FAKE_STATE/$unit.enabled" ;;
  start | restart) touch "$FAKE_STATE/$unit.active" ;;
esac
exit 0
`

const fakeUseradd = `#!/usr/bin/env bash
set -u
` + logLine + `
touch "$FAKE_STATE/user-created"
`

const fakeGetent = `#!/usr/bin/env bash
set -u
` + logLine + `
[[ -f "$FAKE_STATE/user-created" ]] || exit 2
echo "meatgeek:x:999:999::/nonexistent:/usr/sbin/nologin"
`

// fakeRunuser checks the shape "runuser -u meatgeek -- <command>" and runs
// the command as the current user.
const fakeRunuser = `#!/usr/bin/env bash
set -u
` + logLine + `
[[ "$1" == -u && "$2" == meatgeek && "$3" == -- ]] || { echo "fake runuser: unexpected $*" >&2; exit 64; }
shift 3
exec "$@"
`

// fakeRecorder only records: udevadm, modprobe, chown.
const fakeRecorder = `#!/usr/bin/env bash
set -u
` + logLine + `
exit 0
`

const fakeJournalctl = `#!/usr/bin/env bash
set -u
` + logLine + `
echo "meatgeek-pusher: DPS registration refused (401)"
`

// fakeSleep counts polls in $FAKE_STATE/sleeps, and creates the pusher's
// cached DPS assignment ($FAKE_ASSIGNMENT) once FAKE_ASSIGN_AFTER polls have
// passed. It never sleeps.
const fakeSleep = `#!/usr/bin/env bash
set -u
` + logLine + `
n=$(cat "$FAKE_STATE/sleeps" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" >"$FAKE_STATE/sleeps"
if [[ -n "${FAKE_ASSIGN_AFTER:-}" && $n -ge $FAKE_ASSIGN_AFTER ]]; then
  mkdir -p "$(dirname "$FAKE_ASSIGNMENT")"
  echo '{"assignedHub":"hub","deviceId":"x"}' >"$FAKE_ASSIGNMENT"
fi
`

// fakePusher stands in for the installed meatgeek-pusher. identity init
// creates a key and a certificate once and prints the certificate (or, with
// FAKE_PRINT_KEY=1, the key too). claim-code has no code until
// FAKE_CLAIM_AFTER polls, an expired one until FAKE_EXPIRED_UNTIL polls, and
// then prints $FAKE_DIR/claim.out.
const fakePusher = `#!/usr/bin/env bash
set -u
` + logLine + `
sd=""
id=""
prev=""
for a in "$@"; do
  [[ "$prev" == --state-dir ]] && sd=$a
  [[ "$prev" == --device-id ]] && id=$a
  prev=$a
done
case "$1" in
  identity)
    mkdir -p "$sd/identity"
    if [[ ! -f "$sd/identity/device.key" ]]; then
      # Split, so this script's own text does not hold the key material.
      printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "FAKEKEY""MATERIAL" >"$sd/identity/device.key"
      printf -- '-----BEGIN CERTIFICATE-----\nFAKECERT-%s\n-----END CERTIFICATE-----\n' "$id" >"$sd/identity/device.crt"
    fi
    [[ "${FAKE_PRINT_KEY:-}" == 1 ]] && cat "$sd/identity/device.key"
    cat "$sd/identity/device.crt"
    ;;
  claim-code)
    n=$(cat "$FAKE_STATE/sleeps" 2>/dev/null || echo 0)
    if [[ $n -lt ${FAKE_CLAIM_AFTER:-0} ]]; then
      echo "meatgeek-pusher claim-code: no claim code yet" >&2
      exit 3
    fi
    if [[ $n -lt ${FAKE_EXPIRED_UNTIL:-0} ]]; then
      echo '{"deviceId":"meatgeek-abcdef12","state":"expired"}'
      exit 0
    fi
    cat "$FAKE_DIR/claim.out"
    ;;
esac
`

const unclaimedLine = `{"deviceId":"meatgeek-abcdef12","state":"unclaimed","claimCode":"7K3M-9QXR-2HTV","expiresAt":"2026-11-24T12:00:00Z"}`

type piEnv struct {
	t                          *testing.T
	dir, root, bin, state, log string
	fixtures, bundle           string
	extraEnv                   []string
}

// newPiEnv lays out a fresh Pi: I2C on (/dev/i2c-1 exists), Debian's
// config.txt, and the bundle onboard-pi.sh copies to /tmp/meatgeek-onboard.
func newPiEnv(t *testing.T) *piEnv {
	t.Helper()
	dir := t.TempDir()
	e := &piEnv{
		t:        t,
		dir:      dir,
		root:     filepath.Join(dir, "root"),
		bin:      filepath.Join(dir, "bin"),
		state:    filepath.Join(dir, "state"),
		fixtures: filepath.Join(dir, "fixtures"),
		log:      filepath.Join(dir, "calls.log"),
	}
	e.bundle = filepath.Join(e.root, remoteDir)
	for _, d := range []string{e.bin, e.state, e.fixtures, e.bundle,
		filepath.Join(e.root, "dev"), filepath.Join(e.root, "boot/firmware")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	e.write("dev/i2c-1", "", 0o644)
	e.write("boot/firmware/config.txt", "[all]\nkernel=vmlinuz\n", 0o755)
	for name, script := range map[string]string{
		"systemctl": fakeSystemctl, "useradd": fakeUseradd, "getent": fakeGetent,
		"runuser": fakeRunuser, "udevadm": fakeRecorder, "modprobe": fakeRecorder,
		"chown": fakeRecorder, "journalctl": fakeJournalctl, "sleep": fakeSleep,
	} {
		if err := os.WriteFile(filepath.Join(e.bin, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	linkHostTools(t, e.bin)
	// The bundle: the repository's units, rule and script, a stand-in
	// controller, and the fake pusher.
	for _, f := range []string{"meatgeek-controller.service", "meatgeek-pusher.service", "99-meatgeek.rules", remoteScript} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		e.writeBundle(f, string(b), 0o644)
	}
	e.writeBundle("meatgeek-controller", "controller v1\n", 0o755)
	e.writeBundle("meatgeek-pusher", fakePusher, 0o755)
	if err := os.WriteFile(filepath.Join(e.fixtures, "claim.out"), []byte(unclaimedLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *piEnv) write(rel, content string, mode os.FileMode) {
	e.t.Helper()
	p := filepath.Join(e.root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), mode); err != nil {
		e.t.Fatal(err)
	}
}

func (e *piEnv) writeBundle(name, content string, mode os.FileMode) {
	e.t.Helper()
	if err := os.MkdirAll(e.bundle, 0o700); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.bundle, name), []byte(content), mode); err != nil {
		e.t.Fatal(err)
	}
}

func (e *piEnv) read(rel string) string {
	e.t.Helper()
	b, err := os.ReadFile(filepath.Join(e.root, rel))
	if err != nil {
		e.t.Fatal(err)
	}
	return string(b)
}

func (e *piEnv) exists(rel string) bool {
	_, err := os.Stat(filepath.Join(e.root, rel))
	return err == nil
}

func (e *piEnv) run(extraEnv []string, args ...string) onboardResult {
	e.t.Helper()
	cmd := exec.Command(filepath.Join(e.bin, "bash"), append([]string{filepath.Join(e.bundle, remoteScript)}, args...)...)
	cmd.Env = append(append([]string{
		"PATH=" + e.bin,
		"HOME=" + e.dir,
		"TMPDIR=" + e.dir,
		"MEATGEEK_ROOT=" + e.root,
		"FAKE_LOG=" + e.log,
		"FAKE_STATE=" + e.state,
		"FAKE_DIR=" + e.fixtures,
		"FAKE_ASSIGNMENT=" + filepath.Join(e.root, "var/lib/meatgeek-pusher/identity/assignment.json"),
	}, e.extraEnv...), extraEnv...)
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
		e.t.Fatalf("running %s: %v", remoteScript, err)
	}
	r.calls = readCalls(e.t, e.log)
	if strings.Contains(r.stdout+r.stderr, "FAKEKEYMATERIAL") {
		e.t.Errorf("the device key reached the output:\n%s%s", r.stdout, r.stderr)
	}
	return r
}

func (e *piEnv) install(extraEnv ...string) onboardResult {
	e.t.Helper()
	return e.run(extraEnv, "install", "--device-id", derivedID)
}

func (e *piEnv) start(extraEnv ...string) onboardResult {
	e.t.Helper()
	return e.run(extraEnv, "start", "--device-id", derivedID, "--id-scope", idScope)
}

// systemWrites are the calls that change the system, as opposed to the
// queries (systemctl is-*, getent) and the pusher's own subcommands.
func systemWrites(cs []call) []call {
	var w []call
	for _, c := range cs {
		switch c.tool {
		case "useradd", "udevadm", "modprobe":
			w = append(w, c)
		case "systemctl":
			if !strings.HasPrefix(c.args[0], "is-") {
				w = append(w, c)
			}
		}
	}
	return w
}

func callStrings(cs []call) []string {
	var s []string
	for _, c := range cs {
		s = append(s, c.String())
	}
	return s
}

type fileStat struct {
	mode  fs.FileMode
	mtime time.Time
	size  int64
}

// snapshot records every file under the root except the bundle, which is the
// scratch space onboard-pi.sh replaces on each run.
func (e *piEnv) snapshot() map[string]fileStat {
	e.t.Helper()
	m := map[string]fileStat{}
	err := filepath.WalkDir(e.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == e.bundle {
			return filepath.SkipDir
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		m[strings.TrimPrefix(path, e.root)] = fileStat{info.Mode(), info.ModTime(), info.Size()}
		return nil
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return m
}

// ageEverything sets every file's times to a fixed past instant, so any file
// written afterwards shows up with a different mtime.
func (e *piEnv) ageEverything() {
	e.t.Helper()
	old := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	err := filepath.WalkDir(e.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chtimes(path, old, old)
	})
	if err != nil {
		e.t.Fatal(err)
	}
}

// --- install -------------------------------------------------------------------

func TestRemoteInstallFresh(t *testing.T) {
	t.Parallel()
	e := newPiEnv(t)
	r := e.install()
	if r.code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	want := []string{
		"useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin meatgeek",
		"udevadm control --reload",
		"udevadm trigger",
		"udevadm settle",
		"systemctl daemon-reload",
		"systemctl enable meatgeek-controller.service",
		"systemctl start meatgeek-controller.service",
	}
	if got := callStrings(systemWrites(r.calls)); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("system changes:\n got:\n  %s\nwant:\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
	for _, c := range r.calls {
		if strings.Contains(c.String(), "meatgeek-pusher.service") && c.tool == "systemctl" && !strings.HasPrefix(c.args[0], "is-") {
			t.Errorf("install touched the pusher's service: %s", c)
		}
	}
	// Installed files and modes.
	for rel, mode := range map[string]fs.FileMode{
		"/usr/local/bin/meatgeek-controller":              0o755,
		"/usr/local/bin/meatgeek-pusher":                  0o755,
		"/etc/udev/rules.d/99-meatgeek.rules":             0o644,
		"/etc/systemd/system/meatgeek-controller.service": 0o644,
		"/etc/systemd/system/meatgeek-pusher.service":     0o644,
		"/etc/modules-load.d/meatgeek.conf":               0o644,
		"/var/lib/meatgeek-pusher":                        fs.ModeDir | 0o700,
	} {
		info, err := os.Stat(filepath.Join(e.root, rel))
		if err != nil {
			t.Errorf("%s: %v", rel, err)
			continue
		}
		if info.Mode() != mode {
			t.Errorf("%s: mode %v, want %v", rel, info.Mode(), mode)
		}
	}
	if got := e.read("/etc/modules-load.d/meatgeek.conf"); got != "i2c-dev\n" {
		t.Errorf("modules-load: %q", got)
	}
	// The state dir belongs to the service user; identity init ran as it.
	if got := find(r.calls, func(c call) bool { return c.tool == "chown" }); len(got) != 1 ||
		got[0].String() != "chown meatgeek:meatgeek "+filepath.Join(e.root, "/var/lib/meatgeek-pusher") {
		t.Errorf("chown: %v", got)
	}
	inits := find(r.calls, func(c call) bool { return c.tool == "runuser" })
	if len(inits) != 1 || strings.Join(inits[0].args, " ") != "-u meatgeek -- "+
		filepath.Join(e.root, "/usr/local/bin/meatgeek-pusher")+" identity init --device-id "+derivedID+
		" --state-dir "+filepath.Join(e.root, "/var/lib/meatgeek-pusher") {
		t.Errorf("identity init: %v", inits)
	}
	// The user exists before the udev rule that names its group.
	if i, j := indexOf(r.calls, "useradd"), indexOf(r.calls, "udevadm"); i < 0 || j < i {
		t.Errorf("useradd at %d, udevadm at %d", i, j)
	}
}

func indexOf(cs []call, tool string) int {
	for i, c := range cs {
		if c.tool == tool {
			return i
		}
	}
	return -1
}

// Only the certificate leaves the identity directory, in the bundle for the
// laptop to fetch; the key stays.
func TestRemoteInstallCopiesOnlyTheCertificate(t *testing.T) {
	t.Parallel()
	e := newPiEnv(t)
	if r := e.install(); r.code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	crt := filepath.Join(e.bundle, "device.crt")
	b, err := os.ReadFile(crt)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "-----BEGIN CERTIFICATE-----\nFAKECERT-"+derivedID+"\n-----END CERTIFICATE-----\n" {
		t.Errorf("device.crt: %q", b)
	}
	if info, _ := os.Stat(crt); info.Mode() != 0o644 {
		t.Errorf("device.crt mode %v, want 0644", info.Mode())
	}
	// Nothing else new in the bundle, and nothing key-shaped anywhere outside
	// the identity directory.
	entries, _ := os.ReadDir(e.bundle)
	var names []string
	for _, en := range entries {
		names = append(names, en.Name())
	}
	if got := strings.Join(names, " "); got != "99-meatgeek.rules device.crt meatgeek-controller meatgeek-controller.service meatgeek-pusher meatgeek-pusher.service remote-install.sh" {
		t.Errorf("bundle: %s", got)
	}
	identityDir := filepath.Join(e.root, "var/lib/meatgeek-pusher/identity")
	_ = filepath.WalkDir(e.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Dir(path) == identityDir {
			return nil
		}
		if b, _ := os.ReadFile(path); bytes.Contains(b, []byte("FAKEKEYMATERIAL")) {
			t.Errorf("the key was copied to %s", path)
		}
		return nil
	})
}

func TestRemoteInstallRefusesAKeyFromIdentityInit(t *testing.T) {
	t.Parallel()
	e := newPiEnv(t)
	r := e.install("FAKE_PRINT_KEY=1")
	if r.code != 1 || !strings.Contains(r.stderr, "did not print a certificate") {
		t.Errorf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	for _, f := range []string{"device.crt", "device.crt.tmp"} {
		if _, err := os.Stat(filepath.Join(e.bundle, f)); err == nil {
			t.Errorf("%s left in the bundle", f)
		}
	}
	if got := find(r.calls, func(c call) bool { return c.tool == "systemctl" && c.args[0] == "start" }); len(got) != 0 {
		t.Errorf("started the controller after a failed identity init: %v", got)
	}
}

func TestRemoteInstallTwiceChangesNothing(t *testing.T) {
	t.Parallel()
	e := newPiEnv(t)
	if r := e.install(); r.code != 0 {
		t.Fatalf("first run: exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	key := e.read("/var/lib/meatgeek-pusher/identity/device.key")
	e.ageEverything()
	before := e.snapshot()

	r := e.install()
	if r.code != 0 {
		t.Fatalf("second run: exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	if w := systemWrites(r.calls); len(w) != 0 {
		t.Errorf("the second run changed the system:\n  %s", strings.Join(callStrings(w), "\n  "))
	}
	after := e.snapshot()
	for path, b := range before {
		if a, ok := after[path]; !ok {
			t.Errorf("%s was removed", path)
		} else if a != b {
			t.Errorf("%s changed: %+v → %+v", path, b, a)
		}
	}
	for path := range after {
		if _, ok := before[path]; !ok {
			t.Errorf("%s was created", path)
		}
	}
	if got := e.read("/var/lib/meatgeek-pusher/identity/device.key"); got != key {
		t.Errorf("the second run replaced the key")
	}
	if strings.Contains(r.stderr, "installed /") {
		t.Errorf("the second run says it installed something:\n%s", r.stderr)
	}
}

func TestRemoteInstallNewControllerRestartsIt(t *testing.T) {
	t.Parallel()
	e := newPiEnv(t)
	if r := e.install(); r.code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	e.writeBundle("meatgeek-controller", "controller v2\n", 0o755)
	r := e.install()
	if r.code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	if got := callStrings(systemWrites(r.calls)); strings.Join(got, "|") != "systemctl restart meatgeek-controller.service" {
		t.Errorf("system changes: %v", got)
	}
	if got := e.read("/usr/local/bin/meatgeek-controller"); got != "controller v2\n" {
		t.Errorf("controller: %q", got)
	}
}

func TestRemoteInstallI2COff(t *testing.T) {
	t.Parallel()
	for _, debianFirmware := range []bool{false, true} {
		t.Run("raspi-firmware="+strconv.FormatBool(debianFirmware), func(t *testing.T) {
			e := newPiEnv(t)
			if err := os.Remove(filepath.Join(e.root, "dev/i2c-1")); err != nil {
				t.Fatal(err)
			}
			if debianFirmware {
				e.write("etc/default/raspi-firmware", "", 0o644)
			}
			for run := 1; run <= 2; run++ {
				r := e.install()
				if r.code != 4 || !strings.Contains(r.stderr, "I2C was off; reboot the Pi (`sudo reboot`) and run the same command again") {
					t.Fatalf("run %d: exit %d\nstderr:\n%s", run, r.code, r.stderr)
				}
				if got := find(r.calls, func(c call) bool { return c.tool == "modprobe" }); len(got) != 1 || got[0].String() != "modprobe i2c-dev" {
					t.Errorf("run %d: modprobe: %v", run, got)
				}
				// Stops before the units, the identity and the controller.
				for _, c := range r.calls {
					if c.tool == "runuser" || (c.tool == "systemctl" && !strings.HasPrefix(c.args[0], "is-")) {
						t.Errorf("run %d: %s after I2C was found off", run, c)
					}
				}
			}
			if got := e.read("boot/firmware/config.txt"); got != "[all]\nkernel=vmlinuz\ndtparam=i2c_arm=on\n" {
				t.Errorf("config.txt:\n%s", got)
			}
			if got := e.read("etc/modules-load.d/meatgeek.conf"); got != "i2c-dev\n" {
				t.Errorf("modules-load: %q", got)
			}
			if debianFirmware {
				if got := e.read("etc/default/raspi-firmware-custom"); got != "dtparam=i2c_arm=on\n" {
					t.Errorf("raspi-firmware-custom: %q", got)
				}
			} else if e.exists("etc/default/raspi-firmware-custom") {
				t.Errorf("wrote raspi-firmware-custom without raspi-firmware")
			}

			// After the reboot the bus is there, and the same command carries on.
			e.write("dev/i2c-1", "", 0o644)
			r := e.install()
			if r.code != 0 {
				t.Fatalf("after the reboot: exit %d\nstderr:\n%s", r.code, r.stderr)
			}
			if got := e.read("boot/firmware/config.txt"); strings.Count(got, "dtparam=i2c_arm=on") != 1 {
				t.Errorf("config.txt after the reboot:\n%s", got)
			}
		})
	}
}

func TestRemoteInstallI2CConfigWithoutTrailingNewline(t *testing.T) {
	t.Parallel()
	e := newPiEnv(t)
	if err := os.Remove(filepath.Join(e.root, "dev/i2c-1")); err != nil {
		t.Fatal(err)
	}
	e.write("boot/firmware/config.txt", "[all]\nkernel=vmlinuz", 0o755)
	if r := e.install(); r.code != 4 {
		t.Fatalf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	if got := e.read("boot/firmware/config.txt"); got != "[all]\nkernel=vmlinuz\ndtparam=i2c_arm=on\n" {
		t.Errorf("config.txt: %q", got)
	}
}

// --- start ---------------------------------------------------------------------

// registered is a pusher that has already registered with DPS.
func (e *piEnv) registered() {
	e.t.Helper()
	e.write("var/lib/meatgeek-pusher/identity/assignment.json", `{"assignedHub":"hub","deviceId":"x"}`, 0o644)
}

func installed(t *testing.T) *piEnv {
	t.Helper()
	e := newPiEnv(t)
	if r := e.install(); r.code != 0 {
		t.Fatalf("install: exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	return e
}

func TestRemoteStartWaitsForRegistration(t *testing.T) {
	t.Parallel()
	e := installed(t)
	r := e.start("FAKE_ASSIGN_AFTER=2", "FAKE_CLAIM_AFTER=3")
	want := "MEATGEEK-CLAIM-BEGIN\n" + unclaimedLine + "\nMEATGEEK-CLAIM-END\n" +
		"meatgeek-controller.service: active\nmeatgeek-pusher.service: active\n"
	if r.code != 0 || r.stdout != want {
		t.Fatalf("exit %d, stdout:\n%s\nwant:\n%s\nstderr:\n%s", r.code, r.stdout, want, r.stderr)
	}
	sleeps := find(r.calls, func(c call) bool { return c.tool == "sleep" })
	if len(sleeps) != 3 {
		t.Errorf("polled %d times, want 3", len(sleeps))
	}
	for _, s := range sleeps {
		if s.String() != "sleep 1" {
			t.Errorf("poll: %s", s)
		}
	}
	// enable, then restart (which also starts a stopped pusher), then wait.
	writes := callStrings(systemWrites(r.calls))
	if strings.Join(writes, "|") != "systemctl enable meatgeek-pusher.service|systemctl restart meatgeek-pusher.service" {
		t.Errorf("system changes: %v", writes)
	}
	if i, j := indexOf(r.calls, "systemctl"), indexOf(r.calls, "sleep"); j < i {
		t.Errorf("waited before starting the pusher")
	}
	if e.exists(remoteDir) {
		t.Errorf("%s was not removed", remoteDir)
	}
}

func TestRemoteStartEnvFile(t *testing.T) {
	t.Parallel()
	e := installed(t)
	// A connection-string env file from before DPS mode is replaced whole.
	e.registered()
	e.write("etc/meatgeek-pusher/env", "IOTHUB_CONNECTION_STRING=HostName=x;DeviceId=y;SharedAccessKey=c2VjcmV0\n", 0o600)
	r := e.start()
	if r.code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	want := "MEATGEEK_DPS_ID_SCOPE=" + idScope + "\nMEATGEEK_DEVICE_ID=" + derivedID +
		"\nMEATGEEK_STATE_DIR=/var/lib/meatgeek-pusher\nDEVICE_URL=http://localhost:3000\n"
	got := e.read("etc/meatgeek-pusher/env")
	if got != want {
		t.Errorf("env file:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, "IOTHUB_CONNECTION_STRING") {
		t.Errorf("env file has IOTHUB_CONNECTION_STRING")
	}
	info, err := os.Stat(filepath.Join(e.root, "etc/meatgeek-pusher/env"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode() != 0o640 {
		t.Errorf("env file mode %v, want 0640", info.Mode())
	}
	if got := find(r.calls, func(c call) bool { return c.tool == "chown" }); len(got) != 1 ||
		got[0].String() != "chown root:meatgeek "+filepath.Join(e.root, "etc/meatgeek-pusher/env") {
		t.Errorf("chown: %v", got)
	}
}

func TestRemoteStartAgainRestartsThePusher(t *testing.T) {
	t.Parallel()
	e := installed(t)
	e.registered()
	if r := e.start(); r.code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	// onboard-pi.sh copies the bundle again on its next run.
	e.writeBundle(remoteScript, string(mustRead(t, remoteScript)), 0o644)
	env := filepath.Join(e.root, "etc/meatgeek-pusher/env")
	old := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(env, old, old); err != nil {
		t.Fatal(err)
	}
	r := e.start()
	if r.code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", r.code, r.stderr)
	}
	if got := callStrings(systemWrites(r.calls)); strings.Join(got, "|") != "systemctl restart meatgeek-pusher.service" {
		t.Errorf("system changes on the second start: %v", got)
	}
	if info, _ := os.Stat(env); !info.ModTime().Equal(old) {
		t.Errorf("the unchanged env file was rewritten")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// After a restart the pusher replaces an expired code when it reads its twin;
// until then claim-code says expired, and the wait goes on.
func TestRemoteStartWaitsPastAnExpiredCode(t *testing.T) {
	t.Parallel()
	e := installed(t)
	r := e.start("FAKE_ASSIGN_AFTER=0", "FAKE_EXPIRED_UNTIL=4")
	if r.code != 0 || !strings.Contains(r.stdout, unclaimedLine) || strings.Contains(r.stdout, "expired") {
		t.Fatalf("exit %d, stdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if n := len(find(r.calls, func(c call) bool { return c.tool == "sleep" })); n != 4 {
		t.Errorf("polled %d times, want 4", n)
	}
}

func TestRemoteStartClaimed(t *testing.T) {
	t.Parallel()
	e := installed(t)
	claimed := `{"deviceId":"meatgeek-abcdef12","state":"claimed"}`
	if err := os.WriteFile(filepath.Join(e.fixtures, "claim.out"), []byte(claimed+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := e.start("FAKE_ASSIGN_AFTER=0")
	if r.code != 0 || !strings.Contains(r.stdout, "MEATGEEK-CLAIM-BEGIN\n"+claimed+"\nMEATGEEK-CLAIM-END\n") {
		t.Errorf("exit %d, stdout:\n%s", r.code, r.stdout)
	}
}

func TestRemoteStartTimesOut(t *testing.T) {
	t.Parallel()
	e := installed(t)
	r := e.start() // never registers
	if r.code != 5 || strings.Contains(r.stdout, "MEATGEEK-CLAIM") {
		t.Fatalf("exit %d, stdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if n := len(find(r.calls, func(c call) bool { return c.tool == "sleep" })); n != 120 {
		t.Errorf("polled %d times, want 120", n)
	}
	j := find(r.calls, func(c call) bool { return c.tool == "journalctl" })
	if len(j) != 1 || j[0].String() != "journalctl -u meatgeek-pusher.service -n 30 --no-pager" {
		t.Errorf("journalctl: %v", j)
	}
	if !strings.Contains(r.stderr, "did not register within 120 s") || !strings.Contains(r.stderr, "DPS registration refused (401)") {
		t.Errorf("stderr:\n%s", r.stderr)
	}
	if e.exists(remoteDir) {
		t.Errorf("%s was not removed after the timeout", remoteDir)
	}
}

func TestRemoteUsage(t *testing.T) {
	t.Parallel()
	for name, args := range map[string][]string{
		"no phase":           nil,
		"unknown phase":      {"uninstall", "--device-id", derivedID},
		"no device id":       {"install"},
		"bad device id":      {"install", "--device-id", "x;reboot"},
		"start without zone": {"start", "--device-id", derivedID},
		"bad scope":          {"start", "--device-id", derivedID, "--id-scope", "0ne;x"},
		"extra argument":     {"install", "--device-id", derivedID, "now"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newPiEnv(t)
			r := e.run(nil, args...)
			if r.code != 2 {
				t.Errorf("exit %d\nstderr:\n%s", r.code, r.stderr)
			}
			if len(r.calls) != 0 {
				t.Errorf("ran commands on a usage error: %v", r.calls)
			}
		})
	}
}

// --- the units -------------------------------------------------------------------

func TestUnits(t *testing.T) {
	t.Parallel()
	for _, unit := range []string{"meatgeek-controller.service", "meatgeek-pusher.service"} {
		s := string(mustRead(t, unit))
		for _, line := range []string{"User=meatgeek", "Group=meatgeek", "Restart=on-failure", "NoNewPrivileges=true", "WantedBy=multi-user.target"} {
			if !strings.Contains(s, "\n"+line+"\n") {
				t.Errorf("%s lacks %s", unit, line)
			}
		}
		if strings.Contains(s, "IOTHUB_CONNECTION_STRING") {
			t.Errorf("%s mentions IOTHUB_CONNECTION_STRING", unit)
		}
		if strings.Contains(s, "\nPrivateDevices=") {
			t.Errorf("%s hides /dev", unit)
		}
	}
	p := string(mustRead(t, "meatgeek-pusher.service"))
	for _, line := range []string{
		"After=network-online.target meatgeek-controller.service",
		"Wants=network-online.target meatgeek-controller.service",
		"StateDirectory=meatgeek-pusher",
		"StateDirectoryMode=0700",
		"EnvironmentFile=/etc/meatgeek-pusher/env",
		"ExecStart=/usr/local/bin/meatgeek-pusher",
	} {
		if !strings.Contains(p, "\n"+line+"\n") {
			t.Errorf("meatgeek-pusher.service lacks %s", line)
		}
	}
	if c := string(mustRead(t, "meatgeek-controller.service")); !strings.Contains(c, "\nExecStart=/usr/local/bin/meatgeek-controller\n") {
		t.Errorf("meatgeek-controller.service: wrong ExecStart")
	}
	rules := string(mustRead(t, "99-meatgeek.rules"))
	for _, want := range []string{`KERNEL=="spidev*", GROUP="meatgeek", MODE="0660"`, `KERNEL=="i2c-[0-9]*", GROUP="meatgeek", MODE="0660"`} {
		if !strings.Contains(rules, want) {
			t.Errorf("99-meatgeek.rules lacks %s", want)
		}
	}
}
