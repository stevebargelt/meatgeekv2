# Lock-screen activity by push: the trials

The owner runs these on his own iPhone (#249), with the kit from #248, before
the rest of the lock-screen work (#250 to #253) is built on them. They answer
what Apple does not document:

- Does a push start a lock-screen activity when the app is in the background,
  and when it has been swiped away? Apple documents starting by push. Its staff
  have acknowledged a bug in which a swiped-away app is not issued the new
  activity's update token ([forums thread 805324](https://developer.apple.com/forums/thread/805324)).
- Can the server end an activity and start a fresh one by push, to get past
  iOS's 8-hour limit? Mechanically possible; Apple does not document it as a
  method.
- What does APNs answer for the update token of an ended activity?

Terms (lock-screen activity, running cook, closed) are the spec's (#237).

## The kit

- **The Push tab** (debug builds only: the tab is compiled out of a Release
  build). It shows the token that starts an activity by push, and each running
  lock-screen activity with its cook id and its update token, each with a copy
  button. Pull down or tap Refresh to re-read: an activity started by push
  while the app was closed shows when the app is next opened. Only an activity
  started by push has an update token; one the app started itself has none.
  Nothing logs a token.
- **The sender**: [`apps/ios/scripts/live-activity-push.mjs`](../../apps/ios/scripts/live-activity-push.mjs),
  run on the owner's Mac with Node (24, as the repository; built-ins only, no
  `npm ci`). It takes the key file, key id, team id and token as arguments,
  signs a provider token with the key in memory, sends one push to the APNs
  sandbox over HTTP/2 and prints APNs' answer (`200` accepted, or the status
  and `reason`). It prints the request without the device token and the
  authorization header, and writes nothing to disk. `--help` lists every
  option; `--dry-run` prints the request and sends nothing.
  - `start --token <push-to-start token> --cook-id <id> --cook-name <name>`
    starts one, with a banner and **no sound** (`"Cook started: <name>"`,
    body `"On the lock screen"`; the alert has no `sound` key; `--sound default`
    would add one). A start's alert needs a body: without one iOS drops the
    push and `liveactivitiesd` logs "Received start without an alert
    configuration", while APNs still answers `200` (#249).
  - `update --token <update token>` with readings (`--grill 230 --probe1 171`)
    and targets (`--target-probe1 203`), degrees F.
  - `end --token <update token>` shows "Cook ended" and dismisses it 15
    minutes later.
  - `--priority 5` sends at low priority; the default is 10.
  - `--input-push-token` adds `"input-push-token": 1` to a start push: a
    variant to try when no update token appears for a push-started activity.
- **Apple's Push Notifications Console**
  (<https://icloud.developer.apple.com/dashboard/notifications>) is an
  alternative with no key file. Whether it sends Live Activity pushes
  (push type `liveactivity`) was not checked when the kit was written: use
  the script, and note in #249 if the console worked too.

Nothing of the owner's is committed: the key stays in `~/.config/meatgeek/`,
and the tokens and team id are typed on his own terminal. Do not paste a
token, the key id or the team id into an issue: write "token A", "token B".

## Before the trials

1. The sandbox APNs key from [the owner's steps](../infrastructure/apns-key-vault.md#4-create-a-sandbox-apns-key):
   `~/.config/meatgeek/AuthKey_<KEYID>.p8` and `~/.config/meatgeek/apns.env`.
   An alias, not a `PUSH=...` variable: zsh does not split a variable into
   words, so `$PUSH start` fails with "no such file or directory". The script reads `APNS_KEY_PATH`, `APNS_KEY_ID` and `APPLE_TEAM_ID` from the
   environment when `--key-file`, `--key-id` and `--team-id` are not given:

   ```sh
   set -a; . ~/.config/meatgeek/apns.env; set +a
   alias PUSH='node apps/ios/scripts/live-activity-push.mjs'   # run from the repo root
   ```

   The key must allow the sandbox (or both environments) and the
   `com.meatgeek.ios` topic (Team Scoped is fine).
2. A debug build from Xcode on the iPhone, as in
   [Checking alerts on a real iPhone](../../apps/ios/README.md#checking-alerts-on-a-real-iphone)
   step 1: a build from Xcode receives from the sandbox. Sign in. Settings →
   MeatGeek → Live Activities is on.
3. **A running cook started on the web** (<https://meatgeekv2-web.vercel.app>)
   on a device that is sending readings. Copy its id from the cook's URL.
   Use a real running cook: each time the app opens it checks every activity
   against its cook, and ends one whose cook it cannot find. Do not start the
   cook in the app: that gives it the app's own activity, and opening the app
   then ends a second one for the same cook.
4. Open the app's **Push** tab and copy the start token. If it says "Not
   issued yet", wait on the tab a moment and pull to refresh; the system issues
   it once the app asks.
5. Note the iOS version (Settings → General → About).

Each push prints APNs' answer; record it with what the phone showed.

## The trials

**T1. Start by push, app in the background.** Open the app, go to the home
screen (do not swipe it away), lock the phone.

```sh
PUSH start --token <start token> --cook-id <cook id> --cook-name Brisket --grill 225 --probe1 160 --target-probe1 203
```

Record: did the banner show, silently; did the activity appear on the lock
screen. Then open the app's Push tab: does the new activity have an update
token? Copy it (token A), go to the home screen, and send an update:

```sh
PUSH update --token <token A> --grill 226 --probe1 165 --target-probe1 203
```

Record whether the lock screen changed. (Opening the app also takes the
activity over and updates it with the cook's real readings, so check the
lock screen before opening the app, and after the update with the app in the
background.)

**T2. Start by push, app swiped away.** End T1's activity
(`PUSH end --token <token A>`), wait for it to leave, or long-press it away.
Swipe the app away in the app switcher and lock the phone. Send the same
start push. Record whether it appeared. Then open the app on the Push tab and record whether the new activity
already has an update token (token B), its **Received** time and the tab's
**App active since** time. A Received time before App active since means the
app got the token while it was away. A Received time at or after it does not
show that the app was not woken (a swiped-away app may be launched in the
background without the tab running), but it does not show that it was either:
record it as "not shown". If it has none, pull to refresh and record
whether one comes while the app is open. If none comes at all, repeat T2 with
`--input-push-token` and record that.

**T3. End and start a fresh one, app in the background.** With an activity
from T1 or T2 running, the app in the background. "Its token" below is that
running activity's update token (token A or B), not the start token:

```sh
PUSH end --token <its token>
PUSH start --token <start token> --cook-id <cook id> --cook-name Brisket --alert-title "Still cooking: Brisket" --grill 225
```

Record: did "Cook ended" show, did the fresh activity appear, did its banner
show silently. To update the fresh activity you need its token: open the app,
record whether the Push tab already shows it and its Received time against App active since, copy it (token C), return to the
home screen, and send `PUSH update --token <token C> --grill 230`. Record
whether the lock screen took the update.

**T4. End and start a fresh one, app swiped away.** As T3, with the app
swiped away before the end and start pushes. To update the fresh one, open
the app, copy its token (token D), swipe the app away again, then send the
update. Record each step as in T3, and whether token D's Received time is before App active
since.

**T5. The token of an ended activity.** After T3 (or T4), send an update to
the ended activity's token:

```sh
PUSH update --token <the ended activity's token> --grill 231
```

Record APNs' answer exactly (status and reason; `200`, `400 BadDeviceToken`
and `410 Unregistered` are the ones Apple documents), and whether anything
changed on the phone. If you can, send it again an hour later and record that
answer too.

Record the iOS version with the results in #249.

## What the results mean

The server's choice for updates is between a **token per activity** (the app
hands the API each activity's update token; the server sends each update to
each token) and **iOS 18 broadcast channels** (the start push subscribes the
activity to a channel for the cook; the server sends one update to the
channel, and no per-activity token is needed).

| Result | Meaning |
|---|---|
| T1 and T2 both start an activity, and both issue its update token without the app opened (Received before App active since) | A token per activity works for every closed state. It is the simpler choice (no channel to create or delete per cook, no broadcast capability), and the per-token answers tell the server when a phone has gone. |
| T2 starts the activity, but its update token is not shown to arrive before the app is opened (the acknowledged bug, or "not shown") | A token per activity cannot update a cook started on the web while the app is swiped away: the lock screen would stay at its first reading. Broadcast channels avoid it: the start push names the channel, and the server never needs the activity's token. Choose channels. |
| T2 does not start an activity at all | Neither choice helps a swiped-away app: a cook started on the web shows only after the app opens (#251's repair on open). Alerts are unaffected. Record it; the design stays, with that limit stated. |
| T3 and T4 show a fresh activity that takes updates | The restart past 8 hours can be built: the server ends each activity before 8 hours and starts a fresh one. With a token per activity, the fresh activity's token must reach the API without the app opening (T3, T4: was token C or D received before App active since); if not, the fresh activity can only be updated through a channel, so choose channels. |
| T3 or T4 shows no fresh activity, or one that never takes an update | The restart cannot be built in that state. #250 to #253 wait for the owner's decision ([#249](https://github.com/stevebargelt/meatgeekv2/issues/249)): an 8-hour limit is not shipped quietly. The lock screen then shows "Open MeatGeek to resume" when the activity ends. |
| T5: `200` for an ended activity's token | APNs does not say an activity has ended: the server must forget the token itself when it ends the activity, and a token per activity cannot detect a phone-side dismissal from Apple's answers. That weighs towards channels. |
| T5: `410 Unregistered` or `400 BadDeviceToken` | The server can delete a dead activity token on Apple's answer, as it already does for alert tokens. |
