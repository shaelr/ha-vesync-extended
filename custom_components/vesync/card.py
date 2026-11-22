"""Serve the VeSync humidifier dashboard card from the integration.

The card (``frontend/vesync-humidifier-card.js``) is loaded on every
dashboard, so ``type: custom:vesync-humidifier-card`` works without adding
a dashboard resource by hand. The integration version is added to the URL so
browsers fetch the new card after an update.
"""

from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN

CARD_FILE = "vesync-humidifier-card.js"
CARD_URL = f"/{DOMAIN}_extended/{CARD_FILE}"


async def async_register_card(hass: HomeAssistant) -> None:
    """Serve the card and add it to the frontend, if both are running."""
    if hass.http is None or "frontend" not in hass.config.components:
        return
    # Imported here: frontend is an after-dependency, not a requirement.
    from homeassistant.components.frontend import add_extra_js_url  # noqa: PLC0415

    integration = await async_get_integration(hass, DOMAIN)
    path = Path(__file__).parent / "frontend" / CARD_FILE
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(path), cache_headers=False)]
    )
    add_extra_js_url(hass, f"{CARD_URL}?v={integration.version}")
