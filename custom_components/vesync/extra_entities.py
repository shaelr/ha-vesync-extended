"""Superior 6000S entities built from data pyvesync does not parse.

Values come from the raw status the coordinator keeps for each Superior 6000S
(``coordinator.extra_status``). Commands go through superior6000s.py.
"""

from collections.abc import Callable
from dataclasses import dataclass
import math
import re
import time
from typing import Any, override

from pyvesync.base_devices.vesyncbasedevice import VeSyncBaseDevice

from homeassistant.components.button import ButtonEntity
from homeassistant.components.number import NumberDeviceClass, NumberEntity, NumberMode
from homeassistant.components.select import SelectEntity
from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.components.switch import SwitchEntity
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.typing import StateType

from .coordinator import VeSyncDataCoordinator
from .entity import VeSyncBaseEntity
from .superior6000s import (
    DRYING_LEVELS,
    DRYING_LEVELS_REVERSE,
    DRYING_STATE_DRYING,
    DRYING_STATE_STOPPED,
    DRYING_STATES,
    OFF_TIMER_MAX_MINUTES,
    async_clear_off_timer,
    async_reset_filter,
    async_set_off_timer,
    async_set_water_shortage_drying,
    async_start_drying,
    is_superior_6000s,
)

# Drying level picked in Home Assistant while the humidifier is not drying,
# keyed by cid. Sending a level starts drying, so it is kept here and used
# when the humidifier's dry mode is chosen.
_planned_level: dict[str, int] = {}


def _drying(status: dict[str, Any]) -> dict[str, Any]:
    """Return the dryingMode block of a status dict."""
    drying = status.get("dryingMode")
    return drying if isinstance(drying, dict) else {}


def _sensor_content(status: dict[str, Any]) -> dict[str, Any]:
    """Return the sensorContent block of a status dict."""
    content = status.get("sensorContent")
    return content if isinstance(content, dict) else {}


def _snake(value: Any) -> str | None:
    """Convert a camelCase API string such as noDevices to no_devices."""
    if not isinstance(value, str) or not value:
        return None
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def _int(value: Any) -> int | None:
    """Return value as an int, or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None


def _lookup(mapping: dict[int, str], value: Any) -> str | None:
    """Look up an API integer in a mapping, or return None."""
    key = _int(value)
    return None if key is None else mapping.get(key)


class VeSyncExtraEntity(VeSyncBaseEntity):
    """Base for entities that read the coordinator's raw status."""

    def __init__(
        self,
        device: VeSyncBaseDevice,
        key: str,
        coordinator: VeSyncDataCoordinator,
    ) -> None:
        """Initialize the entity."""
        super().__init__(device, coordinator)
        self._attr_unique_id = f"{self.base_unique_id}-{key}"

    @property
    def status(self) -> dict[str, Any]:
        """Return the latest raw status, or an empty dict."""
        return self.coordinator.extra_status.get(self.device.cid, {})

    @property
    @override
    def available(self) -> bool:
        """Return True if the device and its raw status are available."""
        return super().available and self.device.cid in self.coordinator.extra_status

    def _optimistic(self, **changes: Any) -> None:
        """Apply a change to the stored status until the next poll."""
        status = self.coordinator.extra_status.get(self.device.cid)
        if status is not None:
            status.update(changes)
        self.coordinator.async_update_listeners()


# Sensors


@dataclass(frozen=True, kw_only=True)
class VeSyncExtraSensorDescription(SensorEntityDescription):
    """Describe a sensor read from the raw status."""

    value_fn: Callable[[dict[str, Any]], StateType]
    exists_fn: Callable[[dict[str, Any]], bool]
    attributes_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None


EXTRA_SENSORS: tuple[VeSyncExtraSensorDescription, ...] = (
    VeSyncExtraSensorDescription(
        key="drying_status",
        translation_key="drying_status",
        device_class=SensorDeviceClass.ENUM,
        options=list(DRYING_STATES.values()),
        value_fn=lambda s: _lookup(DRYING_STATES, _drying(s).get("dryingState")),
        exists_fn=lambda s: "dryingState" in _drying(s),
    ),
    VeSyncExtraSensorDescription(
        key="drying_time_remaining",
        translation_key="drying_time_remaining",
        device_class=SensorDeviceClass.DURATION,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        suggested_unit_of_measurement=UnitOfTime.MINUTES,
        value_fn=lambda s: _int(_drying(s).get("dryingRemain")),
        exists_fn=lambda s: "dryingRemain" in _drying(s),
    ),
    VeSyncExtraSensorDescription(
        key="off_timer_remaining",
        translation_key="off_timer_remaining",
        device_class=SensorDeviceClass.DURATION,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        suggested_unit_of_measurement=UnitOfTime.MINUTES,
        value_fn=lambda s: _int(s.get("timerRemain")),
        exists_fn=lambda s: "timerRemain" in s,
    ),
    VeSyncExtraSensorDescription(
        key="total_run_time",
        translation_key="total_run_time",
        device_class=SensorDeviceClass.DURATION,
        state_class=SensorStateClass.TOTAL_INCREASING,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        suggested_unit_of_measurement=UnitOfTime.HOURS,
        suggested_display_precision=0,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda s: _int(s.get("totalWorkTime")),
        exists_fn=lambda s: "totalWorkTime" in s,
    ),
    VeSyncExtraSensorDescription(
        key="external_sensor_status",
        translation_key="external_sensor_status",
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda s: _snake(_sensor_content(s).get("sensorStatus")),
        exists_fn=lambda s: "sensorStatus" in _sensor_content(s),
        attributes_fn=lambda s: {
            _snake(k) or k: v
            for k, v in _sensor_content(s).items()
            if k != "sensorStatus"
        },
    ),
)


class VeSyncExtraSensor(VeSyncExtraEntity, SensorEntity):
    """A sensor read from the raw status."""

    entity_description: VeSyncExtraSensorDescription

    def __init__(
        self,
        device: VeSyncBaseDevice,
        description: VeSyncExtraSensorDescription,
        coordinator: VeSyncDataCoordinator,
    ) -> None:
        """Initialize the sensor."""
        super().__init__(device, description.key, coordinator)
        self.entity_description = description

    @property
    @override
    def native_value(self) -> StateType:
        """Return the sensor value."""
        return self.entity_description.value_fn(self.status)

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return extra attributes, if the sensor has any."""
        if self.entity_description.attributes_fn is None:
            return None
        return self.entity_description.attributes_fn(self.status) or None


# Off timer


class VeSyncOffTimerNumber(VeSyncExtraEntity, NumberEntity):
    """Off timer in minutes (90 = 1 h 30 min). Shows the time left, rounded up.

    0 cancels it.
    """

    _attr_translation_key = "off_timer"
    _attr_device_class = NumberDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES
    _attr_native_min_value = 0
    _attr_native_max_value = OFF_TIMER_MAX_MINUTES
    _attr_native_step = 1
    _attr_mode = NumberMode.BOX

    def __init__(
        self, device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator
    ) -> None:
        """Initialize the timer."""
        super().__init__(device, "off_timer", coordinator)

    @property
    @override
    def native_value(self) -> float | None:
        """Return the minutes left on the timer, rounded up."""
        remaining = _int(self.status.get("timerRemain"))
        if remaining is None:
            return None
        return math.ceil(remaining / 60)

    @override
    async def async_set_native_value(self, value: float) -> None:
        """Start the timer, or cancel it when set to 0."""
        minutes = int(value)
        if minutes <= 0:
            if not await async_clear_off_timer(self.device):
                raise HomeAssistantError("The humidifier did not cancel the timer")
            self._optimistic(timerRemain=0)
            return
        seconds = minutes * 60
        if not await async_set_off_timer(self.device, seconds):
            raise HomeAssistantError(
                "The humidifier rejected the timer. Enable debug logging for "
                "custom_components.vesync to see the reply"
            )
        self._optimistic(timerRemain=seconds)


# Drying


def _is_drying(status: dict[str, Any]) -> bool:
    """Return True if the humidifier is drying."""
    return _int(_drying(status).get("dryingState")) == DRYING_STATE_DRYING


def _level_to_use(cid: str, status: dict[str, Any]) -> int:
    """Return the level the dry mode will use."""
    if cid in _planned_level:
        return _planned_level[cid]
    level = _int(_drying(status).get("dryingLevel"))
    return level if level in DRYING_LEVELS else 1


class VeSyncDryingLevelSelect(VeSyncExtraEntity, SelectEntity):
    """Drying level (low or high).

    While drying this changes the level of the running cycle. Otherwise it
    only sets the level the dry mode uses, because sending a level to the
    humidifier starts drying.
    """

    _attr_translation_key = "drying_level"
    _attr_options = list(DRYING_LEVELS.values())

    def __init__(
        self, device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator
    ) -> None:
        """Initialize the select."""
        super().__init__(device, "drying_level", coordinator)

    @property
    @override
    def current_option(self) -> str | None:
        """Return the running level, or the level the dry mode will use."""
        if _is_drying(self.status):
            return _lookup(DRYING_LEVELS, _drying(self.status).get("dryingLevel"))
        return DRYING_LEVELS.get(_level_to_use(self.device.cid, self.status))

    @override
    async def async_select_option(self, option: str) -> None:
        """Change the running level, or remember it for the next cycle."""
        level = DRYING_LEVELS_REVERSE[option]
        _planned_level[self.device.cid] = level
        if not _is_drying(self.status):
            self.coordinator.async_update_listeners()
            return
        if not await async_start_drying(self.device, level):
            raise HomeAssistantError("The humidifier rejected the drying level")
        drying = dict(_drying(self.status))
        drying["dryingLevel"] = level
        self._optimistic(dryingMode=drying)


# Dry mode on the humidifier entity. Dry is not a device mode (workMode stays
# the same while drying), so humidifier.py adds it to the mode list and calls
# these. Picking any real mode while drying sends that mode, which stops it.

MODE_DRY = "dry"


def dry_mode_supported(
    device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator
) -> bool:
    """Return True if the humidifier entity should offer the dry mode."""
    return is_superior_6000s(device) and "dryingState" in _drying(
        _status(device, coordinator)
    )


def dry_mode_active(
    device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator
) -> bool:
    """Return True if the humidifier is drying."""
    return is_superior_6000s(device) and _is_drying(_status(device, coordinator))


async def async_start_dry_mode(
    device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator
) -> None:
    """Start drying at the level shown by the Drying level select."""
    status = _status(device, coordinator)
    level = _level_to_use(device.cid, status)
    if not await async_start_drying(device, level):
        raise HomeAssistantError("The humidifier did not start drying")
    _set_drying(coordinator, device, dryingLevel=level, dryingState=DRYING_STATE_DRYING)


@callback
def dry_mode_left(device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator) -> None:
    """Record that setting a real mode has stopped a running cycle."""
    if dry_mode_active(device, coordinator):
        _set_drying(coordinator, device, dryingState=DRYING_STATE_STOPPED)


def _set_drying(
    coordinator: VeSyncDataCoordinator, device: VeSyncBaseDevice, **changes: Any
) -> None:
    """Apply a dryingMode change to the stored status until the next poll."""
    status = coordinator.extra_status.get(device.cid)
    if status is not None:
        status["dryingMode"] = {**_drying(status), **changes}
    coordinator.async_update_listeners()


# Drying after the tank runs dry

# How long a value set from Home Assistant is shown even though polls still
# report the old one. Levoit's cloud takes up to ~4 minutes to catch up.
_PENDING_SECONDS = 300


class VeSyncWaterShortageDryingSwitch(VeSyncExtraEntity, SwitchEntity):
    """Start drying when the tank runs out of water (the app's Water Shortage)."""

    _attr_translation_key = "water_shortage_drying"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(
        self, device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator
    ) -> None:
        """Initialize the switch."""
        super().__init__(device, "water_shortage_drying", coordinator)
        self._pending: tuple[bool, float] | None = None

    @property
    @override
    def is_on(self) -> bool | None:
        """Return the setting, or the value just set until the cloud catches up."""
        value = _int(self.status.get("waterShortageDryingSwitch"))
        reported = None if value is None else value == 1
        if self._pending is not None:
            wanted, until = self._pending
            if time.monotonic() < until:
                return wanted
            self._pending = None
        return reported

    async def _async_set(self, enabled: bool) -> None:
        if not await async_set_water_shortage_drying(self.device, enabled):
            raise HomeAssistantError("The humidifier rejected the setting")
        self._pending = (enabled, time.monotonic() + _PENDING_SECONDS)
        self._optimistic(waterShortageDryingSwitch=int(enabled))

    @override
    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn drying after a water shortage on."""
        await self._async_set(True)

    @override
    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn drying after a water shortage off."""
        await self._async_set(False)


# Filter reset


class VeSyncResetFilterButton(VeSyncBaseEntity, ButtonEntity):
    """Reset the wick filter life to 100%."""

    _attr_translation_key = "reset_filter"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(
        self, device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator
    ) -> None:
        """Initialize the button."""
        super().__init__(device, coordinator)
        self._attr_unique_id = f"{self.base_unique_id}-reset_filter"

    @override
    async def async_press(self) -> None:
        """Reset the filter life."""
        if not await async_reset_filter(self.device):
            raise HomeAssistantError(
                "The humidifier rejected the filter reset. Enable debug logging "
                "for custom_components.vesync to see the reply"
            )
        status = self.coordinator.extra_status.get(self.device.cid)
        if status is not None:
            status["filterLifePercent"] = 100
        self.coordinator.async_update_listeners()


# Factories used by the platform modules


def _status(device: VeSyncBaseDevice, coordinator: VeSyncDataCoordinator) -> dict:
    """Return the raw status for a device, or an empty dict."""
    return coordinator.extra_status.get(device.cid, {})


def sensor_entities(
    devices: Any, coordinator: VeSyncDataCoordinator
) -> list[SensorEntity]:
    """Return the extra sensors for these devices."""
    return [
        VeSyncExtraSensor(dev, description, coordinator)
        for dev in devices
        if is_superior_6000s(dev)
        for description in EXTRA_SENSORS
        if description.exists_fn(_status(dev, coordinator))
    ]


def number_entities(
    devices: Any, coordinator: VeSyncDataCoordinator
) -> list[NumberEntity]:
    """Return the extra numbers for these devices."""
    return [
        VeSyncOffTimerNumber(dev, coordinator)
        for dev in devices
        if is_superior_6000s(dev) and "timerRemain" in _status(dev, coordinator)
    ]


def select_entities(
    devices: Any, coordinator: VeSyncDataCoordinator
) -> list[SelectEntity]:
    """Return the extra selects for these devices."""
    return [
        VeSyncDryingLevelSelect(dev, coordinator)
        for dev in devices
        if is_superior_6000s(dev)
        and "dryingLevel" in _drying(_status(dev, coordinator))
    ]


def button_entities(
    devices: Any, coordinator: VeSyncDataCoordinator
) -> list[ButtonEntity]:
    """Return the extra buttons for these devices."""
    return [
        VeSyncResetFilterButton(dev, coordinator)
        for dev in devices
        if is_superior_6000s(dev)
        and getattr(dev.state, "filter_life", None) is not None
    ]


def switch_entities(
    devices: Any, coordinator: VeSyncDataCoordinator
) -> list[SwitchEntity]:
    """Return the extra switches for these devices."""
    return [
        VeSyncWaterShortageDryingSwitch(dev, coordinator)
        for dev in devices
        if is_superior_6000s(dev)
        and "waterShortageDryingSwitch" in _status(dev, coordinator)
    ]
