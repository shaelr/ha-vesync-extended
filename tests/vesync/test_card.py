"""Tests for serving the VeSync humidifier card."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.components.vesync import card
from homeassistant.core import HomeAssistant


async def test_card_not_registered_without_frontend(hass: HomeAssistant) -> None:
    """Nothing is registered when http and frontend aren't running."""
    with patch("homeassistant.components.frontend.add_extra_js_url") as add_js:
        await card.async_register_card(hass)
    add_js.assert_not_called()


async def test_card_registered(hass: HomeAssistant) -> None:
    """The card file is served and added to the frontend with a version."""
    hass.http = MagicMock(async_register_static_paths=AsyncMock())
    hass.config.components.add("frontend")
    integration = MagicMock(version="1.2.3")
    with (
        patch.object(
            card, "async_get_integration", AsyncMock(return_value=integration)
        ),
        patch("homeassistant.components.frontend.add_extra_js_url") as add_js,
    ):
        await card.async_register_card(hass)

    (paths,) = hass.http.async_register_static_paths.call_args.args
    assert paths[0].url_path == card.CARD_URL
    assert Path(paths[0].path).is_file()
    add_js.assert_called_once_with(hass, f"{card.CARD_URL}?v=1.2.3")
