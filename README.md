# VeSync Extended

Home Assistant's built-in VeSync integration, with extra entities for the
Levoit Superior 6000S humidifier. It installs as a custom integration with the
same `vesync` domain, so it replaces the built-in one and your existing
entities, automations and dashboards keep working.

Based on the VeSync integration from Home Assistant **2026.11.2**
(`pyvesync==3.5.1`).

## What it adds

| Entity | Type | Devices | Notes |
| --- | --- | --- | --- |
| Target humidity reached | Binary sensor | Humidifiers with auto stop | On when the humidifier has paused because it hit its target |
| Drying status | Sensor | Superior 6000S | `drying`, `stopped` or `idle` |
| Drying time remaining | Sensor | Superior 6000S | Time left on the drying cycle |
| Drying level | Select | Superior 6000S | `low` or `high`. While idle it only sets the level the next drying cycle uses |
| Off timer | Number | Superior 6000S | Minutes, 0–720 (90 = 1 h 30 min, as in the app). Set 0 to cancel |
| Off timer remaining | Sensor | Superior 6000S | Time left on the off timer |
| Dry Mode: Water Shortage | Switch | Superior 6000S | Dry the unit when the tank runs out |
| Reset filter | Button | Superior 6000S | Sets the wick filter life back to 100% |
| Total run time | Sensor | Superior 6000S | Lifetime run time (diagnostic) |
| External sensor status | Sensor | Superior 6000S | State of the optional Levoit remote sensor, for example `no_devices` (diagnostic) |

All of these were tested on a real Superior 6000S (firmware 3.0.03).
pyvesync has no commands for the off timer, drying, the water shortage switch
or filter reset on this model, so the integration sends them itself. If the
cloud rejects one, Home Assistant shows an error and nothing changes.

### Other changes

- The humidifier's **Manual** mode is called `manual` instead of `normal`,
  matching the Levoit app. Automations or scripts that set a VeSync humidifier
  to `normal` need changing to `manual`.
- The Superior 6000S gets a **`dry`** humidifier mode. It shows while the unit
  is drying; choosing it starts a drying cycle at the Drying level, and
  choosing another mode stops it.
- The core **Auto Off** switch is hidden for the Superior 6000S, which has no
  such setting.
- Names follow the Levoit app: "Display lock" (child lock) and
  "Dry Mode: Power Off".
- Readings come from Levoit's cloud, which can lag the app by a few minutes.

### Dashboard card

The integration serves a dashboard card styled after the VeSync app; no
dashboard resource is needed. Add it with:

```yaml
type: custom:vesync-humidifier-card
entity: humidifier.humidifier
```

It finds the humidifier's other entities by itself and has a visual editor.
Options include `layout` (`full`, `compact` or `expandable`),
`target_humidity_entity`, `humidity_entity`, `name`,
`humidity_automation` and `display_lock_automation` (adds an Auto Lock tile
that turns an automation of yours, one that relocks the display, on or off).

### Developer action

`vesync.send_command` (device, method, data) sends any bypass V2 command and
returns the reply plus the status read right after. It's for working out
commands the integration doesn't know yet.

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

- `superior6000s.py`: raw status capture, the extra commands and
  `vesync.send_command`.
- `extra_entities.py`: the new Superior 6000S entities.
- `card.py` and `frontend/`: the dashboard card.
- Small hooks in `coordinator.py`, `sensor.py`, `number.py`, `select.py`,
  `button.py`, `switch.py`, `humidifier.py`, `services.py` and `__init__.py`;
  the target-reached description in `binary_sensor.py`; names in
  `strings.json` / `translations/en.json` and icons in `icons.json`.

## Tests

The tests run against a Home Assistant core checkout: `scripts/test.sh`
locally, `.github/workflows/tests.yml` in CI. Both check out core at the
matching release, swap in this integration and its tests, and run ruff and
`pytest tests/components/vesync`.

## License

Apache 2.0, as with Home Assistant core, which this is derived from.
