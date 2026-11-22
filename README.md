# VeSync Extended

Home Assistant's built-in VeSync integration, with extra entities for the
Levoit Superior 6000S humidifier. It installs as a custom integration with the
same `vesync` domain, so it replaces the built-in one and your existing
entities, automations and dashboards keep working.

Based on the VeSync integration from Home Assistant **2026.11.2**
(`pyvesync==3.5.1`).

## What it adds

All of these come from data the VeSync cloud already sends that the built-in
integration ignores.

| Entity | Type | Devices | Notes |
| --- | --- | --- | --- |
| Target humidity reached | Binary sensor | Humidifiers with auto stop | On when the humidifier has paused because it hit its target |
| Drying status | Sensor | Superior 6000S | `drying`, `paused` or `done` |
| Drying time remaining | Sensor | Superior 6000S | Minutes left on the drying cycle |
| Drying level | Select | Superior 6000S | `low` or `high` |
| Off timer | Number | Superior 6000S | 0–12 hours. Shows hours left, rounded up. Set 0 to cancel |
| Off timer remaining | Sensor | Superior 6000S | Minutes left on the off timer |
| Total run time | Sensor | Superior 6000S | Lifetime run time in hours (diagnostic) |
| External sensor status | Sensor | Superior 6000S | State of the optional Levoit remote sensor, for example `no_devices` (diagnostic) |

### Experimental

pyvesync has no commands for the **off timer** or **drying level** on the
Superior 6000S, so this integration sends them itself, using the same API
calls other Levoit humidifiers use:

- Off timer tries `addTimerV2` (LV600S style) first and falls back to
  `addTimer` (Classic/OasisMist style). Whichever works is remembered.
- Drying level sends `setDryingMode` with `dryingLevel`, keeping the current
  drying on/off setting.

If the cloud rejects one, Home Assistant shows an error and nothing changes.
Turn on debug logging for `custom_components.vesync` to see the reply.

### Not included

The humidifier reports that it supports **humidity calibration**, but the API
call to set it isn't known, so there's no calibration entity yet.

## Install with HACS

1. In HACS, open the menu (⋮) → **Custom repositories**.
2. Add `https://github.com/shaelr/ha-vesync-extended` with type **Integration**.
3. Find **VeSync Extended** in HACS and download it.
4. Restart Home Assistant.

Home Assistant logs a warning that a custom integration overrides the built-in
`vesync`. That is expected.

## Going back to the built-in integration

Remove **VeSync Extended** in HACS and restart. The new entities become
unavailable and can be deleted. Everything else carries on with the built-in
integration.

## Keeping up with Home Assistant

This copy doesn't change when Home Assistant updates its own VeSync
integration. When a new release changes `vesync` upstream, rebase these
changes onto it. They are kept small to make that easy:

- `superior6000s.py`: raw status capture and the extra commands.
- `extra_entities.py`: the new Superior 6000S entities.
- One-line hooks in `coordinator.py`, `sensor.py`, `number.py` and
  `select.py`; the target-reached description in `binary_sensor.py`; names in
  `strings.json` / `translations/en.json` and icons in `icons.json`.

## Tests

The tests run against a Home Assistant core checkout (see
`.github/workflows/tests.yml`). The CI checks out core at the matching
release, swaps in this integration and its tests, and runs
`pytest tests/components/vesync`.

## License

Apache 2.0, as with Home Assistant core, which this is derived from.
