# Device runbook: onboard, claim, release, revoke

This runbook covers a MeatGeek device's life:

1. Onboard a fresh Raspberry Pi with one command from your laptop.
2. Claim it in the web app.
3. Release it.
4. Revoke it if it is lost.

The commands run against the dev environment (`meatgeek-v2-dev-rg`).

## The device

- A Raspberry Pi 4 with an MCP3008 ADC on SPI (1 grill RTD and 4 probe RTDs)
  and an LCD on I2C bus 1 at `0x27`.
- 64-bit Debian (`aarch64`); plain Debian, not Raspberry Pi OS, is fine. SPI
  must be on (`/dev/spidev0.0` exists). The command turns I2C on itself.
- You can reach it as `pi@<lan ip>` over ssh with a key, with no password.
  `pi` may need a password for `sudo`.

It runs two services as the system user `meatgeek`:

| Service               | Binary                               | What it does |
| --------------------- | ------------------------------------ | ------------ |
| `meatgeek-controller` | `/usr/local/bin/meatgeek-controller` | Reads the sensors, drives the LCD, and serves the local API on port 3000 |
| `meatgeek-pusher`     | `/usr/local/bin/meatgeek-pusher`     | Sends readings to Azure IoT Hub. It authenticates with the device's own certificate (DPS mode) |

The pusher keeps its state in `/var/lib/meatgeek-pusher` (mode `0700`). That
holds the device's private key, which never leaves the Pi, its certificate,
the cached DPS assignment, the claim code, the queue and the cook session.
Its settings are in `/etc/meatgeek-pusher/env` (mode `0640`, `root:meatgeek`):
the DPS ID scope, the device id, the state directory and the controller's URL.
That file holds no secret, and no connection string.

## Prerequisites (laptop, once)

On macOS:

```sh
brew install go azure-cli
az login
az extension add --name azure-iot
git clone https://github.com/stevebargelt/meatgeekv2.git   # or: git checkout main && git pull
cd meatgeekv2
```

Run the command from a checkout of `main`: it builds both binaries from that
checkout. Your Azure account needs Owner (or Contributor) on the resource
group, because `--auth-type key` reads the DPS and hub keys through ARM. If
ssh to the Pi asks for a password, install your key first with
`ssh-copy-id pi@<lan ip>`.

## Onboard

```sh
apps/data-pusher/deploy/onboard-pi.sh pi@<lan ip>
```

Options:

| Option | Default |
| ------ | ------- |
| `--device-id <id>` | `meatgeek-` and the last 8 hex digits of the Pi's serial number (`/proc/device-tree/serial-number`, or `Serial` in `/proc/cpuinfo`) |
| `--resource-group <name>` | `meatgeek-v2-dev-rg` |
| `--web-origin <url>` | `https://meatgeekv2-web.vercel.app` |
| `--dps <name>`, `--hub <name>` | the only DPS and the only IoT hub in the resource group |
| `--auth-type key\|login` | `key`; passed to `enrol-device.sh` |

The command runs these steps in order:

1. **Preflight.** It changes nothing. It checks Go (at least the version in
   `go.mod`), `az` and its sign-in, the azure-iot extension, and that the
   resource group has exactly one DPS and one hub. It reads the DPS ID scope.
   Then it checks ssh to the Pi, that the Pi is `aarch64`, and that
   `/dev/spidev0.0` exists. A failed check prints the command that fixes it,
   such as `fix: brew install go`, `fix: az login` or
   `fix: az extension add --name azure-iot`.
2. **Build.** It builds `meatgeek-controller` and `meatgeek-pusher` on the
   laptop for `linux/arm64` with `CGO_ENABLED=0`. It copies them, the two
   systemd units, the udev rule and `remote-install.sh` to
   `/tmp/meatgeek-onboard/` on the Pi.
3. **Install.** This is the first sudo prompt. It creates the `meatgeek`
   user and installs the binaries. It installs a udev rule that gives group
   `meatgeek` the SPI and I2C device nodes. It turns I2C on and installs the
   units. It creates the device's key and certificate. It starts the
   controller.
4. **Enrol.** It copies the certificate (never the key) back to the laptop and
   enrols it in DPS with `enrol-device.sh`.
5. **Start.** This is the second sudo prompt. It writes the env file and
   (re)starts the pusher. It waits up to 120 s for the pusher to register
   with DPS and hold a claim code, then removes `/tmp/meatgeek-onboard`.

Both sudo prompts come from `sudo` on the Pi: type the Pi's password for
`pi`. That is the only time anything needs root. No sudoers change is made.

The command ends by printing the device id and one of two results.

If the device is not claimed yet:

```
Device id:   meatgeek-abcdef12
Claim code:  7K3M-9QXR-2HTV
Expires:     2026-11-24T12:00:00Z
Claim it at: https://meatgeekv2-web.vercel.app/devices/claim?deviceId=meatgeek-abcdef12
```

If someone has already claimed it:

```
Device id:   meatgeek-abcdef12
already claimed: release it in the web app to claim it again
```

The claim code is shown only in your terminal. It is not in the URL, in a
file on the laptop, or in any log. It is valid for 24 hours. To get a fresh
one, run the command again.

**It is safe to run again.** On a Pi that is already set up, a second run
changes nothing except restarting the pusher, which replaces an expired code.
It prints the same device id and a valid code. Run it again after you pull a
newer `main`: it replaces only the binaries and units that changed, and
restarts the services that use them.

### If I2C was off

The first run on a fresh Pi may stop after the install with:

```
I2C was off; reboot the Pi (`sudo reboot`) and run the same command again
```

It exits with code 4. It has added `dtparam=i2c_arm=on` to
`/boot/firmware/config.txt`, once. On Debian's `raspi-firmware` it also adds
the line to `/etc/default/raspi-firmware-custom`, so a kernel upgrade keeps
it. It has also set the `i2c-dev` module to load at boot
(`/etc/modules-load.d/meatgeek.conf`). Reboot the Pi (`ssh pi@<lan ip> sudo
reboot`), wait for it to come back, and run the same command. It carries on
from where it stopped.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Done. The claim code, or "already claimed", is printed |
| 2 | A usage error, or the Pi's serial number could not be read: pass `--device-id` |
| 4 | Either the Pi must reboot (I2C was just turned on), or the device is revoked (see [Revoke](#revoke-a-lost-device)) |
| 5 | The pusher did not register with DPS within 120 s. The Pi's last 30 pusher log lines are printed |
| 1 | Anything else, including a failed preflight check (with its fix) |

## Claim

Open the URL the command printed. It goes to the web app's claim screen with
the device id filled in. Sign in, type the claim code, and claim the device.
The device then belongs to your account and appears under **Devices**.

A code works once. After a claim, running the command again prints
"already claimed".

## Release

In the web app, go to **Devices**. Press **Release** on the device's row and
confirm. The device leaves your account, and on its next twin update it mints
a new claim code, so it can be claimed again. Run the onboarding command to
see the new code.

The release is refused while a cook is active on the device. Stop the cook
first.

## Revoke a lost device

If a device is lost or stolen, revoke it, then release it:

```sh
apps/data-pusher/deploy/revoke-device.sh --device-id meatgeek-abcdef12
```

This disables the device's DPS enrollment and its IoT Hub identity. The hub
then refuses it, and it cannot register again. Nothing is deleted. Then
release the device in the web app. The script does not change who owns it.

The onboarding command refuses a revoked device with exit 4:

```
this device was revoked; re-run with REINSTATE=1 if you mean to bring it back
```

To bring a revoked Pi back (it was found, or it was revoked by mistake), run
the onboarding command with `REINSTATE=1`:

```sh
REINSTATE=1 apps/data-pusher/deploy/onboard-pi.sh pi@<lan ip>
```

A re-imaged Pi with the same serial number has the same device id and a new
key. The command replaces the certificate in its enrollment (`certificate
replaced` in its output) without being asked.

See [`apps/data-pusher/deploy/README.md`](../../apps/data-pusher/deploy/README.md)
for `enrol-device.sh` and `revoke-device.sh` in detail.

## Measuring latency

Two round trips can be read from data that is always there (HAR-150). Neither
depends on App Insights sampling.

**A cook started in the web app reaching the Pi.** When the pusher applies a
cook change it logs the time the API wrote it to the twin and how long it took
to arrive:

```sh
journalctl -u meatgeek-pusher --no-pager | grep applyLagMs
```

```text
... msg="iothub twin: applied and reported desired properties" appliedDesiredVersion=7 applyLagMs=840 cookId=… desiredUpdatedAt="2026-11-23T18:02:11.123Z" source=patch
```

- `desiredUpdatedAt` is the twin's desired `cookUpdatedAt`: the API's clock
  just before it sent the PATCH that set or cleared the cook (HAR-152). Every
  cook start and stop stamps it, in the same PATCH as `activeCookId` and
  `correlationId`.
- Why not IoT Hub's own `$metadata.<property>.$lastUpdated` (HAR-150's first
  source)? A desired patch IoT Hub delivers over MQTT carries only the changed
  properties and `$version`, never `$metadata`; only a full twin GET does. So
  a live cook change had no write time and logged no lag. The pusher still
  falls back to `$metadata` when a twin has no `cookUpdatedAt` (one the API
  wrote before HAR-152), which only helps on `source=get`.
- `applyLagMs` is the Pi's clock when the change arrived, minus
  `desiredUpdatedAt`. It compares two clocks, the API's and the Pi's, so it
  assumes both are right (NTP); a few ms of skew either way is noise.
- `source=patch`: the change arrived while connected. `source=get`: the Pi read
  it from the whole twin on connect, so the lag includes any time it was
  offline.
- No `applyLagMs` on the line means the twin carried no write time for the
  change (no `cookUpdatedAt` and, on a patch, never any `$metadata`), or no
  cook property changed (a claim-only change, or a reconnect with the same
  cook).
- The live `device twin` proof checks this on every deploy: its simulated
  device prints the same measurement on its twin line, and the proof's PASS
  line for the cook start ends `— applyLagMs <n>` (also
  `METRIC twin-device-apply-lag-ms`). That run is a reconnect (`source=get`),
  so it includes the seconds between the start and simdevice connecting.

**A reading on the Pi reaching the owner.** The API records two histograms for
every reading it pushes to an owner, in Application Insights `customMetrics`:

- `meatgeek.reading.hub_lag_ms`: IoT Hub's enqueued time minus the reading's
  own timestamp (device → hub);
- `meatgeek.reading.push_lag_ms`: the push time minus the reading's timestamp
  (device → hub → API → SignalR).

```sh
az monitor app-insights query -g meatgeek-v2-dev-rg --app meatgeek-v2-dev-appinsights \
  --analytics-query "customMetrics
| where name startswith 'meatgeek.reading'
| summarize readings = sum(valueCount), avgMs = sum(valueSum) / sum(valueCount),
            minMs = min(valueMin), maxMs = max(valueMax)
    by name, bin(timestamp, 1m)
| order by timestamp desc"
```

The exporter sends one aggregate per metric per minute (count, sum, min, max),
not one row per reading, so there are no true per-reading percentiles: read the
mean and the worst case per minute. Rows with `customDimensions.negative ==
true` are readings stamped ahead of the API's clock (device clock skew),
recorded as 0. The metrics carry no device or user, so this is every device's
readings together; run it while only the Pi is cooking.

## Troubleshooting

On the Pi:

```sh
systemctl status meatgeek-controller meatgeek-pusher
journalctl -u meatgeek-pusher -n 100 --no-pager     # registration, twin, publishing
journalctl -u meatgeek-controller -n 100 --no-pager # sensors, LCD, the local API
curl -s http://localhost:3000/api/robots/MeatGeekBot/commands/get_status   # the controller's local API (sudo apt install curl)
sudo -u meatgeek meatgeek-pusher claim-code --state-dir /var/lib/meatgeek-pusher
```

- **The pusher logs that DPS refused the registration.** The enrollment is
  missing or disabled. Run the onboarding command again. If it says the
  device is revoked, see [Revoke](#revoke-a-lost-device).
- **The pusher cannot reach the controller.** Check `journalctl -u
  meatgeek-controller` and the local API above. The pusher reads
  `DEVICE_URL=http://localhost:3000`.
- **The controller cannot open `/dev/spidev0.0` or `/dev/i2c-1`.** Check
  `ls -l /dev/spidev0.0 /dev/i2c-1`. Both should be group `meatgeek`, mode
  `crw-rw----`. If they are not, run `sudo udevadm trigger` or reboot.
- **The start step times out (exit 5).** The printed log lines say why. The
  usual causes are the Pi having no internet access, or a clock so wrong that
  TLS fails. Run the command again once that is fixed.
