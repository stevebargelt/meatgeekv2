// Package dpsmode is the device path shared by the pusher and simdevice when
// the device provisions itself: its configuration (the MEATGEEK_* variables),
// the IoT Hub client that ties internal/identity, internal/provision,
// internal/claim and internal/iothub together, and the `identity init` and
// `claim-code` subcommands.
package dpsmode

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/sirupsen/logrus"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/claim"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/identity"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision"
)

// The environment variables DPS mode reads.
const (
	EnvIDScope  = "MEATGEEK_DPS_ID_SCOPE"
	EnvDeviceID = "MEATGEEK_DEVICE_ID"
	EnvEndpoint = "MEATGEEK_DPS_ENDPOINT"
	EnvStateDir = "MEATGEEK_STATE_DIR"
)

// DefaultStateDir is the pusher unit's WorkingDirectory.
const DefaultStateDir = "/var/lib/meatgeek-pusher"

// Config is DPS mode's configuration. An empty IDScope means DPS mode is off.
type Config struct {
	IDScope  string
	DeviceID string
	Endpoint string
	StateDir string
}

// FromEnv reads Config from the environment, with the defaults filled in.
func FromEnv(getenv func(string) string) Config {
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	return Config{
		IDScope:  get(EnvIDScope, ""),
		DeviceID: get(EnvDeviceID, ""),
		Endpoint: get(EnvEndpoint, provision.DefaultEndpoint),
		StateDir: get(EnvStateDir, DefaultStateDir),
	}
}

// Enabled reports whether DPS mode is on (an ID scope is set).
func (c Config) Enabled() bool { return c.IDScope != "" }

// Validate checks a Config for DPS mode.
func (c Config) Validate() error {
	if c.IDScope == "" {
		return fmt.Errorf("%s is not set", EnvIDScope)
	}
	if c.DeviceID == "" {
		return fmt.Errorf("%s is required with %s", EnvDeviceID, EnvIDScope)
	}
	if err := identity.ValidateDeviceID(c.DeviceID); err != nil {
		return fmt.Errorf("%s: %w", EnvDeviceID, err)
	}
	if c.Endpoint == "" {
		return fmt.Errorf("%s is empty", EnvEndpoint)
	}
	if c.StateDir == "" {
		return fmt.Errorf("%s is empty", EnvStateDir)
	}
	return nil
}

// NewClient returns the device's X.509 IoT Hub client. It creates (or loads)
// the device identity under cfg.StateDir and connects to the hub DPS assigns:
// the cached assignment when there is one, otherwise a fresh registration.
// When the hub refuses the connection as not authorised, the client deletes
// the cached assignment and registers once more before its next connect.
// When the twin is on (iothub.WithCookTwin in opts), the client also keeps the
// device's claim code under cfg.StateDir/claim and reports its hash
// (internal/claim); an iothub.WithClaim in opts replaces that.
// provOpts and opts are passed through (tests point them at fakes).
func NewClient(cfg Config, clk clock.Clock, provOpts []provision.Option, opts ...iothub.Option) (*iothub.AzureClient, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if clk == nil {
		clk = clock.Real()
	}
	_, cert, err := identity.Ensure(cfg.StateDir, cfg.DeviceID, clk)
	if err != nil {
		return nil, err
	}
	r := &resolver{
		cfg:  cfg,
		prov: provision.New(cert, append([]provision.Option{provision.WithClock(clk)}, provOpts...)...),
	}
	all := append([]iothub.Option{iothub.WithClaim(claim.NewDevice(cfg.StateDir, cfg.DeviceID, clk, rand.Reader))}, opts...)
	return iothub.NewX509Client("", cfg.DeviceID, cert, append(all, iothub.WithClock(clk), iothub.WithHubResolver(r.hub))...)
}

// resolver is the iothub.HubResolver for DPS mode.
type resolver struct {
	cfg  Config
	prov *provision.Client
}

func (r *resolver) hub(ctx context.Context, refresh bool) (string, error) {
	if refresh {
		if err := provision.DeleteAssignment(r.cfg.StateDir); err != nil {
			return "", err
		}
	} else {
		a, ok, err := provision.LoadAssignment(r.cfg.StateDir)
		if err != nil {
			logrus.WithError(err).Warn("dps: ignoring the cached assignment")
		}
		if ok && a.DeviceID == r.cfg.DeviceID {
			return a.AssignedHub, nil
		}
	}
	a, err := r.prov.Register(ctx, r.cfg.Endpoint, r.cfg.IDScope, r.cfg.DeviceID)
	if err != nil {
		if errors.Is(err, provision.ErrEnrollmentRefused) {
			logrus.WithError(err).WithField("deviceId", r.cfg.DeviceID).Error("dps: the Device Provisioning Service refused this device; enrol the certificate that `identity init` prints, then it registers on its next attempt")
		}
		return "", err
	}
	if a.DeviceID != r.cfg.DeviceID {
		return "", fmt.Errorf("dps: DPS assigned device id %q, but this device is %q (%s, the certificate CN); fix the enrollment's device id", a.DeviceID, r.cfg.DeviceID, EnvDeviceID)
	}
	if err := provision.SaveAssignment(r.cfg.StateDir, a); err != nil {
		return "", err
	}
	logrus.WithFields(logrus.Fields{"hub": a.AssignedHub, "deviceId": a.DeviceID, "refresh": refresh}).Info("dps: registered")
	return a.AssignedHub, nil
}

// IdentityCommand runs `<prog> identity init --device-id <id> [--state-dir
// <dir>]`; args are those after "identity". It creates the device identity if
// there is none and writes only the certificate PEM to stdout, the same bytes
// on every run. It returns the process exit code: 0, 1 when the identity
// cannot be created or loaded, 2 on a usage error.
func IdentityCommand(prog string, args []string, getenv func(string) string, stdout, stderr io.Writer, clk clock.Clock) int {
	usage := func() {
		fmt.Fprintf(stderr, "usage: %s identity init --device-id <id> [--state-dir <dir>]\n"+
			"Creates the device's key and certificate if they do not exist and prints the certificate.\n", prog)
	}
	if len(args) == 0 || args[0] != "init" {
		usage()
		return 2
	}
	env := FromEnv(getenv)
	fs := flag.NewFlagSet(prog+" identity init", flag.ContinueOnError)
	fs.SetOutput(stderr)
	deviceID := fs.String("device-id", env.DeviceID, "the device id: the certificate CN and DPS registration id (default $"+EnvDeviceID+")")
	stateDir := fs.String("state-dir", env.StateDir, "the state directory; the identity lives in <dir>/identity (default $"+EnvStateDir+" or "+DefaultStateDir+")")
	fs.Usage = func() {
		usage()
		fs.PrintDefaults()
	}
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "%s identity init: unexpected arguments %q\n", prog, fs.Args())
		return 2
	}
	if *deviceID == "" {
		fmt.Fprintf(stderr, "%s identity init: --device-id is required\n", prog)
		return 2
	}
	certPEM, _, err := identity.Ensure(*stateDir, *deviceID, clk)
	if err != nil {
		fmt.Fprintf(stderr, "%s identity init: %v\n", prog, err)
		return 1
	}
	if _, err := stdout.Write(certPEM); err != nil {
		fmt.Fprintf(stderr, "%s identity init: write stdout: %v\n", prog, err)
		return 1
	}
	return 0
}

// Exit codes of ClaimCodeCommand besides 0, 1 and 2.
const (
	// ExitNoClaim: there is no claim file yet (the device has not minted a
	// code: it has not run in DPS mode, or has not reached the twin yet).
	ExitNoClaim = 3
)

// ClaimCodeLine is the one JSON line ClaimCodeCommand prints. ClaimCode and
// ExpiresAt are set only when State is "unclaimed".
type ClaimCodeLine struct {
	DeviceID  string `json:"deviceId"`
	State     string `json:"state"` // unclaimed, claimed or expired
	ClaimCode string `json:"claimCode,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

// ClaimCodeCommand runs `<prog> claim-code [--state-dir <dir>]`; args are those
// after "claim-code". It only reads the claim file: it never mints a code and
// never connects. It prints one ClaimCodeLine to stdout and returns the exit
// code: 0 (whatever the state), 1 when the claim file cannot be read, 2 on a
// usage error, ExitNoClaim when there is no claim file yet.
func ClaimCodeCommand(prog string, args []string, getenv func(string) string, stdout, stderr io.Writer, clk clock.Clock) int {
	if clk == nil {
		clk = clock.Real()
	}
	env := FromEnv(getenv)
	fs := flag.NewFlagSet(prog+" claim-code", flag.ContinueOnError)
	fs.SetOutput(stderr)
	stateDir := fs.String("state-dir", env.StateDir, "the state directory; the claim code lives in <dir>/"+claim.DirName+" (default $"+EnvStateDir+" or "+DefaultStateDir+")")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "usage: %s claim-code [--state-dir <dir>]\n"+
			"Prints the device's current claim code as one JSON line. Never mints a code or connects.\n", prog)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "%s claim-code: unexpected arguments %q\n", prog, fs.Args())
		return 2
	}
	s, err := claim.Load(*stateDir)
	if errors.Is(err, claim.ErrNoClaim) {
		fmt.Fprintf(stderr, "%s claim-code: %v; the device mints its code when it first reads its twin in DPS mode\n", prog, err)
		return ExitNoClaim
	}
	if err != nil {
		fmt.Fprintf(stderr, "%s claim-code: %v\n", prog, err)
		return 1
	}
	line := ClaimCodeLine{DeviceID: s.DeviceID}
	switch {
	case s.Claimed:
		line.State = "claimed"
	case !clk.Now().Before(s.ExpiresAt):
		line.State = "expired"
	default:
		line.State = "unclaimed"
		line.ClaimCode = claim.Format(s.Code)
		line.ExpiresAt = s.Reported().ExpiresAt
	}
	if err := json.NewEncoder(stdout).Encode(line); err != nil {
		fmt.Fprintf(stderr, "%s claim-code: write stdout: %v\n", prog, err)
		return 1
	}
	return 0
}
