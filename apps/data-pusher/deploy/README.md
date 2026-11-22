# Device enrolment and revocation

Two operator scripts for the IoT Hub Device Provisioning Service (DPS):

- **`enrol-device.sh`** enrols a device's public X.509 certificate, so the
  device can register with DPS and connect to IoT Hub.
- **`revoke-device.sh`** revokes a lost device, so IoT Hub accepts nothing more
  from it.

The device creates its own key and never gives it up.
`meatgeek-pusher identity init` (or `simdevice identity init`) prints only the
certificate PEM. That PEM is all these scripts need. The owner runs them from
their own machine, and CI runs them for the simulated devices, so both use the
same path.

For each device, the DPS enrollment id, the DPS registration id and the IoT
Hub device id are all the same value: the device id. The certificate's
subject CN must be that id too.

`meatgeek-pusher.service` in this directory is the systemd unit for the
pusher. It is not used by these scripts.

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

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | success (including `unchanged` and `already revoked`)                       |
| 2    | usage error, or a certificate refused (not a certificate, or the CN is not the device id) |
| 3    | not found: revoke found neither an enrollment nor a hub identity           |
| 4    | refused: the device is revoked and `REINSTATE=1` is not set (enrol)         |
| 1    | anything else: `az` or the extension missing, DPS or hub discovery failed or a named DPS or hub is not in the resource group, an `az` call failed. The message names the `az` command and its exit status |

## Tests

`scripts_test.go` runs both scripts with `bash` against a fake `az` on `PATH`.
The fake records every invocation and answers from a fixture directory set up
by each test. The tests check the result line, the exit code and the exact
`az` calls for every path above. They also check that the PEM never appears in
the output. They also run `bash -n` on both scripts, and `shellcheck` when it
is installed. They run under `npx nx test data-pusher`:

```sh
cd apps/data-pusher && go test -race ./deploy/
```
