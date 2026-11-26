/*
 * VeSync humidifier card, styled after the VeSync app (Levoit Superior 6000S).
 *
 *   type: custom:vesync-humidifier-card
 *   entity: humidifier.humidifier
 *   target_humidity_entity: input_number.target_humidity   # optional
 *   name: Humidifier                                       # optional
 *   humidity_entity: sensor.average_humidity               # optional, ring reading
 *   layout: full | compact | expandable                    # optional, default full
 *   humidity_automation: automation.x                      # optional, see _mode()
 *   display_lock_automation: automation.y                  # optional, Auto Lock tile
 *
 * The other entities (mist level, filter, timer, drying ...) are found on the
 * same device by their translation key, so renamed entity ids keep working.
 * Any of them can be overridden in the card config with the key names below.
 *
 * Served by the VeSync Extended integration; no separate install needed.
 */

const CARD_VERSION = "1.6.0";

// card config key -> [domain, translation_key]
const SIBLINGS = {
  mist_level_entity: ["number", "mist_level"],
  filter_entity: ["sensor", "filter_life"],
  reset_filter_entity: ["button", "reset_filter"],
  low_water_entity: ["binary_sensor", "water_lacks"],
  tank_lifted_entity: ["binary_sensor", "water_tank_lifted"],
  display_entity: ["switch", "display"],
  display_lock_entity: ["switch", "child_lock"],
  drying_level_entity: ["select", "drying_level"],
  drying_remaining_entity: ["sensor", "drying_time_remaining"],
  drying_status_entity: ["sensor", "drying_status"],
  off_timer_entity: ["number", "off_timer"],
  off_timer_remaining_entity: ["sensor", "off_timer_remaining"],
  dry_power_off_entity: ["switch", "drying_mode_power_off"],
  dry_water_shortage_entity: ["switch", "water_shortage_drying"],
};

const MODES = [
  { mode: "humidity", label: "Humidity", icon: "mdi:water-percent" },
  // Not a device mode: Manual with humidity_automation on (see _setMode).
  { mode: "average", label: "Average", icon: "mdi:home-analytics" },
  { mode: "manual", label: "Manual", icon: "mdi:hand-back-right-outline" },
  { mode: "auto", label: "Auto", icon: "mdi:alpha-a-circle-outline" },
  { mode: "sleep", label: "Sleep", icon: "mdi:weather-night" },
  { mode: "dry", label: "Dry", icon: "mdi:weather-windy" },
];

const RING_R = 92;
const RING_C = 2 * Math.PI * RING_R;
const RING_ARC = 0.75; // the ring is a 270° arc, open at the bottom

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Big ring reading for a countdown: "45 min" under an hour, "1:54 h" above.
const fmtCountdown = (min) => {
  if (min === undefined) return { value: "--", unit: "min" };
  const m = Math.max(0, Math.ceil(min));
  if (m < 60) return { value: String(m), unit: "min" };
  return { value: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`, unit: "h" };
};

const fmtMinutes = (min) => {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
};

class VeSyncHumidifierCard extends HTMLElement {
  static async getConfigElement() {
    await ensureHaForm();
    return document.createElement("vesync-humidifier-card-editor");
  }

  static getStubConfig(hass) {
    const entity = Object.keys(hass.states).find((e) =>
      e.startsWith("humidifier."),
    );
    return { entity: entity || "humidifier.humidifier" };
  }

  setConfig(config) {
    if (!config || !config.entity || !config.entity.startsWith("humidifier.")) {
      throw new Error("Set entity to a VeSync humidifier entity");
    }
    this._config = config;
    this._ids = null;
    this._dialog = null;
    this._error = null;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
      this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    }
    this._render();
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    if (!this._ids || (old && old.entities !== hass.entities)) {
      this._ids = this._findEntities();
    }
    const watched = this._watched();
    if (old && watched.every((id) => old.states[id] === hass.states[id])) {
      return;
    }
    // Don't rebuild an open timer picker under the user's finger.
    if (this._dialog === "timer") return;
    this._render();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    // Count the drying and timer minutes down between cloud polls.
    // Skipped while a dialog is open so an open picker isn't closed.
    this._tick = setInterval(() => {
      if (!this._dialog) this._render();
    }, 30000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
  }

  _isCompact() {
    const layout = this._config?.layout || "full";
    return layout === "compact" || (layout === "expandable" && !this._expanded);
  }

  getCardSize() {
    if (this._isCompact()) return 2;
    return 9;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  // ---------------------------------------------------------------- entities

  _findEntities() {
    const hass = this._hass;
    const cfg = this._config;
    const ids = { humidifier: cfg.entity };
    const main = hass.entities?.[cfg.entity];
    const device = main?.device_id;
    const siblings = device
      ? Object.values(hass.entities).filter((e) => e.device_id === device)
      : [];
    for (const [key, [domain, tkey]] of Object.entries(SIBLINGS)) {
      ids[key] =
        cfg[key] ||
        siblings.find(
          (e) =>
            e.entity_id.startsWith(`${domain}.`) && e.translation_key === tkey,
        )?.entity_id;
    }
    ids.temperature_entity =
      cfg.temperature_entity ||
      siblings.find(
        (e) =>
          e.entity_id.startsWith("sensor.") &&
          hass.states[e.entity_id]?.attributes.device_class === "temperature",
      )?.entity_id;
    ids.humidity_entity = cfg.humidity_entity;
    ids.target_humidity_entity = cfg.target_humidity_entity;
    ids.humidity_automation = cfg.humidity_automation;
    ids.display_lock_automation = cfg.display_lock_automation;
    return ids;
  }

  _watched() {
    return Object.values(this._ids || {}).filter(Boolean);
  }

  _state(key) {
    const id = this._ids?.[key];
    return id ? this._hass.states[id] : undefined;
  }

  _num(key) {
    const st = this._state(key);
    const v = st ? parseFloat(st.state) : NaN;
    return Number.isFinite(v) ? v : undefined;
  }

  _isOn(key) {
    return this._state(key)?.state === "on";
  }

  // Minutes left, counted down from when the sensor last changed.
  _minutesLeft(key) {
    const st = this._state(key);
    const v = this._num(key);
    if (v === undefined || !st) return undefined;
    const elapsed = (Date.now() - new Date(st.last_changed).getTime()) / 60000;
    return Math.max(0, v - Math.max(0, elapsed));
  }

  // ----------------------------------------------------------------- actions

  async _call(domain, service, data) {
    this._error = null;
    try {
      await this._hass.callService(domain, service, data);
    } catch (err) {
      this._error = err?.message || String(err);
    }
    this._render();
  }

  // With humidity_automation set, the card adds an Average button next to the
  // device's own Humidity mode (which only reads its built-in sensor). Average
  // puts the device in Manual and turns the automation on, which sets the
  // mist level from another sensor. Any other mode turns the automation off.
  async _setMode(mode) {
    const h = this._state("humidifier");
    if (!h) return;
    const auto = this._ids.humidity_automation;
    const deviceMode = mode === "average" ? "manual" : mode;
    if (auto && mode !== "average" && this._isOn("humidity_automation")) {
      await this._call("automation", "turn_off", { entity_id: auto });
    }
    const wasOn = h.state === "on";
    if (!wasOn) {
      await this._call("humidifier", "turn_on", { entity_id: h.entity_id });
    }
    if (!wasOn || h.attributes.mode !== deviceMode) {
      await this._call("humidifier", "set_mode", { entity_id: h.entity_id, mode: deviceMode });
    }
    if (auto && mode === "average") {
      await this._call("automation", "turn_on", { entity_id: auto });
      await this._call("automation", "trigger", { entity_id: auto, skip_condition: true });
    }
  }

  // With display_lock_automation set, the Auto Lock tile turns that automation
  // (which relocks the display whenever it unlocks) on or off. Turning it on
  // also locks the display straight away.
  async _setAutoLock(on) {
    const auto = this._ids.display_lock_automation;
    if (!auto) return;
    await this._call("automation", on ? "turn_on" : "turn_off", { entity_id: auto });
    if (on && this._ids.display_lock_entity && !this._error) {
      await this._call("switch", "turn_on", { entity_id: this._ids.display_lock_entity });
    }
  }

  // The mode to show. Manual with the humidity automation on shows as Average.
  _mode() {
    const raw = this._state("humidifier")?.attributes.mode;
    const virtual =
      !!this._ids?.humidity_automation && raw === "manual" && this._isOn("humidity_automation");
    return { mode: virtual ? "average" : raw, virtual };
  }

  // The mode buttons: the device's modes, plus Average with the automation.
  _modeList(available) {
    return MODES.filter((m) =>
      m.mode === "average" ? !!this._ids?.humidity_automation : available.includes(m.mode),
    );
  }

  _onClick(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    const v = el.dataset.value;
    const ids = this._ids;
    const h = ids.humidifier;
    switch (a) {
      case "power":
        this._call("humidifier", this._isOn("humidifier") ? "turn_off" : "turn_on", {
          entity_id: h,
        });
        break;
      case "mode":
        this._setMode(v);
        break;
      case "mist": {
        this._call("number", "set_value", {
          entity_id: ids.mist_level_entity,
          value: Number(v),
        });
        break;
      }
      case "target": {
        const t = this._target();
        if (!t) break;
        const next = Math.min(t.max, Math.max(t.min, t.value + Number(v) * t.step));
        if (next === t.value) break;
        if (t.kind === "input_number") {
          this._call("input_number", "set_value", { entity_id: t.entity, value: next });
        } else {
          this._call("humidifier", "set_humidity", { entity_id: h, humidity: next });
        }
        break;
      }
      case "drying-level":
        this._call("select", "select_option", {
          entity_id: ids.drying_level_entity,
          option: v,
        });
        break;
      case "toggle":
        this._call("switch", "toggle", { entity_id: ids[v] });
        break;
      case "auto-lock":
        this._setAutoLock(!this._isOn("display_lock_automation"));
        break;
      case "more-info":
        this.dispatchEvent(
          new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId: ids[v] },
          }),
        );
        break;
      case "open":
        this._dialog = v;
        if (v === "timer") {
          const left = this._minutesLeft("off_timer_remaining_entity") || 0;
          const preset = left > 0 ? Math.round(left) : 60;
          this._timerPick = { h: Math.floor(preset / 60), m: preset % 60 };
        }
        this._render();
        break;
      case "close":
        if (ev.target === el) {
          this._dialog = null;
          this._render();
        }
        break;
      case "timer-start": {
        const { h: hh, m } = this._timerPick;
        const minutes = Math.min(720, hh * 60 + m);
        this._dialog = null;
        this._call("number", "set_value", {
          entity_id: ids.off_timer_entity,
          value: minutes,
        });
        break;
      }
      case "timer-cancel":
        this._dialog = null;
        this._call("number", "set_value", { entity_id: ids.off_timer_entity, value: 0 });
        break;
      case "reset-filter":
        this._dialog = null;
        this._call("button", "press", { entity_id: ids.reset_filter_entity });
        break;
      case "expand":
        this._expanded = !this._expanded;
        this._render();
        break;
      case "dismiss-error":
        this._error = null;
        this._render();
        break;
      default:
        break;
    }
  }

  _onChange(ev) {
    const el = ev.target;
    if (el.dataset.pick && this._timerPick) {
      this._timerPick[el.dataset.pick] = Number(el.value);
      if (this._timerPick.h >= 12) this._timerPick.m = 0;
      this._render();
    }
  }

  // The target humidity control: the configured helper, or the humidifier's
  // own target (used by the device in Humidity and Auto mode).
  _target() {
    const h = this._state("humidifier");
    const { mode, virtual } = this._mode();
    const helper = this._state("target_humidity_entity");
    if (helper && (virtual || !(mode === "humidity" || mode === "auto"))) {
      const a = helper.attributes;
      const value = parseFloat(helper.state);
      if (!Number.isFinite(value)) return undefined;
      return {
        kind: "input_number",
        entity: helper.entity_id,
        value,
        min: a.min ?? 0,
        max: a.max ?? 100,
        step: a.step ?? 1,
      };
    }
    if (!h || h.attributes.humidity == null) return undefined;
    return {
      kind: "humidifier",
      entity: h.entity_id,
      value: h.attributes.humidity,
      min: h.attributes.min_humidity ?? 30,
      max: h.attributes.max_humidity ?? 80,
      step: 1,
    };
  }

  // --------------------------------------------------------------- rendering

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const hass = this._hass;
    if (!hass) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card class="card"></ha-card>`;
      return;
    }
    const h = this._state("humidifier");
    if (!h) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card class="card"><div class="missing">Entity not found: ${esc(this._config.entity)}</div></ha-card>`;
      return;
    }

    const unavailable = h.state === "unavailable";
    const { mode } = this._mode();
    // The device also dries on its own: after it's turned off ("Dry Mode:
    // Power Off") or when the tank runs dry ("Dry Mode: Water Shortage").
    // It can report power off meanwhile, so drying wins over the power state.
    const drying =
      !unavailable && (mode === "dry" || this._state("drying_status_entity")?.state === "drying");
    const on = h.state === "on" || drying;
    const poweredOff = h.state !== "on";
    const modes = h.attributes.available_modes || [];
    const name = this._config.name || h.attributes.friendly_name || "Humidifier";

    const rawHumidity = this._config.humidity_entity
      ? this._num("humidity_entity")
      : h.attributes.current_humidity;
    const humidity = rawHumidity == null ? undefined : Math.round(rawHumidity);
    const temp = this._state("temperature_entity");
    const filter = this._num("filter_entity");
    const lowWater = this._isOn("low_water_entity");
    const dryReason = !drying
      ? ""
      : lowWater
        ? "Out of water"
        : poweredOff
          ? "After power off"
          : "";
    const tankOff = this._isOn("tank_lifted_entity");
    const timerLeft = this._minutesLeft("off_timer_remaining_entity");
    const dryLeft = this._minutesLeft("drying_remaining_entity");
    const target = this._target();
    const mist = this._num("mist_level_entity");
    const mistSt = this._state("mist_level_entity");
    const mistMax = mistSt?.attributes.max ?? 9;

    // Ring
    let ringFrac = 0;
    let centre;
    if (drying) {
      ringFrac = dryLeft !== undefined ? Math.min(1, dryLeft / 120) : 1;
      const cd = fmtCountdown(dryLeft);
      const level = this._state("drying_level_entity")?.state === "high" ? "High" : "Low";
      centre = `
        <div class="ring-label">Drying${dryReason ? ` · ${esc(dryReason)}` : ""}</div>
        <div class="big">${cd.value}<span class="unit">${cd.unit}</span></div>
        <div class="ring-sub">${level} · time left</div>`;
    } else {
      ringFrac = humidity !== undefined ? humidity / 100 : 0;
      centre = `
        <div class="ring-label">Humidity</div>
        <div class="big">${humidity ?? "--"}<span class="unit">%</span></div>
        <div class="ring-sub">${
          !on
            ? "Off"
            : target
              ? `Target ${target.value}%`
              : esc(MODES.find((m) => m.mode === mode)?.label || mode || "")
        }</div>`;
    }
    const dash = RING_C * RING_ARC;
    const fill = dash * Math.max(0, Math.min(1, ringFrac));
    const targetTick =
      target && on && !drying
        ? (() => {
            const ang = (135 + 270 * (target.value / 100)) * (Math.PI / 180);
            const x1 = 110 + (RING_R - 13) * Math.cos(ang);
            const y1 = 110 + (RING_R - 13) * Math.sin(ang);
            const x2 = 110 + (RING_R + 13) * Math.cos(ang);
            const y2 = 110 + (RING_R + 13) * Math.sin(ang);
            return `<line class="tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
          })()
        : "";

    // Alerts
    const alerts = [];
    if (tankOff) alerts.push(["mdi:cup-off-outline", "Water tank removed"]);
    else if (lowWater) alerts.push(["mdi:water-alert", "Out of water. Refill the tank"]);

    // Adjust row: mist level (manual / sleep) and the target
    let adjust = "";
    if (on && !drying) {
      const parts = [];
      if (mist !== undefined && mode === "manual") {
        const bars = Array.from({ length: mistMax }, (_, i) => {
          const lvl = i + 1;
          return `<button class="bar ${lvl <= mist ? "lit" : ""}" style="--h:${30 + (70 * lvl) / mistMax}%" data-action="mist" data-value="${lvl}" aria-label="Mist level ${lvl}"></button>`;
        }).join("");
        parts.push(`
          <div class="panel">
            <div class="panel-head"><ha-icon icon="mdi:waves"></ha-icon><span>Mist level</span><b>${mist}</b></div>
            <div class="bars">${bars}</div>
          </div>`);
      }
      if (target) {
        parts.push(`
          <div class="panel">
            <div class="panel-head"><ha-icon icon="mdi:water-percent"></ha-icon><span>Target humidity</span></div>
            <div class="stepper">
              <button class="round" data-action="target" data-value="-1" ${target.value <= target.min ? "disabled" : ""} aria-label="Lower target"><ha-icon icon="mdi:minus"></ha-icon></button>
              <div class="step-val">${target.value}<span>%</span></div>
              <button class="round" data-action="target" data-value="1" ${target.value >= target.max ? "disabled" : ""} aria-label="Raise target"><ha-icon icon="mdi:plus"></ha-icon></button>
            </div>
          </div>`);
      }
      adjust = parts.length ? `<div class="adjust">${parts.join("")}</div>` : "";
    }

    // Drying level
    let dryLevel = "";
    const lvlSt = this._state("drying_level_entity");
    if (lvlSt && (drying || this._dialog === "dry")) {
      dryLevel = `
        <div class="segment">
          ${["low", "high"]
            .map(
              (o) =>
                `<button class="${lvlSt.state === o ? "sel" : ""}" data-action="drying-level" data-value="${o}">${o === "low" ? "Low" : "High"}</button>`,
            )
            .join("")}
        </div>`;
    }

    // Mode row
    const modeRow = this._modeList(modes)
      .map(
        (m) => `
        <button class="mode ${(drying ? m.mode === "dry" : on && mode === m.mode) ? "sel" : ""}" data-action="mode" data-value="${m.mode}" ${unavailable ? "disabled" : ""}>
          <span class="mode-icon"><ha-icon icon="${m.icon}"></ha-icon></span>
          <span class="mode-label">${m.label}</span>
        </button>`,
      )
      .join("");

    // Tiles
    const tiles = [];
    if (filter !== undefined) {
      tiles.push(`
        <button class="tile ${filter <= 10 ? "warn" : ""}" data-action="open" data-value="filter">
          <ha-icon icon="mdi:air-filter"></ha-icon>
          <span class="tile-name">Wick Filter</span>
          <span class="tile-state">${Math.round(filter)}%</span>
        </button>`);
    }
    if (this._ids.display_entity) {
      tiles.push(this._switchTile("display_entity", "mdi:lightbulb-outline", "Display"));
    }
    if (this._ids.display_lock_entity) {
      tiles.push(this._switchTile("display_lock_entity", "mdi:lock-outline", "Display Lock"));
    }
    if (this._ids.display_lock_automation) {
      const st = this._state("display_lock_automation");
      const on = st?.state === "on";
      tiles.push(`
        <button class="tile ${on ? "on" : ""}" data-action="auto-lock" ${!st || st.state === "unavailable" ? "disabled" : ""}>
          <ha-icon icon="mdi:lock-clock"></ha-icon>
          <span class="tile-name">Auto Lock</span>
          <span class="tile-state">${on ? "On" : "Off"}</span>
        </button>`);
    }
    if (this._ids.off_timer_entity) {
      const running = timerLeft !== undefined && timerLeft > 0;
      tiles.push(`
        <button class="tile ${running ? "on" : ""}" data-action="open" data-value="timer">
          <ha-icon icon="mdi:timer-outline"></ha-icon>
          <span class="tile-name">Timer</span>
          <span class="tile-state">${running ? fmtMinutes(timerLeft) : "Off"}</span>
        </button>`);
    }
    let drySettings = "";
    if (this._ids.dry_power_off_entity || this._ids.dry_water_shortage_entity) {
      const n = ["dry_power_off_entity", "dry_water_shortage_entity"].filter((k) =>
        this._isOn(k),
      ).length;
      drySettings = `
        <button class="row" data-action="open" data-value="dry">
          <ha-icon icon="mdi:weather-windy"></ha-icon>
          <span>Dry Mode settings</span>
          <span class="row-state">${n ? `${n} on` : "Off"}</span>
          <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
        </button>`;
    }

    const temperature = temp
      ? `<div class="chip"><ha-icon icon="mdi:thermometer"></ha-icon>${esc(
          hass.formatEntityState ? hass.formatEntityState(temp) : `${temp.state} ${temp.attributes.unit_of_measurement || ""}`,
        )}</div>`
      : "";

    const expandable = this._config.layout === "expandable";
    const modeLabel = esc(MODES.find((m) => m.mode === mode)?.label || mode || "On");
    const errorHtml = this._error
      ? `<div class="error" data-action="dismiss-error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${esc(this._error)}</span></div>`
      : "";
    const gradient = `
      <defs>
        <linearGradient id="vs-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="var(--vs-ring-a)"/>
          <stop offset="1" stop-color="var(--vs-ring-b)"/>
        </linearGradient>
      </defs>`;

    if (this._isCompact()) {
      const bits = [];
      if (unavailable) bits.push("Offline");
      else if (drying) {
        bits.push(dryReason ? `Drying (${dryReason.toLowerCase()})` : "Drying");
        if (dryLeft !== undefined) bits.push(`${fmtMinutes(dryLeft)} left`);
      } else if (!on) bits.push("Off");
      else {
        bits.push(modeLabel);
        if (mode === "manual" && mist !== undefined) bits.push(`Mist ${mist}`);
        if (target) bits.push(`Target ${target.value}%`);
      }
      if (on && !drying && timerLeft !== undefined && timerLeft > 0) bits.push(`Off in ${fmtMinutes(timerLeft)}`);
      if (temp) {
        bits.push(
          esc(hass.formatEntityState ? hass.formatEntityState(temp) : `${temp.state} ${temp.attributes.unit_of_measurement || ""}`),
        );
      }
      const miniCd = fmtCountdown(dryLeft);
      const miniValue = drying
        ? `${miniCd.value}${miniCd.unit === "min" ? "<small>min</small>" : ""}`
        : `${humidity ?? "--"}<small>%</small>`;
      const compactModes = this._modeList(modes)
        .map(
          (m) => `
          <button class="mode ${(drying ? m.mode === "dry" : on && mode === m.mode) ? "sel" : ""}" data-action="mode" data-value="${m.mode}" ${unavailable ? "disabled" : ""} title="${m.label}" aria-label="${m.label}">
            <span class="mode-icon"><ha-icon icon="${m.icon}"></ha-icon></span>
          </button>`,
        )
        .join("");
      this.shadowRoot.innerHTML = `
        <style>${STYLE}</style>
        <ha-card class="card compact ${on ? "is-on" : "is-off"} ${drying ? "is-dry" : ""}">
          <div class="c-row">
            <button class="mini" data-action="more-info" data-value="humidifier" aria-label="${drying ? "Drying time left" : "Humidity"}">
              <svg viewBox="0 0 220 220" class="ring">
                ${gradient}
                <circle class="track" cx="110" cy="110" r="${RING_R}"
                  stroke-dasharray="${dash} ${RING_C}" transform="rotate(135 110 110)"/>
                <circle class="value" cx="110" cy="110" r="${RING_R}"
                  stroke-dasharray="${fill} ${RING_C}" transform="rotate(135 110 110)"/>
              </svg>
              <span class="mini-val ${drying ? "dry" : ""}">${miniValue}</span>
            </button>
            <div class="title">
              <div class="name">${esc(name)}</div>
              <div class="status">${bits.join(" · ")}</div>
            </div>
            <button class="power ${poweredOff ? "" : "on"}" data-action="power" ${unavailable ? "disabled" : ""} aria-label="Power">
              <ha-icon icon="mdi:power"></ha-icon>
            </button>
          </div>
          ${alerts
            .map(([icon, text]) => `<div class="alert"><ha-icon icon="${icon}"></ha-icon><span>${text}</span></div>`)
            .join("")}
          <div class="c-bottom">
            <div class="modes">${compactModes}</div>
            ${expandable ? `<button class="expand" data-action="expand" aria-label="Show more"><ha-icon icon="mdi:chevron-down"></ha-icon></button>` : ""}
          </div>
          ${errorHtml}
        </ha-card>`;
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card class="card ${on ? "is-on" : "is-off"} ${drying ? "is-dry" : ""}">
        <div class="top">
          <div class="title">
            <div class="name">${esc(name)}</div>
            <div class="status">${unavailable ? "Offline" : drying ? "Drying" : on ? esc(MODES.find((m) => m.mode === mode)?.label || mode || "On") : "Off"}</div>
          </div>
          <div class="top-actions">
            ${expandable ? `<button class="expand" data-action="expand" aria-label="Show less"><ha-icon icon="mdi:chevron-up"></ha-icon></button>` : ""}
            <button class="power ${poweredOff ? "" : "on"}" data-action="power" ${unavailable ? "disabled" : ""} aria-label="Power">
              <ha-icon icon="mdi:power"></ha-icon>
            </button>
          </div>
        </div>

        <div class="chips">${temperature}</div>

        <div class="ring-wrap" data-action="more-info" data-value="humidifier">
          <svg viewBox="0 0 220 220" class="ring">
            <defs>
              <linearGradient id="vs-grad" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stop-color="var(--vs-ring-a)"/>
                <stop offset="1" stop-color="var(--vs-ring-b)"/>
              </linearGradient>
            </defs>
            <circle class="track" cx="110" cy="110" r="${RING_R}"
              stroke-dasharray="${dash} ${RING_C}" transform="rotate(135 110 110)"/>
            <circle class="value" cx="110" cy="110" r="${RING_R}"
              stroke-dasharray="${fill} ${RING_C}" transform="rotate(135 110 110)"/>
            ${targetTick}
          </svg>
          <div class="centre">${centre}</div>
        </div>

        ${alerts
          .map(
            ([icon, text]) =>
              `<div class="alert"><ha-icon icon="${icon}"></ha-icon><span>${text}</span></div>`,
          )
          .join("")}

        ${drying ? dryLevel : ""}
        ${adjust}

        <div class="modes">${modeRow}</div>

        <div class="tiles">${tiles.join("")}</div>
        ${drySettings}

        ${
          this._error
            ? `<div class="error" data-action="dismiss-error"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${esc(this._error)}</span></div>`
            : ""
        }
        ${this._renderDialog(filter, timerLeft, dryLevel)}
      </ha-card>`;
  }

  _switchTile(key, icon, label) {
    const st = this._state(key);
    const on = st?.state === "on";
    return `
      <button class="tile ${on ? "on" : ""}" data-action="toggle" data-value="${key}" ${!st || st.state === "unavailable" ? "disabled" : ""}>
        <ha-icon icon="${icon}"></ha-icon>
        <span class="tile-name">${label}</span>
        <span class="tile-state">${on ? "On" : "Off"}</span>
      </button>`;
  }

  _renderDialog(filter, timerLeft, dryLevel) {
    if (!this._dialog) return "";
    let body = "";
    if (this._dialog === "filter") {
      body = `
        <h3>Wick Filter</h3>
        <div class="filter-big">${filter !== undefined ? Math.round(filter) : "--"}<span>%</span></div>
        <div class="filter-bar"><div style="width:${Math.max(0, Math.min(100, filter || 0))}%"></div></div>
        <p class="hint">Reset after fitting a new wick filter.</p>
        <div class="dialog-actions">
          <button class="text" data-action="close">Close</button>
          ${this._ids.reset_filter_entity ? `<button class="primary" data-action="reset-filter">Reset filter</button>` : ""}
        </div>`;
    } else if (this._dialog === "timer") {
      const pick = this._timerPick || { h: 1, m: 0 };
      const hours = Array.from({ length: 13 }, (_, i) =>
        `<option value="${i}" ${i === pick.h ? "selected" : ""}>${i}</option>`,
      ).join("");
      const mins = Array.from({ length: 60 }, (_, i) =>
        `<option value="${i}" ${i === pick.m ? "selected" : ""} ${pick.h >= 12 && i ? "disabled" : ""}>${String(i).padStart(2, "0")}</option>`,
      ).join("");
      const running = timerLeft !== undefined && timerLeft > 0;
      const total = pick.h * 60 + pick.m;
      body = `
        <h3>Timer</h3>
        <p class="hint">${running ? `Turns off in ${fmtMinutes(timerLeft)}` : "Turn the humidifier off after"}</p>
        <div class="pickers">
          <label><select data-pick="h">${hours}</select><span>h</span></label>
          <label><select data-pick="m">${mins}</select><span>min</span></label>
        </div>
        <div class="dialog-actions">
          ${running ? `<button class="text danger" data-action="timer-cancel">Turn off timer</button>` : `<button class="text" data-action="close">Cancel</button>`}
          <button class="primary" data-action="timer-start" ${total ? "" : "disabled"}>${running ? "Change" : "Start"}</button>
        </div>`;
    } else if (this._dialog === "dry") {
      const row = (key, label, sub) => {
        const st = this._state(key);
        if (!st) return "";
        const on = st.state === "on";
        return `
          <button class="setting" data-action="toggle" data-value="${key}">
            <span><b>${label}</b><small>${sub}</small></span>
            <span class="switch ${on ? "on" : ""}"><span></span></span>
          </button>`;
      };
      body = `
        <h3>Dry Mode</h3>
        <p class="hint">Dries the wick so it stays fresh. Pick a level here; choose Dry in the modes to start.</p>
        ${dryLevel}
        ${row("dry_power_off_entity", "Dry Mode: Power Off", "Dry the wick after turning off")}
        ${row("dry_water_shortage_entity", "Dry Mode: Water Shortage", "Dry the wick when the tank runs out")}
        <div class="dialog-actions"><button class="primary" data-action="close">Done</button></div>`;
    }
    return `<div class="scrim" data-action="close"><div class="dialog">${body}</div></div>`;
  }
}

// ------------------------------------------------------------------ editor

const SIBLING_LABELS = {
  mist_level_entity: "Mist level",
  filter_entity: "Filter life",
  reset_filter_entity: "Reset filter button",
  low_water_entity: "Out of water",
  tank_lifted_entity: "Water tank lifted",
  display_entity: "Display",
  display_lock_entity: "Display lock",
  drying_level_entity: "Drying level",
  drying_remaining_entity: "Drying time remaining",
  drying_status_entity: "Drying status",
  off_timer_entity: "Off timer",
  off_timer_remaining_entity: "Off timer remaining",
  dry_power_off_entity: "Dry Mode: Power Off",
  dry_water_shortage_entity: "Dry Mode: Water Shortage",
};

const EDITOR_LABELS = {
  entity: "Humidifier",
  name: "Name (optional)",
  layout: "Layout",
  humidity_entity: "Humidity reading (optional, defaults to the humidifier's sensor)",
  target_humidity_entity: "Target humidity helper (optional)",
  humidity_automation:
    "Average mode automation (optional: adds an Average button that runs Manual with this automation on)",
  display_lock_automation:
    "Auto lock automation (optional: adds an Auto Lock tile that turns this automation on or off)",
  temperature_entity: "Temperature (optional)",
  ...SIBLING_LABELS,
};

const EDITOR_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "humidifier" } } },
  { name: "name", selector: { text: {} } },
  {
    name: "layout",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "full", label: "Full" },
          { value: "compact", label: "Compact" },
          { value: "expandable", label: "Compact, tap to expand" },
        ],
      },
    },
  },
  {
    name: "humidity_entity",
    selector: { entity: { domain: "sensor", device_class: "humidity" } },
  },
  {
    name: "humidity_automation",
    selector: { entity: { domain: "automation" } },
  },
  {
    name: "display_lock_automation",
    selector: { entity: { domain: "automation" } },
  },
  {
    name: "target_humidity_entity",
    selector: { entity: { domain: ["input_number", "number"] } },
  },
  {
    name: "temperature_entity",
    selector: { entity: { domain: "sensor", device_class: "temperature" } },
  },
  {
    name: "",
    type: "expandable",
    title: "Device entities (found automatically)",
    schema: Object.entries(SIBLINGS).map(([key, [domain]]) => ({
      name: key,
      selector: { entity: { domain } },
    })),
  },
];

// ha-form is loaded lazily by the frontend. Creating a built-in card's
// editor makes sure it is defined before our editor uses it.
async function ensureHaForm() {
  if (customElements.get("ha-form")) return;
  try {
    const helpers = await window.loadCardHelpers?.();
    const card = await helpers?.createCardElement({ type: "entities", entities: [] });
    await card?.constructor?.getConfigElement?.();
  } catch (_err) {
    // The editor still renders once ha-form appears.
  }
}

class VeSyncHumidifierCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  _update() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] ?? s.title ?? s.name;
      this._form.addEventListener("value-changed", (ev) => {
        const config = { type: this._config.type, ...ev.detail.value };
        for (const [k, v] of Object.entries(config)) {
          if (v === "" || v == null) delete config[k];
        }
        this._config = config;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config },
            bubbles: true,
            composed: true,
          }),
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
  }
}

const STYLE = `
  :host {
    --vs-text: var(--primary-text-color, #212121);
    --vs-dim: var(--secondary-text-color, #727272);
    --vs-surface: color-mix(in srgb, var(--vs-text) 6%, transparent);
    --vs-surface-hi: color-mix(in srgb, var(--vs-text) 11%, transparent);
    --vs-line: color-mix(in srgb, var(--vs-text) 10%, transparent);
    --vs-accent: #2fb5ff;
    --vs-ring-a: #2a7dff;
    --vs-ring-b: #47e0ff;
    --vs-dry: #ffb347;
    --vs-warn: #ff6b5e;
    display: block;
  }
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  button:disabled { cursor: default; opacity: 0.4; }
  button:focus-visible { outline: 2px solid var(--vs-accent); outline-offset: 2px; }
  ha-icon { --mdc-icon-size: 22px; display: inline-flex; }

  .card {
    display: block;
    position: relative;
    overflow: hidden;
    padding: 18px 16px 16px;
    color: var(--vs-text);
    background: var(--ha-card-background, var(--card-background-color, #fff));
    border-radius: var(--ha-card-border-radius, 24px);
    font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif);
  }
  .top-actions { display: flex; align-items: center; gap: 8px; }
  .expand {
    width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center;
    background: var(--vs-surface); color: var(--vs-dim); flex: none;
  }

  .compact { padding: 12px; }
  .c-row { display: flex; align-items: center; gap: 12px; }
  .c-row .title { flex: 1; min-width: 0; }
  .c-row .name { font-size: 16px; }
  .c-row .status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mini { position: relative; width: 56px; height: 56px; flex: none; }
  .mini .ring circle { stroke-width: 20; }
  .mini-val {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 500; font-variant-numeric: tabular-nums;
  }
  .mini-val.dry { font-size: 14px; }
  .mini-val small { font-size: 10px; color: var(--vs-dim); margin-left: 1px; }
  .compact .alert { margin: 10px 0 0; padding: 8px 12px; font-size: 13px; }
  .c-bottom { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .c-bottom .modes { flex: 1; margin: 0; justify-content: flex-start; gap: 8px; }
  .c-bottom .mode { flex: none; }
  .c-bottom .mode-icon { width: 38px; height: 38px; }
  .c-bottom .mode-icon ha-icon { --mdc-icon-size: 20px; }
  .c-bottom .expand { margin-left: auto; }

  .card.is-dry { --vs-ring-a: #ff8a3d; --vs-ring-b: #ffd166; }
  .missing { padding: 16px; }

  .top { display: flex; align-items: center; justify-content: space-between; }
  .name { font-size: 20px; font-weight: 600; }
  .status { font-size: 13px; color: var(--vs-dim); margin-top: 2px; }
  .power {
    width: 44px; height: 44px; border-radius: 50%;
    display: grid; place-items: center;
    background: var(--vs-surface); color: var(--vs-dim);
    transition: background 0.2s, color 0.2s;
  }
  .power.on { background: var(--vs-accent); color: #fff; }

  .chips { display: flex; gap: 8px; margin-top: 12px; min-height: 30px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px 5px 8px; border-radius: 999px;
    background: var(--vs-surface); font-size: 14px;
  }
  .chip ha-icon { --mdc-icon-size: 18px; color: var(--vs-dim); }

  .ring-wrap { position: relative; width: min(240px, 72%); margin: 0 auto; cursor: pointer; }
  .ring { display: block; width: 100%; }
  .ring circle { fill: none; stroke-width: 14; stroke-linecap: round; }
  .ring .track { stroke: var(--vs-line); }
  .ring .value { stroke: url(#vs-grad); transition: stroke-dasharray 0.6s ease; }
  .is-off .ring .value { stroke: var(--vs-surface-hi); }
  .ring .tick { stroke: var(--vs-text); stroke-width: 3; stroke-linecap: round; }
  .centre {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding-bottom: 6%;
  }
  .ring-label { font-size: 13px; color: var(--vs-dim); letter-spacing: 0.02em; }
  .big { font-size: 56px; font-weight: 300; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .big .unit { font-size: 20px; font-weight: 400; margin-left: 2px; color: var(--vs-dim); }
  .ring-sub { font-size: 14px; color: var(--vs-dim); }
  .is-dry .ring-label { color: var(--vs-dry); }

  .alert {
    display: flex; align-items: center; gap: 10px;
    margin: 4px 0 10px; padding: 10px 14px; border-radius: 14px;
    background: rgba(255, 107, 94, 0.16); color: var(--vs-warn); font-weight: 500;
    animation: vs-pulse 3s ease-in-out infinite;
  }
  @keyframes vs-pulse { 50% { background: rgba(255, 107, 94, 0.28); } }

  .adjust { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 12px; }
  .panel { background: var(--vs-surface); border-radius: 16px; padding: 10px 12px 12px; }
  .panel-head { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--vs-dim); }
  .panel-head ha-icon { --mdc-icon-size: 18px; color: var(--vs-accent); }
  .panel-head b { margin-left: auto; font-size: 16px; color: var(--vs-text); }
  .bars { display: flex; align-items: flex-end; gap: 4px; height: 46px; margin-top: 8px; }
  .bar { flex: 1; height: var(--h); border-radius: 4px; background: var(--vs-surface-hi); transition: background 0.2s; }
  .bar.lit { background: linear-gradient(to top, var(--vs-ring-a), var(--vs-ring-b)); }
  .stepper { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
  .round { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; background: var(--vs-surface-hi); }
  .step-val { font-size: 30px; font-weight: 300; font-variant-numeric: tabular-nums; }
  .step-val span { font-size: 15px; color: var(--vs-dim); margin-left: 1px; }

  .segment { display: flex; gap: 4px; padding: 4px; border-radius: 14px; background: var(--vs-surface); margin-bottom: 12px; }
  .segment button { flex: 1; padding: 9px 0; border-radius: 10px; font-weight: 500; color: var(--vs-dim); }
  .segment button.sel { background: var(--vs-dry); color: #2b1600; }

  .modes { display: flex; justify-content: space-between; gap: 4px; margin: 4px 0 14px; }
  .mode { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
  .mode-icon {
    width: 50px; height: 50px; border-radius: 50%; display: grid; place-items: center;
    background: var(--vs-surface); color: var(--vs-dim); transition: background 0.2s, color 0.2s;
  }
  .mode-label { font-size: 12px; color: var(--vs-dim); }
  .mode.sel .mode-icon { background: var(--vs-accent); color: #fff; }
  .mode.sel .mode-label { color: var(--vs-text); font-weight: 500; }
  .mode[data-value="dry"].sel .mode-icon { background: var(--vs-dry); color: #2b1600; }

  .tiles { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(64px, 1fr)); }
  .row {
    width: 100%; display: flex; align-items: center; gap: 10px; margin-top: 8px;
    padding: 12px; border-radius: 16px; background: var(--vs-surface); text-align: left; font-size: 13px; font-weight: 500;
  }
  .row ha-icon { color: var(--vs-dim); }
  .row-state { margin-left: auto; color: var(--vs-dim); font-weight: 400; font-size: 12px; }
  .row .chev { --mdc-icon-size: 18px; }
  .tile {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    padding: 12px 10px; border-radius: 16px; background: var(--vs-surface); text-align: left;
    transition: background 0.2s; min-width: 0;
  }
  .tile ha-icon { color: var(--vs-dim); margin-bottom: 6px; }
  .tile.on ha-icon { color: var(--vs-accent); }
  .tile.warn ha-icon, .tile.warn .tile-state { color: var(--vs-warn); }
  .tile-name { font-size: 13px; font-weight: 500; line-height: 1.2; }
  .tile-state { font-size: 12px; color: var(--vs-dim); }

  .error {
    display: flex; gap: 8px; align-items: center; margin-top: 12px; padding: 10px 12px;
    border-radius: 12px; background: rgba(255, 107, 94, 0.16); color: var(--vs-warn); font-size: 13px; cursor: pointer;
  }

  .scrim {
    position: absolute; inset: 0; z-index: 2;
    display: flex; align-items: flex-end; justify-content: center;
    background: rgba(0, 0, 0, 0.35); backdrop-filter: blur(2px);
  }
  .dialog {
    width: 100%; padding: 18px 18px 16px; border-radius: 22px 22px 0 0;
    background: var(--ha-card-background, var(--card-background-color, #fff)); box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.25);
    animation: vs-up 0.22s ease-out;
  }
  @keyframes vs-up { from { transform: translateY(30px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .dialog, .alert { animation: none; } }
  .dialog h3 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  .hint { margin: 0 0 14px; font-size: 13px; color: var(--vs-dim); }
  .filter-big { font-size: 48px; font-weight: 300; margin: 6px 0; }
  .filter-big span { font-size: 20px; color: var(--vs-dim); }
  .filter-bar { height: 8px; border-radius: 4px; background: var(--vs-surface-hi); overflow: hidden; margin-bottom: 12px; }
  .filter-bar div { height: 100%; background: linear-gradient(to right, var(--vs-ring-a), var(--vs-ring-b)); }
  .pickers { display: flex; justify-content: center; gap: 16px; margin: 6px 0 18px; }
  .pickers label { display: flex; align-items: center; gap: 6px; font-size: 15px; color: var(--vs-dim); }
  .pickers select {
    appearance: none; -webkit-appearance: none;
    font: inherit; font-size: 32px; font-weight: 300; text-align: center; color: var(--vs-text);
    background: var(--vs-surface-hi); border: 0; border-radius: 14px; padding: 8px 14px; min-width: 84px; cursor: pointer;
  }
  .pickers select option { color: var(--primary-text-color); background: var(--card-background-color); }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .dialog-actions .primary { padding: 10px 20px; border-radius: 999px; background: var(--vs-accent); color: #fff; font-weight: 600; }
  .dialog-actions .text { padding: 10px 14px; border-radius: 999px; color: var(--vs-dim); margin-right: auto; }
  .dialog-actions .danger { color: var(--vs-warn); }
  .setting {
    width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 14px; margin-bottom: 8px; border-radius: 14px; background: var(--vs-surface); text-align: left;
  }
  .setting b { display: block; font-weight: 500; font-size: 14px; }
  .setting small { display: block; color: var(--vs-dim); font-size: 12px; margin-top: 2px; }
  .switch { flex: none; width: 44px; height: 26px; border-radius: 13px; background: var(--vs-surface-hi); position: relative; transition: background 0.2s; }
  .switch span { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: transform 0.2s; }
  .switch.on { background: var(--vs-accent); }
  .switch.on span { transform: translateX(18px); }
`;

if (!customElements.get("vesync-humidifier-card-editor")) {
  customElements.define("vesync-humidifier-card-editor", VeSyncHumidifierCardEditor);
}

if (!customElements.get("vesync-humidifier-card")) {
  customElements.define("vesync-humidifier-card", VeSyncHumidifierCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "vesync-humidifier-card",
    name: "VeSync Humidifier",
    description: "A humidifier card styled after the VeSync app.",
    preview: true,
  });
  console.info(`%c VESYNC-HUMIDIFIER-CARD %c ${CARD_VERSION} `, "background:#2fb5ff;color:#fff", "");
}
