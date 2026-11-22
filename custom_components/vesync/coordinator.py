"""Class to manage VeSync data updates."""

from datetime import timedelta
import logging
import time
from typing import Any, override

from pyvesync import VeSync
from pyvesync.utils.errors import VeSyncError

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import UPDATE_INTERVAL, UPDATE_INTERVAL_ENERGY
from .superior6000s import extract_status, is_superior_6000s

_LOGGER = logging.getLogger(__name__)

type VesyncConfigEntry = ConfigEntry[VeSyncDataCoordinator]


class VeSyncDataCoordinator(DataUpdateCoordinator[None]):
    """Class representing data coordinator for VeSync devices."""

    config_entry: VesyncConfigEntry
    update_time: float | None = None

    def __init__(
        self, hass: HomeAssistant, config_entry: VesyncConfigEntry, manager: VeSync
    ) -> None:
        """Initialize."""
        self.manager = manager
        # Raw status of each Superior 6000S, keyed by cid (see superior6000s.py).
        self.extra_status: dict[str, dict[str, Any]] = {}

        super().__init__(
            hass,
            _LOGGER,
            config_entry=config_entry,
            name="VeSyncDataCoordinator",
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.capture_extra_status()

    def capture_extra_status(self) -> None:
        """Keep the raw status of devices pyvesync only partly parses."""
        for device in self.manager.devices:
            if not is_superior_6000s(device):
                continue
            if (status := extract_status(device)) is not None:
                self.extra_status[device.cid] = status

    def should_update_energy(self) -> bool:
        """Test if specified update interval has been exceeded."""
        if self.update_time is None:
            return True

        return time.time() - self.update_time >= UPDATE_INTERVAL_ENERGY

    @override
    async def _async_update_data(self) -> None:
        """Fetch data from API endpoint."""
        try:
            await self.manager.update_all_devices()
            self.capture_extra_status()

            if self.should_update_energy():
                self.update_time = time.time()
                for outlet in self.manager.devices.outlets:
                    await outlet.update_energy()
        except VeSyncError as err:
            raise UpdateFailed(f"The service is unavailable: {err}") from err
