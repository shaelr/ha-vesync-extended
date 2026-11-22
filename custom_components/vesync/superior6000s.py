"""Extra Superior 6000S support that pyvesync does not cover.

pyvesync parses only part of the Superior 6000S status response. The cloud
also reports the total run time, the off-timer countdown, the drying level and
the state of the optional external sensor. This module keeps the raw status
dict after each poll and adds the commands pyvesync lacks for this model
(off timer and drying level).

Everything here is kept in one module so the rest of the integration stays
close to Home Assistant core and is easy to rebase.
"""

import logging
from typing import Any

from pyvesync.base_devices.vesyncbasedevice import VeSyncBaseDevice
from pyvesync.devices.vesynchumidifier import VeSyncSuperior6000S
from pyvesync.utils.helpers import Helpers

_LOGGER = logging.getLogger(__name__)

# Keys only the humidifier status response carries. Used to make sure the
# response saved on the device is a status poll and not a command reply.
_STATUS_KEYS = ("powerSwitch", "filterLifePercent", "workMode")

# dryingMode.dryingState. Seen on a real 6000S: 2 with a full dryingRemain
# while idle after an earlier cycle, then 1 counting down once drying starts.
# pyvesync calls 2 "pause"; "complete" matches what the device actually does.
DRYING_STATES: dict[int, str] = {0: "idle", 1: "drying", 2: "complete"}

# dryingMode.dryingLevel. The device and manual offer Low and High.
DRYING_LEVELS: dict[int, str] = {1: "low", 2: "high"}
DRYING_LEVELS_REVERSE: dict[str, int] = {v: k for k, v in DRYING_LEVELS.items()}

# The device's own timer button goes from 1 to 12 hours.
OFF_TIMER_MAX_HOURS = 12

# Which timer API flavour worked for a device, keyed by cid. The 6000S
# reports its countdown like the LV600S (V2 timers) but shares firmware
# traits with the 1000S (V1 timers), so both are tried once.
_timer_api: dict[str, str] = {}


def is_superior_6000s(device: VeSyncBaseDevice) -> bool:
    """Return True if the device is a Superior 6000S."""
    return isinstance(device, VeSyncSuperior6000S)


def extract_status(device: VeSyncBaseDevice) -> dict[str, Any] | None:
    """Return the raw status dict from the device's last status poll.

    pyvesync stores the full API reply on ``device.last_response``. Right after
    a poll that reply is the status response. Returns None if the saved reply
    is anything else, such as a command reply.
    """
    response = getattr(device, "last_response", None)
    data = getattr(response, "response_data", None)
    if not isinstance(data, dict):
        return None
    result = data.get("result")
    if isinstance(result, dict) and isinstance(result.get("result"), dict):
        result = result["result"]
    if not isinstance(result, dict):
        return None
    if not all(key in result for key in _STATUS_KEYS):
        return None
    return result


async def _call(
    device: VeSyncBaseDevice, method: str, data: dict[str, Any]
) -> dict[str, Any] | None:
    """Send a bypass V2 command and return the inner result, or None on error."""
    response = await device.call_bypassv2_api(method, data)  # type: ignore[attr-defined]
    if Helpers.process_dev_response(_LOGGER, method, device, response) is None:
        return None
    outer = response.get("result") if isinstance(response, dict) else None
    if not isinstance(outer, dict):
        return None
    try:
        code = int(outer.get("code", 0))
    except TypeError, ValueError:
        return None
    if code != 0:
        _LOGGER.debug("%s rejected by %s: %s", method, device.device_name, outer)
        return None
    inner = outer.get("result")
    return inner if isinstance(inner, dict) else {}


async def _timer_ids(device: VeSyncBaseDevice, flavour: str) -> list[int]:
    """Return the ids of the device's timers for one API flavour."""
    method = "getTimerV2" if flavour == "v2" else "getTimer"
    result = await _call(device, method, {})
    if not result:
        return []
    return [
        timer["id"]
        for timer in result.get("timers") or []
        if isinstance(timer, dict) and isinstance(timer.get("id"), int)
    ]


async def async_set_off_timer(device: VeSyncBaseDevice, seconds: int) -> bool:
    """Start a timer that turns the humidifier off after ``seconds``.

    Any existing timer is cleared first, so the device only ever has one.
    """
    await async_clear_off_timer(device)

    flavours = [_timer_api[device.cid]] if device.cid in _timer_api else ["v2", "v1"]
    for flavour in flavours:
        if flavour == "v2":
            payload: dict[str, Any] = {
                "startAct": [{"type": "powerSwitch", "num": 0, "act": 0}],
                "total": seconds,
            }
            result = await _call(device, "addTimerV2", payload)
        else:
            result = await _call(
                device, "addTimer", {"action": "off", "total": seconds}
            )
        if result is not None:
            if device.cid not in _timer_api:
                _LOGGER.info(
                    "%s accepted the %s timer API", device.device_name, flavour
                )
            _timer_api[device.cid] = flavour
            return True
    return False


async def async_clear_off_timer(device: VeSyncBaseDevice) -> bool:
    """Cancel any running timer. Returns True if nothing is left running."""
    flavours = [_timer_api[device.cid]] if device.cid in _timer_api else ["v2", "v1"]
    for flavour in flavours:
        ids = await _timer_ids(device, flavour)
        if not ids:
            continue
        method = "delTimerV2" if flavour == "v2" else "delTimer"
        ok = True
        for timer_id in ids:
            if await _call(device, method, {"id": timer_id}) is None:
                ok = False
        _timer_api[device.cid] = flavour
        return ok
    return True


async def async_set_drying_level(device: VeSyncBaseDevice, level: int) -> bool:
    """Set the drying level, keeping the current drying on/off setting."""
    switch = 1 if getattr(device.state, "drying_mode_auto_switch", None) == "on" else 0
    result = await _call(
        device,
        "setDryingMode",
        {"autoDryingSwitch": switch, "dryingLevel": level},
    )
    if result is None:
        return False
    device.state.drying_mode_level = level
    return True
