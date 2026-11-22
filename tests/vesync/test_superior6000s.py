"""Tests for the extra Superior 6000S entities."""

from types import SimpleNamespace
from typing import Any

import pytest
from pytest_homeassistant.common import MockConfigEntry
from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker

from homeassistant.components.number import (
    ATTR_VALUE,
    DOMAIN as NUMBER_DOMAIN,
    SERVICE_SET_VALUE,
)
from homeassistant.components.select import (
    ATTR_OPTION,
    DOMAIN as SELECT_DOMAIN,
    SERVICE_SELECT_OPTION,
)
from homeassistant.components.vesync.superior6000s import extract_status
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .common import mock_devices_response

DEVICE = "Humidifier 6000s"
BYPASS_URL = "https://smartapi.vesync.com/cloud/v2/deviceManaged/bypassV2"
OFF_TIMER = "number.humidifier_6000s_off_timer"
OFF_TIMER_REMAINING = "sensor.humidifier_6000s_off_timer_remaining"
DRYING_LEVEL = "select.humidifier_6000s_drying_level"


def _sent(aioclient_mock: AiohttpClientMocker) -> list[tuple[str, dict[str, Any]]]:
    """Return (method, data) for every bypass V2 command sent."""
    calls = []
    for _method, url, body, _headers in aioclient_mock.mock_calls:
        if str(url) != BYPASS_URL or not isinstance(body, dict):
            continue
        payload = body.get("payload", {})
        calls.append((payload.get("method"), payload.get("data") or {}))
    return calls


async def _setup(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    override: dict[str, Any] | None = None,
) -> None:
    """Set up the integration with only the Superior 6000S."""
    mock_devices_response(aioclient_mock, DEVICE, details_override=override)
    await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()


async def test_total_run_time(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Total run time is read from totalWorkTime, in seconds, shown in hours."""
    await _setup(hass, config_entry, aioclient_mock, {"totalWorkTime": 14736960})

    state = hass.states.get("sensor.humidifier_6000s_total_run_time")
    assert state is not None
    assert float(state.state) == pytest.approx(4093.6, abs=0.01)
    assert state.attributes["unit_of_measurement"] == "h"


async def test_no_run_time_without_field(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """No run time sensor is made when the device does not report it."""
    await _setup(hass, config_entry, aioclient_mock)
    assert hass.states.get("sensor.humidifier_6000s_total_run_time") is None


async def test_off_timer_shows_remaining_hours(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """The timer shows the hours left, rounded up."""
    await _setup(hass, config_entry, aioclient_mock, {"timerRemain": 5000})

    assert hass.states.get(OFF_TIMER).state == "2"
    assert float(hass.states.get(OFF_TIMER_REMAINING).state) == pytest.approx(
        83.33, abs=0.01
    )


async def test_set_off_timer(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Setting the timer sends addTimerV2 and updates the state at once."""
    await _setup(hass, config_entry, aioclient_mock)
    assert hass.states.get(OFF_TIMER).state == "0"
    aioclient_mock.mock_calls.clear()

    await hass.services.async_call(
        NUMBER_DOMAIN,
        SERVICE_SET_VALUE,
        {ATTR_ENTITY_ID: OFF_TIMER, ATTR_VALUE: 3},
        blocking=True,
    )

    sent = _sent(aioclient_mock)
    assert (
        "addTimerV2",
        {
            "startAct": [{"type": "powerSwitch", "num": 0, "act": 0}],
            "total": 10800,
        },
    ) in sent
    assert hass.states.get(OFF_TIMER).state == "3"
    assert float(hass.states.get(OFF_TIMER_REMAINING).state) == 180


async def test_cancel_off_timer(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Setting the timer to 0 looks up running timers and clears the state."""
    await _setup(hass, config_entry, aioclient_mock, {"timerRemain": 3600})
    aioclient_mock.mock_calls.clear()

    await hass.services.async_call(
        NUMBER_DOMAIN,
        SERVICE_SET_VALUE,
        {ATTR_ENTITY_ID: OFF_TIMER, ATTR_VALUE: 0},
        blocking=True,
    )

    methods = [method for method, _ in _sent(aioclient_mock)]
    assert "getTimerV2" in methods
    assert not any(m.startswith("addTimer") for m in methods)
    assert hass.states.get(OFF_TIMER).state == "0"


async def test_off_timer_rejected(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """A rejected timer raises an error and leaves the state alone."""
    await _setup(hass, config_entry, aioclient_mock)
    aioclient_mock.clear_requests()
    aioclient_mock.post(
        BYPASS_URL,
        json={
            "traceId": "1",
            "code": 0,
            "msg": "request success",
            "result": {"traceId": "1", "code": -1, "result": {}},
        },
    )

    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            NUMBER_DOMAIN,
            SERVICE_SET_VALUE,
            {ATTR_ENTITY_ID: OFF_TIMER, ATTR_VALUE: 2},
            blocking=True,
        )
    assert hass.states.get(OFF_TIMER).state == "0"


async def test_drying_level(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Drying level reads dryingLevel and sends setDryingMode."""
    await _setup(hass, config_entry, aioclient_mock)
    state = hass.states.get(DRYING_LEVEL)
    assert state.state == "low"
    assert state.attributes["options"] == ["low", "high"]
    aioclient_mock.mock_calls.clear()

    await hass.services.async_call(
        SELECT_DOMAIN,
        SERVICE_SELECT_OPTION,
        {ATTR_ENTITY_ID: DRYING_LEVEL, ATTR_OPTION: "high"},
        blocking=True,
    )

    assert ("setDryingMode", {"autoDryingSwitch": 1, "dryingLevel": 2}) in _sent(
        aioclient_mock
    )
    assert hass.states.get(DRYING_LEVEL).state == "high"


async def test_drying_status_states(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Drying status maps dryingState to done, drying or paused."""
    await _setup(
        hass,
        config_entry,
        aioclient_mock,
        {
            "dryingMode": {
                "dryingLevel": 2,
                "autoDryingSwitch": 1,
                "dryingState": 1,
                "dryingRemain": 1800,
            }
        },
    )

    assert hass.states.get("sensor.humidifier_6000s_drying_status").state == "drying"
    assert (
        float(hass.states.get("sensor.humidifier_6000s_drying_time_remaining").state)
        == 30
    )
    assert hass.states.get(DRYING_LEVEL).state == "high"


def _device(response_data: Any) -> SimpleNamespace:
    return SimpleNamespace(last_response=SimpleNamespace(response_data=response_data))


def test_extract_status_ignores_command_replies() -> None:
    """Only a status poll reply is kept, not a command reply."""
    status = {"powerSwitch": 1, "filterLifePercent": 99, "workMode": "manual"}
    assert extract_status(_device({"result": {"code": 0, "result": status}})) == status
    assert extract_status(_device({"result": {"code": 0, "result": {"id": 5}}})) is None
    assert extract_status(_device({"result": {"code": 0, "result": {}}})) is None
    assert extract_status(_device(None)) is None
    assert extract_status(SimpleNamespace()) is None
