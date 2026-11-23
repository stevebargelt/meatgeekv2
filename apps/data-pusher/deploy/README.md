# Device onboarding, enrolment and revocation

**`onboard-pi.sh`** takes a fresh Raspberry Pi to a running, enrolled device
with one command from the owner's laptop. See [`onboard-pi.sh`](#onboard-pish)
below and the [device runbook](../../../docs/devices/runbook.md).

Three operator scripts for the IoT Hub Device Provisioning Service (DPS):

- **`enrol-device.sh`** enrols a device's public X.509 certificate, so the
  device can register with DPS and connect to IoT Hub.
- **`revoke-device.sh`** revokes a lost device, so IoT Hub accepts nothing more
  from it.
- **`delete-device.sh`** deletes a throwaway device's enrollment and hub
  identity. CI uses it for the fresh `acceptance-*` devices the live suite
  enrols each run (HAR-140). It refuses any id outside `--only-prefix`.

The device creates its own key and never gives it up.
`meatgeek-pusher identity init` (or `simdevice identity init`) prints only the
certificate PEM. That PEM is all these scripts need. The owner runs them from
their own machine, and CI runs them for the simulated devices, so both use the
same path.

For each device, the DPS enrollment id, the DPS registration id and the IoT
Hub device id are all the same value: the device id. The certificate's
subject CN must be that id too.

`onboard-pi.sh` installs `meatgeek-controller.service`,
`meatgeek-pusher.service` and `99-meatgeek.rules` from this directory.

## Requirements

- `bash`, `openssl`
- The Azure CLI (`az`), signed in (`az login`), with the azure-iot extension.
  Both scripts check for the extension. If it is missing, they print the
  command that installs it:

  ```sh
  az extension add --name azure-iot
  ```

## Common options

| Option                    | Default                                         |
| ------------------------- | ----------------------------------------------- |
| `--device-id <id>`        | required. 1 to 128 letters, digits, `-`, `.`, `_` or `:` |
| `--resource-group <name>` | `meatgeek-v2-dev-rg`                            |
| `--dps <name\|host>`      | the only `Microsoft.Devices/provisioningServices` in the resource group |
| `--hub <name\|host>`      | the only `Microsoft.Devices/IotHubs` in the resource group |
| `--auth-type key\|login`  | `key`. Passed to every `az iot dps …` and `az iot hub …` call |

The scripts list the resource group's DPSs and hubs (`az resource list`)
whether or not you pass the names, unless you pass a
[host name](#host-names-no-arm). If `--dps` or `--hub` is left out and the
resource group has none or more than one of that resource, the script stops
with exit 1 and lists what it found; pass the name to choose one. If a name
you pass is not in the resource group, the script stops with exit 1 before it
reads or changes anything, so a mistyped hub can never make a device look
missing. An `az iot` error that says the extension cannot find the DPS or hub,
or cannot find a usable access policy on it, is also exit 1, never "no such
device".

`--auth-type key` lets `az` fetch the DPS and hub access keys with your ARM
rights. It suits the owner, who is subscription Owner. `--auth-type login`
uses your Azure AD sign-in and its data-plane RBAC roles. It suits CI.

### Host names (no ARM)

A `--dps` or `--hub` value with a dot in it is the service's host name
(`<dps>.azure-devices-provisioning.net`, `<hub>.azure-devices.net`). It is
used as given: the script does not list or show it in ARM, and passes no
`--resource-group` to `az iot` for it. That is how an identity with only
data-plane roles runs the scripts. CI's identity holds IoT Hub Registry
Contributor and Device Provisioning Service Data Contributor, and no Reader,
so it cannot list the resource group (HAR-139). A host name needs
`--auth-type login`; with `key`, `az` would look the service up in ARM to read
its keys, so the script refuses it with exit 2. azure-iot 1.0.0 looks a hub up
in ARM by name whenever it gets a `--resource-group`, even with a host name,
which is why none is passed. A wrong host name fails at the first `az iot`
call, with exit 1, not as "no such device".

Stdout carries one result line and nothing else. Diagnostics go to stderr.
The certificate PEM is never printed. From each `az … show` call, the scripts
read only the fields they need: the enrollment's status and certificate
thumbprint, and the hub identity's status. Key-shaped text in an `az` error
is redacted before it is shown.

## `enrol-device.sh`

```
enrol-device.sh --device-id <id> --certificate <path.pem> [common options]
```

Before calling Azure, the script checks that the file is an X.509 certificate
(`openssl x509`) and that its subject CN equals `--device-id`. If either check
fails, it refuses and exits 2. It then looks up the device's individual
enrollment and compares SHA-1 thumbprints:

| Enrollment                         | What it does                                   | Result line                 |
| ---------------------------------- | ---------------------------------------------- | --------------------------- |
| none                               | creates it: x509 attestation with this certificate, device id = id, enabled, static allocation to the hub | `enrolled <id>`             |
| enabled, same certificate          | nothing                                        | `unchanged <id>`            |
| enabled, different certificate     | replaces the certificate (a re-imaged device)  | `certificate replaced <id>` |
| disabled (revoked)                 | refuses, exit 4                                | (none)                      |
| disabled, with `REINSTATE=1`       | sets this certificate, enables the enrollment, and enables the hub device identity if there is one | `reinstated <id>`           |

### Owner (key auth)

```sh
ssh pi@meatgeek-pi-7 'meatgeek-pusher identity init --device-id meatgeek-pi-7' > meatgeek-pi-7.pem
apps/data-pusher/deploy/enrol-device.sh --device-id meatgeek-pi-7 --certificate meatgeek-pi-7.pem
# enrolled meatgeek-pi-7
```

To bring back a device that was revoked by mistake:

```sh
REINSTATE=1 apps/data-pusher/deploy/enrol-device.sh --device-id meatgeek-pi-7 --certificate meatgeek-pi-7.pem
# reinstated meatgeek-pi-7
```

### CI (login auth, host names)

As `.github/workflows/app-deploy-dev.yml` does for each simulated device
(HAR-139):

```sh
simdevice identity init --device-id ci-sim-1 --state-dir "$RUNNER_TEMP/sim" > "$RUNNER_TEMP/ci-sim-1.pem"
apps/data-pusher/deploy/enrol-device.sh --auth-type login \
  --dps "$DPS_NAME.azure-devices-provisioning.net" --hub "$HUB_HOSTNAME" \
  --device-id ci-sim-1 --certificate "$RUNNER_TEMP/ci-sim-1.pem"
```

## `revoke-device.sh`

```
revoke-device.sh --device-id <id> [common options]
```

The script makes two changes:

1. It sets the DPS enrollment to `--provisioning-status disabled`, so the
   device cannot register again.
2. It sets the hub device identity to `--status disabled --status-reason revoked`.
   IoT Hub refuses a disabled identity when it connects, and drops its open
   connections.

The enrollment is disabled first, so a failure after that step still leaves
the device unable to register again. Nothing is deleted.

| State                                     | Exit | Result line                                     |
| ----------------------------------------- | ---- | ----------------------------------------------- |
| either one enabled                        | 0    | `revoked <id>`                                  |
| both already disabled (a second run)      | 0    | `already revoked <id>`                          |
| no enrollment, hub identity exists        | 0    | `revoked <id> (no DPS enrollment)`              |
| enrollment exists, no hub identity        | 0    | `revoked <id> (no IoT hub device identity)`     |
| neither exists                            | 3    | (none). Stderr says `no such device <id>`       |

When one of the two is missing, the result line says `already revoked` if the
one that exists was already disabled.

The script does not change the API's ownership record. After revoking, release
the device in the web app.

```sh
# owner
apps/data-pusher/deploy/revoke-device.sh --device-id meatgeek-pi-7
# CI
apps/data-pusher/deploy/revoke-device.sh --auth-type login \
  --dps "$DPS_NAME.azure-devices-provisioning.net" --hub "$HUB_HOSTNAME" --device-id ci-sim-1
```

## `delete-device.sh`

```
delete-device.sh --device-id <id> --only-prefix <prefix> [common options]
```

This is for throwaway devices only. To retire a real device, revoke it with
`revoke-device.sh`, which deletes nothing.

`--only-prefix` is required. An id that does not start with the prefix is
refused with exit 4 before any `az` call. The prefix is matched literally, not
as a glob. This check is what stops CI from ever deleting a real device such
as the owner's Pi.

The script deletes the DPS individual enrollment first, so the device cannot
register again, and then the hub device identity. A delete that finds the
thing already gone counts as done.

| State                                     | Exit | Result line                                     |
| ----------------------------------------- | ---- | ----------------------------------------------- |
| id does not start with `--only-prefix`    | 4    | (none). No `az` call                            |
| both exist                                | 0    | `deleted <id>`                                  |
| no enrollment, hub identity exists        | 0    | `deleted <id> (no DPS enrollment)`              |
| enrollment exists, no hub identity        | 0    | `deleted <id> (no IoT hub device identity)`     |
| neither exists (a second run)             | 0    | `already deleted <id>`                          |

```sh
# CI, from the live acceptance suite
apps/data-pusher/deploy/delete-device.sh --auth-type login \
  --dps "$DPS_NAME.azure-devices-provisioning.net" --hub "$HUB_HOSTNAME" \
  --device-id acceptance-temp-20261122-abc123 --only-prefix acceptance-
```

## `onboard-pi.sh`

```
onboard-pi.sh <user@host> [--device-id <id>] [--resource-group <name>]
              [--web-origin <url>] [--dps <name>] [--hub <name>] [--auth-type key|login]
```

It runs on the owner's laptop, from a checkout of the repository. The
[runbook](../../../docs/devices/runbook.md) covers the prerequisites, the
output and the exit codes. In order, it:

1. **Preflight.** It changes nothing. It checks `go` (at least the newer `go`
   directive of the two `go.mod` files), `az` and `az account show`, and the
   azure-iot extension. It resolves the DPS and hub with `device-common.sh`
   (exactly one of each, or the names given) and reads the DPS ID scope
   (`az iot dps show --query properties.idScope`). Then it checks
   `ssh -o BatchMode=yes <host> true`, that `uname -m` is `aarch64`, and that
   `/dev/spidev0.0` exists. A failed check prints `fix: <command>`.
2. **Device id.** Without `--device-id`, it is `meatgeek-` plus the last 8 hex
   digits of `/proc/device-tree/serial-number` (NUL stripped, lower-case), or
   of `Serial` in `/proc/cpuinfo`. Both are read over ssh without sudo.
3. **Build.** It builds `apps/device-controller` and `apps/data-pusher/cmd`
   with `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath`. Both build
   without cgo. It copies the binaries, the units, the rule and
   `remote-install.sh` to `/tmp/meatgeek-onboard/` on the Pi with `scp`.
4. **Install.** `ssh -t <host> sudo bash /tmp/meatgeek-onboard/remote-install.sh install --device-id <id>`.
5. **Enrol.** It fetches `/tmp/meatgeek-onboard/device.crt` with `scp` and runs
   `enrol-device.sh` with it. `REINSTATE=1` and `--auth-type` pass through.
   If the device is revoked, it stops with exit 4.
6. **Start.** `ssh -t <host> sudo bash /tmp/meatgeek-onboard/remote-install.sh start --device-id <id> --id-scope <scope>`.
   It parses the claim line between the `MEATGEEK-CLAIM-BEGIN` and
   `MEATGEEK-CLAIM-END` markers and prints the device id with either the
   claim code, its expiry and `<web-origin>/devices/claim?deviceId=<id>`, or
   "already claimed".

The claim code goes only to the terminal. It is not in the URL, in a file or
in a command's arguments.

## `remote-install.sh`

This is the root half of `onboard-pi.sh`. It runs on the Pi under `sudo`, so
the owner types the password once per phase. No sudoers change is made.

- **`install`** changes only what differs, so a second run changes nothing:
  - It creates the system user `meatgeek` (no login shell, no home).
  - It installs `/usr/local/bin/meatgeek-controller` and
    `/usr/local/bin/meatgeek-pusher`, each only if its content changed, through
    a temporary file and a rename.
  - It installs the udev rule and reloads and triggers udev only when the rule
    changed.
  - **I2C:** it writes `/etc/modules-load.d/meatgeek.conf` (`i2c-dev`). If
    `/dev/i2c-1` is still missing after `modprobe i2c-dev`, it adds
    `dtparam=i2c_arm=on` to `/boot/firmware/config.txt` once. With Debian's
    `raspi-firmware`, it also adds the line to
    `/etc/default/raspi-firmware-custom`, which survives a kernel upgrade.
    Then it asks for a reboot and exits 4.
  - It installs the units, and runs `daemon-reload` only when one changed.
  - It creates `/var/lib/meatgeek-pusher` (`0700`, `meatgeek`) and runs
    `runuser -u meatgeek -- meatgeek-pusher identity init`, which keeps an
    existing key. It writes the printed certificate, and nothing else, to
    `/tmp/meatgeek-onboard/device.crt` (`0644`). It refuses output that is not
    a certificate or that holds a private key.
  - It enables and starts the controller, or restarts it when its binary or
    unit changed. It does not start the pusher.
- **`start`:**
  - It writes `/etc/meatgeek-pusher/env` (`0640`, `root:meatgeek`) with the
    ID scope, the device id, the state dir and `DEVICE_URL`. There is no
    `IOTHUB_CONNECTION_STRING`.
  - It enables and restarts the pusher. A restart re-mints an expired code.
  - It polls once a second, at most 120 times, until `identity/assignment.json`
    exists and `meatgeek-pusher claim-code` reports `unclaimed` or `claimed`.
  - It prints the claim line between the markers and `systemctl is-active`
    for both units.
  - On timeout, it prints the last 30 lines of `journalctl -u meatgeek-pusher`
    and exits 5.
  - It always removes `/tmp/meatgeek-onboard`.

`MEATGEEK_ROOT` prefixes every path, for the tests.

## Exit codes

These are the exit codes of `enrol-device.sh`, `revoke-device.sh` and
`delete-device.sh`. The exit codes of `onboard-pi.sh` are in the
[runbook](../../../docs/devices/runbook.md#exit-codes).

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | success (including `unchanged`, `already revoked` and `already deleted`)    |
| 2    | usage error, or a certificate refused (not a certificate, or the CN is not the device id) |
| 3    | not found: revoke found neither an enrollment nor a hub identity           |
| 4    | refused: the device is revoked and `REINSTATE=1` is not set (enrol), or the id does not start with `--only-prefix` (delete) |
| 1    | anything else: `az` or the extension missing, DPS or hub discovery failed or a named DPS or hub is not in the resource group, an `az` call failed. The message names the `az` command and its exit status |

## Tests

`scripts_test.go` runs the three DPS scripts with `bash` against a fake `az` on `PATH`.
The fake records every invocation and answers from a fixture directory set up
by each test. The tests check the result line, the exit code and the exact
`az` calls for every path above. They also check that the PEM never appears in
the output. They also run `bash -n` on every script, and `shellcheck` when it
is installed. `onboard_test.go` runs `onboard-pi.sh` with fake `ssh`, `scp`, `go` and
`az` on a `PATH` that holds nothing else but the ordinary tools, so a real
`go` or `az` cannot leak in. One log records every fake's calls, and the
tests check the order of the run. They cover each preflight failure with its
fix line and no change to the Pi, the device id from each source and an
invalid one, enrol's exit 4 stopping before `start`, the I2C reboot, the
claimed and unclaimed output, and that the claim code is never in a file, a
URL or a command's arguments.

`remote_install_test.go` runs `remote-install.sh` against a temporary root
(`MEATGEEK_ROOT`), with fake `systemctl`, `useradd`, `getent`, `udevadm`,
`runuser`, `modprobe`, `chown`, `journalctl` and `sleep`, and a fake
`meatgeek-pusher`. It checks these:

- a second `install` changes no file (by mtime) and runs no changing command;
- the env file is `0640` with no `IOTHUB_CONNECTION_STRING`;
- only the certificate leaves the identity directory;
- the I2C line is added once;
- the wait in `start` passes an expired code and times out with exit 5.

The fake `sleep` counts polls and never sleeps.

They run under `npx nx test data-pusher`:

```sh
cd apps/data-pusher && go test -race ./deploy/
```
