# Bentwood H75 Grinder — Decaid Plugin

A [Decaid](https://github.com/decentespresso/decaid) plugin that connects to a
Bentwood grinder over its local WebSocket API and exposes grind telemetry,
recipe selection, and recipe editing.

**Status: early** The wire protocol below is reverse-engineered
from the [bentwood-flutter](https://github.com/randomcoffeesnob/bentwood-flutter)
reference app, not from official documentation. Please not that this can break any time with updates etc.

## What it does

- Registers the grinder as a Decaid **`grinder` device** (connected-grinder
  contract, [decaid#896](https://github.com/decentespresso/decaid/pull/896)),
  so it shows up in `/api/v1/devices` and is controlled through Decaid's
  `/api/v1/grinder/*` REST API and `/ws/v1/grinder/snapshot` WebSocket.
- When Decaid connects the device, it opens a WebSocket to the grinder
  (`ws://<ip>:81/ws`) and decodes the grinder's binary state/telemetry frames.
- Lets you read recipes, select a recipe, and patch individual recipe fields
  (burr gap, target weight) without hand-building the full recipe struct.
- Serves a **device settings page** (grinder address, recipes, live
  telemetry) that Decaid's device management opens from the grinder's
  "Device settings" action.
- Adds **Streamline dashboard controls** to the Grind and Dose tiles: set the
  burr gap from the Grind tile, edit the Bentwood target weight from the Dose
  tile, copy either value into the workflow, and see the grinder's status.
- Exposes the full raw telemetry and the recipe operations the grinder
  contract doesn't cover as plain **HTTP endpoints**.

## Installation

See `doc/Plugins.md` in the Decaid repo for the full plugin API contract.
Quick path for local testing — write `manifest.json` + `plugin.js` to a
running Decaid instance, then enable and configure it:

```bash
# 1. Install/overwrite the plugin source
curl -X PUT http://<decaid-host>:8080/api/v1/plugins/com.bentwood.grinder/source \
  -H 'content-type: application/json' \
  -d "$(node -e '
    const fs=require("fs");
    const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
    const plugin=fs.readFileSync("plugin.js","utf8");
    console.log(JSON.stringify({manifest, plugin}));
  ')"

# 2. Load it and turn on auto-load
curl -X POST http://<decaid-host>:8080/api/v1/plugins/com.bentwood.grinder/enable

# 3. Point it at your grinder: open "Device settings" on the grinder in
#    Decaid's device management, or save the address directly
curl -X POST 'http://<decaid-host>:8080/api/v1/plugins/com.bentwood.grinder/device-settings?deviceId=plugin%3Acom.bentwood.grinder%3Abentwood%3Agrinder' \
  -H 'content-type: application/json' \
  -d '{"ip": "192.168.1.123", "port": 81}'

# 4. Connect the grinder device (or set it as the preferred grinder so
#    Decaid auto-connects it after a scan)
curl -X PUT http://<decaid-host>:8080/api/v1/devices/connect \
  -H 'content-type: application/json' \
  -d '{"deviceId": "plugin:com.bentwood.grinder:bentwood:grinder"}'
```

Registering the device doesn't open a connection. Decaid runs the grinder's
`connect` handler (the generic device connect route, or preferred-grinder
auto-connect). If the grinder drops off the network, the plugin reports the
device disconnected. Decaid owns reconnecting, so the plugin has no
reconnect timer of its own.

Decaid can also install directly from a GitHub release or branch
(`POST /api/v1/plugins/install/github-release` / `.../github-branch`) once
this repo is published — see `doc/Plugins.md`'s "Distribution and Updates"
section for the tagging/versioning rules that applies to.

There's no simulator for third-party device plugins, so testing needs a real
Decaid instance on the same network as a real grinder.

## Device settings

The grinder's address is stored **per device** in the plugin's KV store
(`pluginStorage`, key `connection:<deviceId>`). It's set on the device
settings page or through the plugin settings fallback (below).

| Field | Type | Default | Description |
|---|---|---|---|
| `ip` | string | *(required)* | IPv4 address or hostname of the grinder |
| `port` | number | `81` | WebSocket port, 1–65535 |

Values are validated and stored as given (no trimming or coercion). Changing
the address while the grinder is connected drops the connection, so telemetry
never keeps flowing from the old address; reconnect it from device management
(or let preferred-grinder auto-connect pick it up).

### Plugin settings fallback

For Decaid builds without the device settings action, the address can also be
set in the plugin's own settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `GrinderIp` | string | `""` | IPv4 address or hostname of the grinder |
| `GrinderPort` | number | `81` | WebSocket port, 1–65535 |

Decaid reloads the plugin when its settings are saved. On load, a non-empty
`GrinderIp` is saved as the device's address if the device has none yet, or
if `GrinderIp` / `GrinderPort` changed since they were last applied (tracked
under the storage key `pluginSettings`). Otherwise the device's own address
stays, so an address saved later on the device settings page wins until the
plugin settings change again. Clearing `GrinderIp` leaves the saved address
as it is. Invalid values are ignored and logged.

### Settings page

The driver declares a `settings`-role surface
(`{"id": "settings", "role": "settings", "endpoint": "device-settings"}`).
Decaid's device management uses it for the grinder's **Device settings**
action ([decaid#956](https://github.com/decentespresso/decaid/pull/956), not
yet merged) and opens
`/api/v1/plugins/com.bentwood.grinder/device-settings?ui=1&deviceId=…&deviceName=…`
in its in-app browser. It works before the grinder is connected.

The page lets you:

- set the grinder's IP address and port;
- see the recipe list, select a recipe, and set the selected recipe's burr gap
  (10–600 µm, 5 µm steps) and target weight (0–200 g, 0.1 g steps);
- watch live state, motor speed, temperature and motor power (polled every
  second while the page is visible).

The page is self-contained (no external resources) and works in light and
dark mode and at phone width.

## Grinder device

Manifest driver:

```json
{
  "id": "bentwood",
  "type": "grinder",
  "capabilities": ["grindSetting", "rpmControl"],
  "controls": {
    "grindSetting": { "kind": "numeric", "min": 10, "max": 600, "step": 5 },
    "rpmControl": { "kind": "numeric", "min": 1400, "max": 1400 }
  }
}
```

Device ID: `plugin:com.bentwood.grinder:bentwood:grinder`.

The grind setting is the burr gap in µm (the raw recipe `discDistance`),
10–600 in 5 µm steps.

The motor runs at a fixed 1400 rpm and can't be changed. `rpmControl` is
declared only so Decaid accepts `rpm` in snapshots (it rejects `rpm` without
that capability); its control range is pinned to 1400–1400
([control descriptors, decaid#962](https://github.com/decentespresso/decaid/pull/962)).

Decaid's current connected-Grinder contract has no standard dose capability or
dose control descriptor: its only writable controls are `startStop`,
`grindSetting`, and `rpmControl`, and `controls` only describes the latter two.
The Bentwood target weight is therefore exposed through the supported
Streamline Dose `tile-mode` and plugin endpoint below, while workflow dose
changes continue to synchronize into the selected recipe's target weight.

Published `GrinderSnapshot` (Decaid adds `timestamp`):

| Field | Source |
|---|---|
| `state` | `grinding` while the grinder reports a grind in progress, otherwise `idle`; `unknown` until the first state frame |
| `setting` | Selected recipe's burr gap (`discDistance`) as a string; omitted until recipes are loaded |
| `rpm` | Always `1400`, the fixed motor speed |

Snapshots are published only when one of these values changes.

| Decaid route | Plugin handler | Effect |
|---|---|---|
| `PUT /api/v1/grinder/setting` `{"setting": "250"}` | `setGrindSetting` | Sets the selected recipe's burr gap in µm. Decaid rejects values outside 10–600; the plugin also rejects non-integers and values not on the 5 µm step |
| `PUT /api/v1/grinder/rpm` `{"rpm": 1400}` | `setRpm` | Does nothing; any other value is rejected by Decaid with `invalid_argument` before the plugin is called |
| `PUT /api/v1/grinder/state/grinding` / `idle` | — | `startStop` isn't declared (no known start/stop command), so Decaid returns `unsupported_operation` |

## Streamline dashboard

The plugin answers the [Streamline skin's plugin surfaces](https://github.com/decentespresso/streamline-js/blob/main/docs/plugin-surfaces.md)
protocol on its `skin` endpoint. Streamline draws these on the **Grind** and
**Dose** tiles in its own style; no plugin code runs in the skin.

| Grinder | Surface | What it does |
|---|---|---|
| Connected, recipes loaded | `tile-mode` **µm** | An option in the Grind tile's toggle. While selected, the tile shows the selected recipe's burr gap; `-` / `+` move it by 5 µm and the numpad sets it directly (10–600). Each change calls `skin-burr-gap`, which writes it to the grinder and answers once the grinder has confirmed the new recipe |
| Connected, idle | `tile-hint` **BW 250 µm** | Shows the burr gap under the tile's value. Tapping it copies the gap into the workflow's grinder setting, so the shot is logged with it |
| Connected, idle | Dose tile `tile-hint` **BW 18.0 g** | Shows the selected recipe's target weight under the Dose tile. Tapping it copies it into the workflow's dose (with "keep ratio" on, the yield follows). Left out when the target is outside the skin's 1–30 g dose range |
| Connected, idle | Dose tile `tile-mode` **BW** | Adds a Dose-tile mode whose `-` / `+` and numpad edit the selected recipe's target weight in 0.1 g steps. Each change updates the workflow dose and the grinder target weight together |
| Grinding | `tile-hint` **Grinding** | Highlighted while a grind is running; no action |
| Not connected | `tile-line` | `Bentwood offline`, `Bentwood connecting`, or `Bentwood: set IP` when no address is saved |

- **Live updates:** the answer includes `"live": {"endpoint": "skin-changed"}`.
  The plugin sends `{"what":"skin"}` on that websocket endpoint (`emit`
  permission) whenever what `skin` answers changes, at most once a second,
  so the tile follows the grinder without waiting for the skin's 1-minute poll.
- **Out-of-range gaps:** if the selected recipe's gap is outside 10–600 µm, the
  mode is left out (the skin would clamp it and show the wrong number) and only
  the hint shows the real value.
- **Rejected values snap back:** `skin-burr-gap` takes JSON `{"burrGap": <n>}`
  and uses the same check as everywhere else, so a typed value that isn't on the
  5 µm step gets `400`, and the tile reverts to the grinder's value on the
  skin's next read.
- **Dose mode range:** the Dose mode is shown only for a stored target from
  1–30 g, matching Streamline's editable dose range. It writes the workflow
  dose first, then patches the selected recipe target and waits for the
  grinder's recipe confirmation. If the grinder write is temporarily
  unavailable, the resulting workflow event is handled by the normal retry
  path.
- **Not used:** `header-button` (only one is drawn across all plugins, which a
  grinder shouldn't take), `shot-strip`, `ratio-action` and the screensaver
  button.

## Dose sync

With the `events.workflow` permission the plugin receives Decaid's
`workflowUpdated` event. Whenever the workflow's dose
(`context.targetDoseWeight`) changes, from the Dose tile, a profile or the
API, the plugin writes it to the **selected recipe's target weight**:

- The dose is rounded to the grinder's 0.1 g step (18.26 g → 18.3 g).
- Changes are debounced by 500 ms, so holding `-` / `+` on the Dose tile
  sends one write.
- The Dose tile's Bentwood mode writes the workflow dose and the selected
  recipe target together; the mode is a UI surface, not an unsupported
  `doseControl` manifest capability.
- If the grinder can't take the write yet (not connected, recipes not loaded,
  or grinding), the dose is kept and written once recipes arrive or the grind
  ends. So connecting the grinder, or selecting another recipe, also sets
  that recipe's target to the current dose.
- If the grinder doesn't store a value, it isn't retried until the dose,
  the selected recipe or the connection changes.

## HTTP endpoints

All served at `/api/v1/plugins/com.bentwood.grinder/<endpoint>`.

| Endpoint | Method | Description |
|---|---|---|
| `device-settings` | GET `?ui=1` | The device settings page (HTML) |
| `device-settings` | GET `?deviceId=<id>` | This device's connection settings, connection state and recipe limits (JSON); `404` for an unknown `deviceId` |
| `device-settings` | POST `?deviceId=<id>`, JSON body `{"ip", "port"}` | Validate and save this device's connection settings; responds with the saved values and whether the grinder was disconnected |
| `sensors` | GET | Full raw snapshot: complete parsed state (incl. AC power telemetry) + last-known recipe list |
| `recipes` | GET | Last-known recipe list only |
| `burrgap` | GET | Live burr-gap reading alongside the selected recipe's configured gap |
| `targetweight` | GET | Live weight reading alongside the selected recipe's configured target weight |
| `request-recipes` | POST | Re-fetch the recipe list from the grinder |
| `select-recipe` | POST `?recipeIndex=<n>` | Select a recipe by index and re-fetch recipes |
| `set-burr-gap` | POST `?discDistance=<n>` | Patch the *currently selected* recipe's burr gap: 10–600 µm in steps of 5 (same as `PUT /api/v1/grinder/setting`) |
| `set-target-weight` | POST `?target=<n>` | Patch the *currently selected* recipe's target weight in **mg**: 0–200000 in steps of 100 (0–200 g in 0.1 g steps) |
| `skin` | GET | Streamline dashboard surfaces (see above) |
| `skin-burr-gap` | POST, JSON body `{"burrGap": <n>}` | Set the selected recipe's burr gap from the Grind tile; answers `{"burrGap"}` with the value the grinder stored |
| `skin-target-weight` | POST, JSON body `{"targetWeight": <n>}` | Set the workflow dose and selected recipe target from the Dose tile; accepts 1–30 g in 0.1 g steps and answers with the stored target in grams |
| `skin-changed` | WebSocket (`/ws/v1/plugins/com.bentwood.grinder/skin-changed`) | `{"what":"skin"}` whenever the `skin` answer changes |

The read endpoints return the last-known values. The recipe write endpoints
wait for the command to be sent and respond `200` on success, `400` for an
invalid value, and `409` when the grinder can't take the write (not
connected, or no recipe snapshot loaded yet). `set-burr-gap` /
`set-target-weight` patch one field of the selected recipe's struct and leave
everything else untouched; recipes are requested automatically on connect and
re-fetched after every write.

The grinder device only carries `state`, `setting` and `rpm`. Telemetry
that was previously published as sensor channels (weight, grind time/target,
live motor RPM, temperature, fan speed, AC power, live blade position) is now
available only through `sensors`.

## Protocol notes

Source: `bentwood-flutter`'s `lib/device/messages.dart` /
`lib/device/device.dart` / `lib/services/websocket_service.dart`, ported to
JS in `plugin.js`.

- Frames are little-endian binary: a 13-byte header, a 125-byte state block,
  and an optional trailing array of 89-byte recipe structs.
- Outgoing commands are header-shaped frames with flag bits set (request
  recipes, select recipe, or a select → patch → reselect sequence to edit a
  recipe).
- Transport binary frames arrive/leave as base64; the plugin runtime
  only documents `btoa()`, not `atob()`, so both directions are hand-rolled
  in `plugin.js`.


## Development

`plugin.js` is a single sandboxed file — no imports, no `require`, no
`atob`/`fetch`-to-LAN (use the connect context's `transport`, not `fetch`, for the grinder
connection; `fetch` cannot reach private IPs). See `doc/Plugins.md` in the
Decaid repo for the full JS runtime contract and REST management API.

## Credits

- Protocol reverse-engineered from
  [randomcoffeesnob/bentwood-flutter](https://github.com/randomcoffeesnob/bentwood-flutter).
- Plugin API per [decentespresso/decaid](https://github.com/decentespresso/decaid)'s `doc/Plugins.md`.
