# VeSync Extended

A copy of Home Assistant's built-in VeSync integration, packaged as a HACS
custom integration, with extra entities for a **Levoit Superior 6000S
humidifier** (model LEH-S601S-WUS, firmware 3.0.03). It keeps the `vesync`
domain, so installing it replaces the built-in integration and the owner's
existing entities, automations and dashboards keep working.

- Based on HA core **2026.11.2**, `pyvesync==3.5.1`.
- Intended GitHub repo: `shaelr/ha-vesync-extended` (public, so HACS can
  install it). Not pushed yet.
- The owner runs HA OS 2026.11.2. The integration talks to Levoit's cloud
  (`cloud_polling`, every 60 s). The humidifier has no local API, so its LAN
  IP is irrelevant.

## Layout

```
custom_components/vesync/   the integration (what HACS installs)
  superior6000s.py          raw-status capture + commands pyvesync lacks
  extra_entities.py         all new 6000S entities and their factories
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
- `sensor.py`, `number.py`, `select.py`, `button.py`: one
  `async_add_entities(<x>_entities(devices, coordinator))` line each.
- `binary_sensor.py`: the `auto_stop_target_reached` description (all
  humidifiers, not just the 6000S).
- `humidifier.py`: device mode `manual` maps to HA mode `manual` (core maps it
  to `normal`). The owner wants the real name everywhere. Fans keep their real
  `normal` preset; don't touch that.
- `strings.json`, `translations/en.json`, `icons.json`, `manifest.json`.

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

Expected: **216 passed**. When the snapshot files change, check the diff only
adds or changes what you meant to.

If the format check fails, run `.ha-core/.venv/bin/ruff format
custom_components tests` from the repo root and run the script again. Updated
snapshots are copied back into `tests/vesync/snapshots/` automatically.

## Confirmed on the real humidifier

Read from HA diagnostics while the owner used the Levoit app:

- `workMode` stays `manual` while drying. **Dry is not a mode**, so it can't go
  in the humidifier's mode list.
- `dryingMode.dryingState`: `1` = drying, `2` = complete (an earlier cycle
  finished; `dryingRemain` resets to 7200). pyvesync calls 2 "pause", which is
  wrong for this device. `0` is assumed to be idle.
- `dryingMode.dryingLevel`: `1` = Low, `2` = High. Switching to High mid-cycle
  dropped the time left from ~1 h 54 m to ~26 min.
- `totalWorkTime` is in **seconds** (went up ~2 h between two reads 2 h
  apart).
- `timerRemain` is the off timer. The countdown the app shows during drying is
  `dryingRemain`, not the timer.
- `sensorContent.sensorStatus` is `noDevices` (no Levoit remote sensor
  paired).
- Levoit's cloud can take ~4 minutes to reflect a change made in the app.

## Experimental (sent by us, not confirmed on the device)

pyvesync has no 6000S commands for these, so `superior6000s.py` guesses from
other Levoit models:

| Feature | Command sent |
| --- | --- |
| Off timer | `addTimerV2` `{"startAct":[{"type":"powerSwitch","num":0,"act":0}],"total":<s>}`, falls back to `addTimer` `{"action":"off","total":<s>}`. Cancel uses `getTimerV2`/`delTimerV2` or `getTimer`/`delTimer` |
| Drying level | `setDryingMode` `{"autoDryingSwitch":<current>,"dryingLevel":1\|2}` |
| Reset filter | `resetFilter` `{}` (the command Levoit air purifiers use) |

A rejected command raises `HomeAssistantError` and changes nothing.

## Not done yet

1. **Push to GitHub.** Create `shaelr/ha-vesync-extended` (public, empty),
   then push `main`. Check the Tests and Validate workflows pass, then install
   through HACS (custom repository, type Integration) and restart HA.
2. **Test the experimental commands on the humidifier.** The filter is at 99%,
   so a working Reset filter just shows 100%. Set a 1-hour off timer and
   cancel it. Switch drying level.
3. **Real commands for filter reset and start drying.** Traffic capture
   failed (2026-11-22): the VeSync app (iOS build 6.0.11, run on the Mac)
   pins certificates for every VeSync host, so mitmproxy saw nothing. Don't
   retry the capture. Instead, the app binary's strings were read
   (`/Applications/VeSync.app/Wrapper/VeSync.app/VeSync`; the Kotlin strings
   are UTF-16, so plain `strings` misses them). The app's shared Kotlin code
   (`com.vesync.kmp.air.humidifier`) has a status model matching the 6000S
   exactly, and its full `bypassV2` method list is: `getHumidifierStatus`,
   `setSwitch`, `setVirtualLevel`, `setHumidityMode`, `setLampSwitch`,
   `setLightStatus`, `setSnoozeSwitch`, scene/schedule methods,
   `setDryingMode`, `setSelfCleanMode`, `setDirtyWaterClean`, `resetSensor`,
   `setSensorCalibrationValue`.
   - **Start/stop drying** is `setDryingMode` with the fields `dryingLevel`,
     `autoDryingSwitch`, `afterDryState`, `exitDryState` (ints). The app
     offers "dry then humidify" and "dry then power off", which are probably
     the `afterDryState` values. The numbers aren't readable from strings, so
     they have to be tried on the device (`dryingState == 1` confirms).
   - **Filter reset:** there's no filter command in the Kotlin list. The older
     Swift humidifier method list has `resetFilter`, which we already send.
     Unconfirmed.
   - **Calibration:** `resetSensor {sensorType}` and
     `setSensorCalibrationValue {sensorType, ...}` (other fields unknown).
   - Swift humidifier lists also have `setWaterShortageDrying` (for
     `waterShortageDryingSwitch`) and `setAutoDryingSwitch`.
   - **Never record anything but `method` and `data`.** Requests also hold
     the Levoit account ID and login token.
4. **Not started:**
   - Humidity calibration (see above for the command names).
   - A sensor/switch for `waterShortageDryingSwitch` (currently 1).

## Owner's HA setup (context)

- Entities: `humidifier.humidifier`, `number.humidifier_mist_level`,
  `sensor.humidifier_filter_life`, `binary_sensor.humidifier_low_water`, etc.
  The new ones follow the same `humidifier_` prefix.
- Automation `automation.adjust_humidifier_based_on_average_humidity` sets mist
  level from `sensor.average_humidity` against `input_number.target_humidity`.
  It doesn't set the mode.
- Dashboard: Overview (`lovelace`), view `default_view`, humidifier stack with
  a mist level card, an out-of-water alert and a filter maintenance expander
  (manual date tracking that a working Reset filter could replace).
