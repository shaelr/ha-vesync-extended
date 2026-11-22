# VeSync Extended

A copy of Home Assistant's built-in VeSync integration, packaged as a HACS
custom integration, with extra entities for a **Levoit Superior 6000S
humidifier** (model LEH-S601S-WUS, firmware 3.0.03). It keeps the `vesync`
domain, so installing it replaces the built-in integration and the owner's
existing entities, automations and dashboards keep working.

- Based on HA core **2026.11.2**, `pyvesync==3.5.1`.
- GitHub repo: `shaelr/ha-vesync-extended` (public, so HACS can
  install it).
- The owner runs HA OS 2026.11.2. The integration talks to Levoit's cloud
  (`cloud_polling`, every 60 s). The humidifier has no local API, so its LAN
  IP is irrelevant.

## Layout

```
custom_components/vesync/   the integration (what HACS installs)
  superior6000s.py          raw-status capture + commands pyvesync lacks
  extra_entities.py         all new 6000S entities and their factories
  card.py                   serves the dashboard card and adds it to the frontend
  frontend/                 vesync-humidifier-card.js (the dashboard card)
  (everything else)         HA core 2026.11.2 code, plus one-line hooks
tests/vesync/               HA core's vesync tests + test_superior6000s.py
scripts/test.sh             runs the tests inside an HA core checkout
.github/workflows/          tests.yml (same as scripts/test.sh), validate.yml (HACS + hassfest)
```

### Keep changes rebase-friendly

New behaviour lives in `superior6000s.py` and `extra_entities.py`. Core files
only get small hooks:

- `coordinator.py`: `self.extra_status` dict and `capture_extra_status()`,
  called in `__init__` and after `update_all_devices()`.
- `sensor.py`, `number.py`, `select.py`, `button.py`, `switch.py`: one
  `async_add_entities(<x>_entities(devices, coordinator))` line each.
- `switch.py`: the core Auto Off switch (`auto_off_config`, `autoStopSwitch`)
  is skipped for the 6000S. The Levoit app has no such setting for it and
  no command to change it, so the owner asked to hide it.
- `__init__.py`: one `await async_register_card(hass)` line in `async_setup`.
- `services.py`: one `async_setup_send_command(hass)` line. The
  `vesync.send_command` developer action (device, method, data) sends any
  bypass V2 command and returns the reply plus the status read right after.
  It exists to work out unknown commands through HA.
- `binary_sensor.py`: the `auto_stop_target_reached` description (all
  humidifiers, not just the 6000S).
- `humidifier.py`: device mode `manual` maps to HA mode `manual` (core maps it
  to `normal`). The owner wants the real name everywhere. Fans keep their real
  `normal` preset; don't touch that. It also adds a `dry` mode for the 6000S
  (the `MODE_DRY`/`dry_mode_*` hooks from `extra_entities.py`): it shows while
  `dryingState == 1`, choosing it starts drying, and choosing a real mode
  while drying records the cycle as stopped.
- `strings.json`, `translations/en.json`, `icons.json`, `manifest.json`.
  Names follow the Levoit app (owner's request): `child_lock` is "Display
  lock", `drying_mode_power_off` is "Dry Mode: Power Off" and
  `water_shortage_drying` is "Dry Mode: Water Shortage". The Off timer is
  a number in minutes (0–720, typed in), so 90 = 1 h 30 min as in the app.

Keep it that way so a future HA release can be pulled in by re-copying core's
`homeassistant/components/vesync` and re-applying the hooks.

### How the raw status works

pyvesync parses only part of the 6000S status. After every poll,
`device.last_response.response_data["result"]["result"]` holds the full status
dict. `extract_status()` keeps it only if it has `powerSwitch`,
`filterLifePercent` and `workMode`, so command replies are never mistaken for
status. Entities in `extra_entities.py` read
`coordinator.extra_status[device.cid]` and apply optimistic updates after
commands.

## Dashboard card

`custom:vesync-humidifier-card` (plain JS, no build step) is styled after the
VeSync app. `card.py` serves it at `/vesync_extended/vesync-humidifier-card.js`
and loads it on every dashboard with `?v=<manifest version>`, so bump the
manifest version when the card changes. It finds the other entities on the
humidifier's device by translation key. Config: `entity` (required),
`target_humidity_entity`, `humidity_entity` (the ring reading), `name`,
`layout` (`full`, `compact`, or `expandable`: compact with a chevron to open
the full card; the open state isn't saved), `humidity_automation`, and
overrides such as `filter_entity`. It has a visual editor (`ha-form`). It uses
the theme's card background and text colours (the owner didn't want the app's
blue background). The owner's Home view uses it with
`input_number.target_humidity` and `sensor.average_humidity`.

`humidity_automation` exists because the device's Humidity mode only reads its
built-in sensor and the owner wants the house average. With it set, the
card adds an **Average** button (not a device mode) that puts the device in
Manual and turns the automation on
(`automation.adjust_humidifier_based_on_average_humidity` sets the mist level
from the average against the target, only while in Manual). The Humidity
button is the device's own mode. Any mode other than Average turns the
automation off. Manual + automation on shows as Average.

## Running tests

```bash
scripts/test.sh            # first run builds the environment (~10 min)
scripts/test.sh -k timer   # extra args go to pytest
scripts/test.sh --snapshot-update
```

The script checks out HA core 2026.11.2 into `.ha-core/`, installs it into
`.ha-core/.venv` with Python 3.14 (needs `uv`), copies this integration and
tests into it, builds translations, then runs ruff and pytest. The PyPI
`pytest-homeassistant-custom-component` package stops at HA 2026.2, which is
why the tests run inside core instead.

Expected: **227 passed**. When the snapshot files change, check the diff only
adds or changes what you meant to.

If the format check fails, run `.ha-core/.venv/bin/ruff format
custom_components tests` from the repo root and run the script again. Updated
snapshots are copied back into `tests/vesync/snapshots/` automatically.

## Confirmed on the real humidifier

Read from HA diagnostics while the owner used the Levoit app:

- `workMode` stays `manual` while drying. **Dry is not a device mode.** The
  HA `dry` mode is made up by us from `dryingState` (owner's request).
- `dryingMode.dryingState`: `1` = drying, `2` = stopped (a cycle finished,
  with `dryingRemain` back at 7200, or was stopped part way, keeping the time
  left). pyvesync calls 2 "pause". `0` is assumed to be idle.
- **Start drying** (sent through `vesync.send_command`, confirmed in the app):
  any `setDryingMode` that includes `dryingLevel` starts a cycle, with or
  without `afterDryState`. `setDryingMode {"autoDryingSwitch": x}` alone does
  not start drying. While drying, the same command changes the level.
- **Stop drying:** `setHumidityMode {"workMode": <current mode>}`. Sending
  the mode the device is already in ends the cycle, as the app does.
- So the Drying level select must not send anything while idle; it only
  remembers the level the `dry` mode will use.
- **Dry when out of water** (the app's "Dry Mode: Water Shortage"):
  `setWaterShortageDrying {"waterShortageDryingSwitch": true|false}`. It must
  be a JSON boolean; `0`/`1` and other field names give 11000000. The status
  still reports it as `0`/`1`.
- Device codes: `-1` means the method doesn't exist; `11000000` means the
  method exists but the data is wrong.
- "Dry Mode: Power Off" is `autoDryingSwitch`, already a core switch
  (`drying_mode_power_off`).
- Settings changed from HA take a few minutes to show in polls, so the Dry
  when out of water switch keeps the value it set for 5 minutes.
- `dryingMode.dryingLevel`: `1` = Low, `2` = High. Switching to High mid-cycle
  dropped the time left from ~1 h 54 m to ~26 min.
- `totalWorkTime` is in **seconds** (went up ~2 h between two reads 2 h
  apart).
- `timerRemain` is the off timer. The countdown the app shows during drying is
  `dryingRemain`, not the timer.
- `sensorContent.sensorStatus` is `noDevices` (no Levoit remote sensor
  paired).
- Levoit's cloud can take ~4 minutes to reflect a change made in the app.
- **Off timer** (tested from HA 2026-11-22: set 60 min, then cancelled):
  `addTimerV2` `{"startAct":[{"type":"powerSwitch","num":0,"act":0}],"total":<s>}`,
  falling back to `addTimer` `{"action":"off","total":<s>}`. Cancel uses
  `getTimerV2`/`delTimerV2` or `getTimer`/`delTimer`. Which flavour the 6000S
  accepted is logged at INFO ("accepted the ... timer API") but wasn't recorded.
- **Reset filter:** `resetFilter` `{}` works. Pressed from HA on 2026-11-22
  at 99%; the next polls read 100% back from the cloud.
- **`dry` mode from HA** works: choosing it starts drying, choosing Manual
  stops it (several cycles tested 2026-11-22).

A rejected command raises `HomeAssistantError` and changes nothing.

## Not done yet

Everything built so far is installed (HACS, 39f7e3c) and confirmed on the
device. The card loads from the integration (no dashboard resource), and the
extended entities use the `humidifier_` prefix.

1. **Humidity calibration** (not started).
2. **`afterDryState` / `exitDryState` values** for `setDryingMode` (ints). The
   app offers "dry then humidify" and "dry then power off", probably these.
   Which numbers mean what is unknown.

Notes for both: traffic capture failed (2026-11-22): the VeSync app (iOS build
6.0.11, run on the Mac) pins certificates for every VeSync host, so mitmproxy
saw nothing. Don't retry the capture. Instead, the app binary's strings were
read (`/Applications/VeSync.app/Wrapper/VeSync.app/VeSync`; the Kotlin strings
are UTF-16, so plain `strings` misses them). The app's shared Kotlin code
(`com.vesync.kmp.air.humidifier`) has a status model matching the 6000S
exactly, and its full `bypassV2` method list is: `getHumidifierStatus`,
`setSwitch`, `setVirtualLevel`, `setHumidityMode`, `setLampSwitch`,
`setLightStatus`, `setSnoozeSwitch`, scene/schedule methods, `setDryingMode`,
`setSelfCleanMode`, `setDirtyWaterClean`, `resetSensor`,
`setSensorCalibrationValue`.

- **Calibration:** `resetSensor {sensorType}` and
  `setSensorCalibrationValue {sensorType, ...}` (other fields unknown). Try
  them with `vesync.send_command`.
- Swift humidifier lists also have `setWaterShortageDrying` (for
  `waterShortageDryingSwitch`) and `setAutoDryingSwitch`.
- **Never record anything but `method` and `data`.** Requests also hold the
  Levoit account ID and login token.

## Owner's HA setup (context)

- Entities: `humidifier.humidifier`, `number.humidifier_mist_level`,
  `sensor.humidifier_filter_life`, `binary_sensor.humidifier_low_water`, etc.
  The new ones follow the same `humidifier_` prefix.
- Automation `automation.adjust_humidifier_based_on_average_humidity` sets mist
  level from `sensor.average_humidity` against `input_number.target_humidity`.
  It doesn't set the mode.
- Dashboard: Overview (`lovelace`), view `default_view`: an ecosee card, then
  `custom:vesync-humidifier-card`. The old manual filter-date helpers,
  script and reminder automation were deleted on 2026-11-22; filter life now
  comes from `sensor.humidifier_filter_life`.
