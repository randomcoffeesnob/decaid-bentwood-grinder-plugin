"use strict";

/*
 * Bentwood Grinder plugin for Decaid.
 *
 * Talks to the grinder's own WebSocket API (ws://<ip>:81/ws) using the
 * binary protocol reverse-engineered from the bentwood-flutter reference
 * app (lib/device/messages.dart) by randomcoffeesnob. 
 */

// ---------------------------------------------------------------------------
// base64 <-> bytes (host.transport binary frames are base64 strings; only
// btoa() is documented as available in the plugin runtime, so both
// directions are implemented by hand here rather than assuming atob()).
// ---------------------------------------------------------------------------

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes) {
  let result = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += B64_CHARS[(n >> 18) & 0x3f] + B64_CHARS[(n >> 12) & 0x3f] + B64_CHARS[(n >> 6) & 0x3f] + B64_CHARS[n & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    result += B64_CHARS[(n >> 18) & 0x3f] + B64_CHARS[(n >> 12) & 0x3f] + "==";
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += B64_CHARS[(n >> 18) & 0x3f] + B64_CHARS[(n >> 12) & 0x3f] + B64_CHARS[(n >> 6) & 0x3f] + "=";
  }
  return result;
}

function base64ToBytes(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) lookup[B64_CHARS.charCodeAt(i)] = i;

  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    if (clean[i] === "=") break;
    const v = lookup[c];
    if (v === -1) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

const MessageFlags = {
  status: 0,
  recipes: 1 << 0,
  filters: 1 << 1,
  settings: 1 << 2,
  adcLog: 1 << 3,
  servoLog: 1 << 4,
  log: 1 << 5,
  recipeReset: 1 << 11,
  selectRecipe: 1 << 15,
  bldc: 1 << 17,
  counters: 1 << 22,
  brew: 1 << 23,
  enable: 1 << 31,
  legacyRecipeFetch: (1 << 30) | (1 << 3),
};

const HEADER_SIZE = 13;
const STATE_SIZE = 125;
const RECIPE_SIZE = 89;
const POWER_SIZE = 44;

function parseHeader(view, offset) {
  return {
    flags: view.getUint32(offset, true),
    requestFlags: view.getUint32(offset + 4, true),
    numRecipes: view.getUint8(offset + 8),
    numFilters: view.getUint8(offset + 9),
    numAdcValues: view.getUint8(offset + 10),
    numServoLog: view.getUint8(offset + 11),
    numLog: view.getUint8(offset + 12),
  };
}

function parsePower(view, offset) {
  return {
    timestamp: view.getUint32(offset, true),
    voltageRms: view.getFloat32(offset + 4, true),
    currentRms: view.getFloat32(offset + 8, true),
    powerActive: view.getFloat32(offset + 12, true),
    powerReactive: view.getFloat32(offset + 16, true),
    powerApparent: view.getFloat32(offset + 20, true),
    powerFactor: view.getFloat32(offset + 24, true),
    frequency: view.getFloat32(offset + 28, true),
    phaseAngle: view.getFloat32(offset + 32, true),
    voltageAvg: view.getFloat32(offset + 36, true),
    currentAvg: view.getFloat32(offset + 40, true),
  };
}

function parseState(view, offset) {
  let cursor = offset;
  const state = view.getUint32(cursor, true); cursor += 4;
  const selectedRecipe = view.getUint8(cursor); cursor += 1;
  const currentTime = view.getInt32(cursor, true); cursor += 4;
  const detectedFilter = view.getInt8(cursor); cursor += 1;
  const rawWeight = view.getBigInt64(cursor, true); cursor += 8;
  const weight = view.getInt32(cursor, true); cursor += 4;
  const deviation = view.getBigInt64(cursor, true); cursor += 8;
  const deviationRaw = view.getBigInt64(cursor, true); cursor += 8;
  const grindTime = view.getUint32(cursor, true); cursor += 4;
  const grindTargetTime = view.getUint32(cursor, true); cursor += 4;
  const grindTargetWeight = view.getUint32(cursor, true); cursor += 4;
  const grindStartCalibratedWeight = view.getUint32(cursor, true); cursor += 4;
  const grindInterpolatedWeight = view.getUint32(cursor, true); cursor += 4;
  const currentRecipe = view.getUint8(cursor); cursor += 1;
  const detectFilterRequest = view.getUint8(cursor); cursor += 1;
  const learnSuccess = view.getUint8(cursor); cursor += 1;
  const grindInProgress = view.getUint8(cursor); cursor += 1;
  const dddpos = view.getInt32(cursor, true); cursor += 4;
  const rpm = view.getInt16(cursor, true); cursor += 2;
  const temperature = view.getInt16(cursor, true); cursor += 2;
  const fanSpeed = view.getInt16(cursor, true); cursor += 2;
  const fanTarget = view.getInt16(cursor, true); cursor += 2;
  const ddCurrent = view.getUint16(cursor, true); cursor += 2;
  const overCorrection = view.getInt32(cursor, true); cursor += 4;
  const overshootUpdated = view.getUint8(cursor); cursor += 1;
  // No nested BLDC struct here; see README.md "Protocol notes" for why.
  const power = parsePower(view, cursor); cursor += POWER_SIZE;

  return {
    state, selectedRecipe, currentTime, detectedFilter,
    rawWeight, weight, deviation, deviationRaw,
    grindTime, grindTargetTime, grindTargetWeight,
    grindStartCalibratedWeight, grindInterpolatedWeight,
    currentRecipe, detectFilterRequest, learnSuccess, grindInProgress,
    dddpos, rpm, temperature, fanSpeed, fanTarget, ddCurrent,
    overCorrection, overshootUpdated, power,
  };
}

function parseRecipe(view, offset) {
  const leadByte = view.getUint8(offset);
  const active = leadByte & 0x1;
  const manual = (leadByte >> 1) & 0x1;
  const weightMode = (leadByte >> 2) & 0x1;
  const value = (leadByte >> 3) & 0x1f;

  let cursor = offset + 1;
  const icon = view.getUint8(cursor); cursor += 1;
  const target = view.getUint32(cursor, true); cursor += 4;
  const discDistance = view.getUint32(cursor, true); cursor += 4;
  const weightOffset = view.getInt32(cursor, true); cursor += 4;
  const rpm = view.getInt16(cursor, true); cursor += 2;
  const waterAmountMl = view.getUint32(cursor, true); cursor += 4;
  const extractionTimeMs = view.getUint32(cursor, true); cursor += 4;
  const colorCode = view.getUint32(cursor, true); cursor += 4;
  const grindWeightTolerance = view.getInt32(cursor, true); cursor += 4;
  const grindWeightTolerance2 = view.getInt32(cursor, true); cursor += 4;
  const waterAmountTolerance = view.getInt32(cursor, true); cursor += 4;
  const waterAmountTolerance2 = view.getInt32(cursor, true); cursor += 4;
  const extractionTimeTolerance = view.getInt32(cursor, true); cursor += 4;
  const extractionTimeTolerance2 = view.getInt32(cursor, true); cursor += 4;
  const recipeUid = view.getUint32(cursor, true); cursor += 4;
  const managedRecipe = view.getUint8(cursor); cursor += 1;
  const waterRetentionFactor = view.getFloat32(cursor, true); cursor += 4;
  const coffeeTypeButton = view.getUint8(cursor);

  return {
    active, manual, weightMode, value, icon, target, discDistance, weightOffset,
    rpm, waterAmountMl, extractionTimeMs, colorCode,
    grindWeightTolerance, grindWeightTolerance2,
    waterAmountTolerance, waterAmountTolerance2,
    extractionTimeTolerance, extractionTimeTolerance2,
    recipeUid, managedRecipe, waterRetentionFactor, coffeeTypeButton,
  };
}

function encodeRecipe(r) {
  const buf = new ArrayBuffer(RECIPE_SIZE);
  const view = new DataView(buf);
  let bits = 0;
  bits |= (r.active & 0x1) << 0;
  bits |= (r.manual & 0x1) << 1;
  bits |= (r.weightMode & 0x1) << 2;
  bits |= (r.value & 0x1f) << 3;
  view.setUint8(0, bits);

  let cursor = 1;
  view.setUint8(cursor, r.icon & 0xff); cursor += 1;
  view.setUint32(cursor, r.target, true); cursor += 4;
  view.setUint32(cursor, r.discDistance, true); cursor += 4;
  view.setInt32(cursor, r.weightOffset, true); cursor += 4;
  view.setInt16(cursor, r.rpm, true); cursor += 2;
  view.setUint32(cursor, r.waterAmountMl, true); cursor += 4;
  view.setUint32(cursor, r.extractionTimeMs, true); cursor += 4;
  view.setUint32(cursor, r.colorCode, true); cursor += 4;
  view.setInt32(cursor, r.grindWeightTolerance, true); cursor += 4;
  view.setInt32(cursor, r.grindWeightTolerance2, true); cursor += 4;
  view.setInt32(cursor, r.waterAmountTolerance, true); cursor += 4;
  view.setInt32(cursor, r.waterAmountTolerance2, true); cursor += 4;
  view.setInt32(cursor, r.extractionTimeTolerance, true); cursor += 4;
  view.setInt32(cursor, r.extractionTimeTolerance2, true); cursor += 4;
  view.setUint32(cursor, r.recipeUid, true); cursor += 4;
  view.setUint8(cursor, r.managedRecipe & 0xff); cursor += 1;
  view.setFloat32(cursor, r.waterRetentionFactor, true); cursor += 4;
  view.setUint8(cursor, r.coffeeTypeButton & 0xff);

  return new Uint8Array(buf);
}

function decodePacket(bytes) {
  if (bytes.length < HEADER_SIZE + STATE_SIZE) {
    throw new Error("Frame shorter than header + state");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const header = parseHeader(view, offset);
  offset += HEADER_SIZE;

  const state = parseState(view, offset);
  offset += STATE_SIZE;

  let recipes;
  if (header.numRecipes > 0) {
    const needed = header.numRecipes * RECIPE_SIZE;
    if (bytes.length - offset < needed) {
      throw new Error("Recipe payload truncated");
    }
    recipes = [];
    for (let i = 0; i < header.numRecipes; i++) {
      recipes.push(parseRecipe(view, offset + i * RECIPE_SIZE));
    }
  }

  return { header, state, recipes };
}

function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buildHeaderFrame(opts) {
  const buf = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(buf);
  view.setUint32(0, opts.flags >>> 0, true);
  view.setUint32(4, 0, true);
  view.setUint8(8, (opts.numRecipes || 0) & 0xff);
  view.setUint8(9, (opts.numFilters || 0) & 0xff);
  view.setUint8(10, (opts.numAdcValues || 0) & 0xff);
  view.setUint8(11, (opts.numServoLog || 0) & 0xff);
  view.setUint8(12, (opts.numLog || 0) & 0xff);
  return new Uint8Array(buf);
}

function requestRecipesFrame() {
  const buf = new ArrayBuffer(HEADER_SIZE);
  new DataView(buf).setUint32(0, MessageFlags.legacyRecipeFetch >>> 0, true);
  return new Uint8Array(buf);
}

function selectRecipeFrame(recipeIndex) {
  const buf = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(buf);
  view.setUint32(0, MessageFlags.selectRecipe >>> 0, true);
  view.setUint32(4, 0, true);
  view.setUint8(8, recipeIndex & 0xff);
  return new Uint8Array(buf);
}

function patchRecipeFrames(recipe, recipeIndex) {
  const header = buildHeaderFrame({ flags: MessageFlags.recipes, numRecipes: recipeIndex });
  const body = encodeRecipe(recipe);
  const patch = concatBytes([header, body]);
  const select = selectRecipeFrame(recipeIndex);
  return [select, patch, select];
}

// ---------------------------------------------------------------------------
// Device settings page (served by the `device-settings` endpoint with ui=1).
// Decaid's device management opens it in the in-app browser with
// ?ui=1&deviceId=<id>[&deviceName=<name>]. It runs on Decaid's API origin, so
// it calls the plugin's own endpoints with relative URLs. URL parameters are
// read client-side and only ever rendered through textContent.
// ---------------------------------------------------------------------------

const DEVICE_SETTINGS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bentwood Grinder Settings</title>
<style>
  :root {
    --bg: #f6f5f3; --card: #ffffff; --text: #1d1b19; --muted: #6b6560;
    --border: #e2ddd8; --accent: #8a5a2b; --accent-text: #ffffff;
    --ok: #2f7d4f; --warn: #a05a00; --err: #b3261e; --sel: #f3ebe2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161412; --card: #201d1b; --text: #eeeae6; --muted: #a39b94;
      --border: #3a3532; --accent: #d39a62; --accent-text: #1d1b19;
      --ok: #6cc28f; --warn: #e0a050; --err: #f2867e; --sel: #2c2621;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 640px; margin: 0 auto; padding: 16px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 16px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .sub { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .pill { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); white-space: nowrap; }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.off { color: var(--muted); }
  section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  input {
    width: 100%; min-width: 0; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 10px; }
  .field { margin-bottom: 12px; min-width: 0; }
  .inline { display: flex; gap: 8px; align-items: flex-end; }
  .inline .field { flex: 1; margin-bottom: 0; }
  header > div { min-width: 0; }
  button {
    font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 9px 14px;
    background: var(--accent); color: var(--accent-text); cursor: pointer;
  }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--border); }
  button:disabled { opacity: .5; cursor: default; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); }
  th { font-size: 12px; color: var(--muted); font-weight: 600; }
  tr.selected td { background: var(--sel); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; margin: 0; }
  dt { font-size: 12px; color: var(--muted); }
  dd { margin: 0; font-size: 18px; font-variant-numeric: tabular-nums; }
  .edit { margin-top: 14px; display: grid; gap: 12px; }
  #status { min-height: 20px; font-size: 13px; margin: 4px 0 12px; }
  #status.ok { color: var(--ok); } #status.err { color: var(--err); } #status.warn { color: var(--warn); }
  .empty { color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1 id="title">Bentwood Grinder</h1>
      <div class="sub" id="deviceId"></div>
    </div>
    <span class="pill off" id="conn">Not connected</span>
  </header>
  <div id="status" role="status" aria-live="polite"></div>

  <section>
    <h2>Connection</h2>
    <form id="connForm" novalidate>
      <div class="row">
        <div class="field">
          <label for="ip">Grinder IP address or hostname</label>
          <input id="ip" name="ip" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="192.168.1.123">
        </div>
        <div class="field">
          <label for="port">Port</label>
          <input id="port" name="port" inputmode="numeric" placeholder="81">
        </div>
      </div>
      <button type="submit">Save connection</button>
      <div class="hint">Saved for this grinder only. If the grinder is connected and the address changes, it disconnects; reconnect it from device management.</div>
    </form>
  </section>

  <section>
    <h2>Recipes</h2>
    <div id="recipes" class="empty">Connect the grinder to load its recipes.</div>
    <div class="edit" id="edit" hidden>
      <div class="inline">
        <div class="field">
          <label for="gap">Burr gap (µm)</label>
          <input id="gap" type="number" inputmode="numeric">
        </div>
        <button type="button" id="saveGap">Set</button>
      </div>
      <div class="inline">
        <div class="field">
          <label for="target">Target weight (g)</label>
          <input id="target" inputmode="decimal">
        </div>
        <button type="button" id="saveTarget">Set</button>
      </div>
      <div class="hint" id="limits"></div>
    </div>
  </section>

  <section>
    <h2>Live</h2>
    <dl>
      <div><dt>State</dt><dd id="lState">–</dd></div>
      <div><dt>Motor speed</dt><dd id="lRpm">–</dd></div>
      <div><dt>Temperature</dt><dd id="lTemp">–</dd></div>
      <div><dt>Motor power</dt><dd id="lPower">–</dd></div>
    </dl>
  </section>
</main>
<script>
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var deviceId = params.get("deviceId") || "";
  var deviceName = params.get("deviceName");
  var limits = null;
  var lastRecipesKey = null;
  var editing = false;

  function $(id) { return document.getElementById(id); }
  if (deviceName) $("title").textContent = deviceName;
  $("deviceId").textContent = deviceId;

  function setStatus(text, kind) {
    var el = $("status");
    el.textContent = text || "";
    el.className = kind || "";
  }

  function call(path, options) {
    return fetch(path, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
        return data;
      });
    });
  }

  function settingsUrl() { return "device-settings?deviceId=" + encodeURIComponent(deviceId); }

  function loadSettings() {
    return call(settingsUrl()).then(function (s) {
      limits = s.limits;
      $("ip").value = s.connection.ip || "";
      $("port").value = String(s.connection.port);
      var g = limits.burrGapUm, t = limits.targetWeightG;
      $("gap").min = g.min; $("gap").max = g.max; $("gap").step = g.step;
      $("limits").textContent = "Burr gap " + g.min + "–" + g.max + " µm in " + g.step + " µm steps. " +
        "Target weight " + t.min + "–" + t.max + " g in " + t.step + " g steps. Applies to the selected recipe.";
      if (!s.connection.ip) setStatus("Set the grinder's IP address, then connect it from device management.", "warn");
    });
  }

  function renderRecipes(recipes, selected) {
    var box = $("recipes");
    if (!recipes || !recipes.length) {
      box.className = "empty";
      box.textContent = "Connect the grinder to load its recipes.";
      $("edit").hidden = true;
      return;
    }
    var key = JSON.stringify([recipes, selected]);
    if (key === lastRecipesKey) return;
    lastRecipesKey = key;
    box.className = "";
    box.textContent = "";
    var table = document.createElement("table");
    var head = table.createTHead().insertRow();
    ["Recipe", "Burr gap", "Target", ""].forEach(function (h, i) {
      var th = document.createElement("th");
      th.textContent = h;
      if (i === 1 || i === 2) th.className = "num";
      head.appendChild(th);
    });
    var body = table.createTBody();
    recipes.forEach(function (r, i) {
      var tr = body.insertRow();
      if (i === selected) tr.className = "selected";
      tr.insertCell().textContent = "Recipe " + (i + 1);
      var gap = tr.insertCell(); gap.className = "num"; gap.textContent = r.discDistance + " µm";
      var tgt = tr.insertCell(); tgt.className = "num"; tgt.textContent = (r.target / 1000).toFixed(1) + " g";
      var act = tr.insertCell();
      if (i === selected) {
        act.textContent = "Selected";
        act.className = "sub";
      } else {
        var b = document.createElement("button");
        b.type = "button"; b.className = "secondary"; b.textContent = "Select";
        b.onclick = function () { selectRecipe(i); };
        act.appendChild(b);
      }
    });
    box.appendChild(table);
    var current = recipes[selected];
    $("edit").hidden = !current;
    if (current && !editing) {
      $("gap").value = String(current.discDistance);
      $("target").value = (current.target / 1000).toFixed(1);
    }
  }

  function fmt(value, digits, unit) {
    return typeof value === "number" && isFinite(value) ? value.toFixed(digits) + " " + unit : "–";
  }

  function refresh() {
    return call("sensors").then(function (s) {
      var pill = $("conn");
      pill.textContent = s.connected ? "Connected" : "Not connected";
      pill.className = "pill " + (s.connected ? "ok" : "off");
      var st = s.state;
      $("lState").textContent = st ? (st.grindInProgress ? "Grinding" : "Idle") : "–";
      $("lRpm").textContent = st ? fmt(st.rpm, 0, "rpm") : "–";
      $("lTemp").textContent = st ? fmt(st.temperature / 10, 1, "°C") : "–";
      $("lPower").textContent = st && st.power ? fmt(st.power.powerActive, 0, "W") : "–";
      renderRecipes(s.recipes, st ? st.selectedRecipe : -1);
    }).catch(function () { /* keep last view; next poll retries */ });
  }

  function afterWrite(message) {
    setStatus(message, "ok");
    editing = false;
    lastRecipesKey = null;
    setTimeout(refresh, 400);
    setTimeout(refresh, 1500);
  }

  function post(path) { return call(path, { method: "POST" }); }

  function selectRecipe(i) {
    post("select-recipe?recipeIndex=" + i)
      .then(function () { afterWrite("Recipe " + (i + 1) + " selected."); })
      .catch(function (e) { setStatus(e.message, "err"); });
  }

  // Grams with at most one decimal, converted to mg without floating point.
  function gramsToMg(text) {
    var m = /^(\\d{1,3})(?:\\.(\\d))?$/.exec(text.trim());
    if (!m) return null;
    return Number(m[1]) * 1000 + (m[2] ? Number(m[2]) * 100 : 0);
  }

  $("gap").addEventListener("input", function () { editing = true; });
  $("target").addEventListener("input", function () { editing = true; });

  $("saveGap").onclick = function () {
    var v = $("gap").value.trim();
    post("set-burr-gap?discDistance=" + encodeURIComponent(v))
      .then(function () { afterWrite("Burr gap set to " + v + " µm."); })
      .catch(function (e) { setStatus(e.message, "err"); });
  };

  $("saveTarget").onclick = function () {
    var mg = gramsToMg($("target").value);
    if (mg === null) { setStatus("Enter the target weight in grams with at most one decimal, e.g. 18.5.", "err"); return; }
    post("set-target-weight?target=" + mg)
      .then(function () { afterWrite("Target weight set to " + (mg / 1000).toFixed(1) + " g."); })
      .catch(function (e) { setStatus(e.message, "err"); });
  };

  $("connForm").onsubmit = function (ev) {
    ev.preventDefault();
    var body = { ip: $("ip").value.trim(), port: $("port").value.trim() };
    call(settingsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      $("ip").value = r.connection.ip;
      $("port").value = String(r.connection.port);
      setStatus(r.disconnected
        ? "Saved. The grinder was disconnected; reconnect it from device management."
        : "Connection saved.", r.disconnected ? "warn" : "ok");
      refresh();
    }).catch(function (e) { setStatus(e.message, "err"); });
  };

  loadSettings()
    .then(refresh)
    .catch(function (e) { setStatus(e.message, "err"); });
  setInterval(function () { if (!document.hidden) refresh(); }, 1000);
})();
</script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function createPlugin(host) {
  const PLUGIN_ID = "com.bentwood.grinder";
  const DRIVER_ID = "bentwood";
  const INSTANCE_ID = "grinder";
  // The motor runs at a fixed speed; must match the manifest's
  // controls.rpmControl min/max.
  const FIXED_RPM = 1400;
  // Recipe field limits in raw wire units. BURR_GAP must match the manifest's
  // controls.grindSetting min/max/step.
  const BURR_GAP = { min: 10, max: 600, step: 5, unit: "µm" }; // discDistance
  const TARGET_WEIGHT = { min: 0, max: 200000, step: 100, unit: "mg" }; // target: 0–200 g in 0.1 g
  const DOSE_TILE = { min: 1, max: 30, step: 0.1, decimals: 1, unit: "g" };
  const DECAID_API_BASE = "http://localhost:8080/api/v1";
  const DEFAULT_PORT = 81;
  const STORAGE_TIMEOUT_MS = 3000;

  // Identity of the one registered device; replaced by the host-issued ID
  // once registration resolves.
  let deviceId = "plugin:" + PLUGIN_ID + ":" + DRIVER_ID + ":" + INSTANCE_ID;
  // Per-device connection settings, persisted in the plugin's KV store under
  // connectionKey(deviceId). Loaded once on load; every write goes through
  // saveConnection(), so the cache stays authoritative.
  let connection = { ip: "", port: DEFAULT_PORT };
  let connectionReady = Promise.resolve();
  // The live connection. Decaid owns the lifecycle: it calls the grinder's
  // connect()/disconnect() handlers, and each connect gets a fresh session
  // context. There is no plugin-side reconnect scheduler.
  let session = null;
  // state arrives on every frame; recipes only arrive when explicitly
  // requested (header.numRecipes > 0), so track them separately to avoid
  // losing the last-known recipe snapshot on the next plain state frame.
  let latestState = null;
  let latestRecipes = null;

  function log(msg) {
    try { host.log("[" + PLUGIN_ID + "] " + msg); } catch (e) { /* log permission missing */ }
  }

  // -------------------------------------------------------------------------
  // Streamline skin live updates. A message on the `skin-changed` websocket
  // endpoint makes the skin re-read `skin`; {"what":"skin"} tells it the
  // workflow didn't change. Sent only when what `skin` answers changes, and
  // at most once a second (a trailing message covers changes in between).
  // -------------------------------------------------------------------------

  const SKIN_EVENT = "skin-changed";
  const SKIN_MIN_INTERVAL_MS = 1000;
  let lastSkinKey = null;
  let lastSkinEmit = 0;
  let skinEmitTimer = null;

  function emitSkinChanged() {
    lastSkinEmit = Date.now();
    try { host.emit(SKIN_EVENT, { what: "skin" }); } catch (e) { /* emit permission missing */ }
  }

  function notifySkin() {
    const key = JSON.stringify(skinSurfaces());
    if (key === lastSkinKey) return;
    lastSkinKey = key;
    if (skinEmitTimer) return;
    const wait = lastSkinEmit + SKIN_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      emitSkinChanged();
    } else {
      skinEmitTimer = setTimeout(() => {
        skinEmitTimer = null;
        emitSkinChanged();
      }, wait);
    }
  }

  // Resolves when the next recipe list arrives (or after timeoutMs), so a
  // write can answer with the value the grinder actually stored.
  const recipeWaiters = [];

  function nextRecipes(timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = recipeWaiters.indexOf(waiter);
        if (i !== -1) recipeWaiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      recipeWaiters.push(waiter);
    });
  }

  function settleRecipeWaiters() {
    for (const waiter of recipeWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  // -------------------------------------------------------------------------
  // Dose -> grinder target weight. The workflow's dose (workflowUpdated,
  // context.targetDoseWeight in g) is written to the selected recipe's
  // target, rounded to the grinder's 0.1 g step. Dose changes are debounced
  // so holding -/+ on the Dose tile sends one write. A dose that can't be
  // written yet (not connected, recipes not loaded, grinding) is kept and
  // applied once recipes arrive or the grind ends.
  // -------------------------------------------------------------------------

  const DOSE_SYNC_DELAY_MS = 500;
  let doseTargetMg = null;
  let doseSyncTimer = null;
  let doseSyncInFlight = false;
  const doseSyncIdleWaiters = [];
  // The last write per recipe and value, so a value the grinder doesn't
  // store isn't rewritten on every recipe snapshot.
  let lastDoseWrite = null;

  function waitForDoseSyncIdle() {
    if (!doseSyncInFlight) return Promise.resolve();
    return new Promise((resolve) => doseSyncIdleWaiters.push(resolve));
  }

  async function acquireDoseSync() {
    while (doseSyncInFlight) await waitForDoseSyncIdle();
    doseSyncInFlight = true;
  }

  function releaseDoseSync() {
    doseSyncInFlight = false;
    for (const resolve of doseSyncIdleWaiters.splice(0)) resolve();
  }

  function doseToMg(grams) {
    const n = typeof grams === "number" ? grams : Number(grams);
    if (!isFinite(n)) return null;
    const mg = Math.round(n * 10) * 100;
    return mg > TARGET_WEIGHT.min && mg <= TARGET_WEIGHT.max ? mg : null;
  }

  function parseDoseTileValue(value) {
    if (typeof value !== "number" && typeof value !== "string") {
      throw new Error("targetWeight must be a number");
    }
    const n = typeof value === "number" ? value : Number(value);
    if (!isFinite(n)) throw new Error("targetWeight must be a finite number");
    const mg = Math.round(n * 10) * 100;
    if (Math.abs(n - mg / 1000) > 1e-9 || mg < DOSE_TILE.min * 1000 || mg > DOSE_TILE.max * 1000) {
      throw new Error(
        "targetWeight must be from " + DOSE_TILE.min + " to " + DOSE_TILE.max +
        " " + DOSE_TILE.unit + " in steps of " + DOSE_TILE.step
      );
    }
    return { mg, grams: mg / 1000 };
  }

  async function updateWorkflowDose(grams) {
    const response = await fetch(DECAID_API_BASE + "/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: { targetDoseWeight: grams } }),
    });
    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error("workflow dose update failed" + (response && response.status ? " (HTTP " + response.status + ")" : ""));
    }
  }

  function handleWorkflow(payload) {
    let workflow = payload;
    if (typeof workflow === "string") {
      try { workflow = JSON.parse(workflow); } catch (e) { return; }
    }
    const context = workflow && workflow.context;
    const mg = context ? doseToMg(context.targetDoseWeight) : null;
    if (mg == null || mg === doseTargetMg) return;
    doseTargetMg = mg;
    lastDoseWrite = null;
    if (doseSyncTimer) clearTimeout(doseSyncTimer);
    doseSyncTimer = setTimeout(() => {
      doseSyncTimer = null;
      syncDose();
    }, DOSE_SYNC_DELAY_MS);
  }

  // Called when the grinder may have become writable; a pending debounce
  // runs the sync itself.
  function maybeSyncDose() {
    if (!doseSyncTimer) syncDose();
  }

  async function syncDose() {
    if (doseTargetMg == null || doseSyncInFlight) return;
    if (!session || session.closed || !latestState || latestState.grindInProgress) return;
    const idx = latestState.selectedRecipe;
    const recipe = selectedRecipe();
    if (!recipe || recipe.target === doseTargetMg) return;
    if (lastDoseWrite && lastDoseWrite.idx === idx && lastDoseWrite.mg === doseTargetMg) return;
    const mg = doseTargetMg;
    lastDoseWrite = { idx, mg };
    doseSyncInFlight = true;
    try {
      const confirmed = nextRecipes(3000);
      await patchCurrentRecipeField("target", mg);
      await confirmed;
      const stored = selectedRecipe();
      log(stored && stored.target === mg
        ? "recipe " + (idx + 1) + " target weight set to dose " + (mg / 1000).toFixed(1) + " g"
        : "grinder did not store dose " + (mg / 1000).toFixed(1) + " g as recipe " + (idx + 1) + "'s target weight");
    } catch (err) {
      log("dose sync failed: " + err);
    } finally {
      releaseDoseSync();
    }
    // The dose may have changed while the write was in flight.
    maybeSyncDose();
  }

  // -------------------------------------------------------------------------
  // Plugin KV storage. host.storage() answers through onEvent: a storageRead
  // event carries the key, a storageWrite confirmation doesn't, so writes are
  // matched first-in, first-out.
  // -------------------------------------------------------------------------

  const pendingReads = new Map(); // key -> [{ resolve, reject, timer }]
  const pendingWrites = []; // [{ resolve, reject, timer }]

  function storageRequest(queue, command, what) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = queue.indexOf(entry);
        if (i !== -1) queue.splice(i, 1);
        reject(new Error("storage " + what + " timed out"));
      }, STORAGE_TIMEOUT_MS);
      queue.push(entry);
      try {
        host.storage(Object.assign({ namespace: PLUGIN_ID }, command));
      } catch (err) {
        clearTimeout(entry.timer);
        queue.splice(queue.indexOf(entry), 1);
        reject(err);
      }
    });
  }

  function storageRead(key) {
    if (!pendingReads.has(key)) pendingReads.set(key, []);
    return storageRequest(pendingReads.get(key), { type: "read", key }, "read");
  }

  function storageWrite(key, data) {
    return storageRequest(pendingWrites, { type: "write", key, data }, "write");
  }

  function settleStorage(queue, value) {
    const entry = queue && queue.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve(value);
  }

  // -------------------------------------------------------------------------
  // Per-device connection settings
  // -------------------------------------------------------------------------

  function connectionKey(id) {
    return "connection:" + id;
  }

  // The plugin settings' address as of the last time it was applied.
  const PLUGIN_SETTINGS_KEY = "pluginSettings";

  const HOST_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

  // Throws on invalid input; values are used verbatim, never trimmed or
  // coerced into something else.
  function validateConnection(raw) {
    if (!raw || typeof raw !== "object") throw new Error("connection settings required");
    const ip = raw.ip;
    if (typeof ip !== "string" || !HOST_PATTERN.test(ip)) {
      throw new Error("ip must be an IPv4 address or hostname");
    }
    const portText = raw.port == null || raw.port === "" ? String(DEFAULT_PORT) : String(raw.port);
    const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
    if (!(port >= 1 && port <= 65535)) throw new Error("port must be an integer from 1 to 65535");
    return { ip, port };
  }

  // Stored values may come back as an object or a JSON string; anything
  // unreadable falls back to "not configured".
  function parseStoredConnection(value) {
    if (value == null) return null;
    let raw = value;
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch (e) { return null; }
    }
    try { return validateConnection(raw); } catch (e) { return null; }
  }

  // The plugin-wide GrinderIp/GrinderPort settings: a fallback for Decaid
  // builds without the device settings action. null when unset or invalid.
  function pluginSettingsConnection(settings) {
    const s = settings || {};
    if (!s.GrinderIp) return null;
    try {
      return validateConnection({ ip: s.GrinderIp, port: s.GrinderPort });
    } catch (err) {
      log("ignoring GrinderIp/GrinderPort plugin settings: " + err.message);
      return null;
    }
  }

  function sameConnection(a, b) {
    return !!a && !!b && a.ip === b.ip && a.port === b.port;
  }

  // The plugin settings apply when they're new or changed since the last
  // load (Decaid reloads the plugin when they're saved). Otherwise the
  // device's own settings stay, so an address saved later on the device
  // settings page isn't overwritten on every load.
  async function loadConnection(loadedSettings) {
    const fromSettings = pluginSettingsConnection(loadedSettings);
    let stored = null;
    let seen = null;
    try {
      stored = parseStoredConnection(await storageRead(connectionKey(deviceId)));
      seen = parseStoredConnection(await storageRead(PLUGIN_SETTINGS_KEY));
    } catch (err) {
      log("loading connection settings failed: " + err);
      if (fromSettings) connection = fromSettings;
      return;
    }
    if (fromSettings && (!stored || !sameConnection(fromSettings, seen))) {
      try {
        await saveConnection(fromSettings);
        await storageWrite(PLUGIN_SETTINGS_KEY, fromSettings);
        log("using grinder address from plugin settings");
      } catch (err) {
        log("saving grinder address from plugin settings failed: " + err);
        connection = fromSettings;
      }
      return;
    }
    if (stored) connection = stored;
  }

  // Validates, persists and caches. If the address changed while connected,
  // the session is dropped so telemetry never keeps flowing from the old
  // address under the new settings; Decaid reconnects it on request.
  async function saveConnection(raw) {
    const next = validateConnection(raw);
    await storageWrite(connectionKey(deviceId), next);
    const changed = next.ip !== connection.ip || next.port !== connection.port;
    connection = next;
    notifySkin();
    let disconnected = false;
    if (changed && session && !session.closed) {
      dropSession(session, "connection settings changed");
      disconnected = true;
    }
    return { connection: Object.assign({}, connection), disconnected };
  }

  function dropSession(conn, reason) {
    if (conn.closed) return;
    log("dropping connection: " + reason);
    conn.closed = true;
    if (session === conn) session = null;
    conn.transport.close(conn.handle).catch(() => {});
    Promise.resolve().then(() => conn.context.reportDisconnected()).catch(() => {});
    notifySkin();
  }

  // -------------------------------------------------------------------------
  // Grinder state
  // -------------------------------------------------------------------------

  function selectedRecipe() {
    const idx = latestState ? latestState.selectedRecipe : null;
    return latestRecipes && idx != null ? latestRecipes[idx] || null : null;
  }

  // Maps the grinder's raw state onto Decaid's GrinderSnapshot (`state`,
  // `setting`, `rpm`); everything else stays available through the plugin's
  // own HTTP endpoints. `setting` is the selected recipe's configured burr
  // gap, so a setGrindSetting call is reflected once recipes are re-fetched.
  // `rpm` is always the grinder's fixed motor speed.
  function grinderSnapshot() {
    const snapshot = {
      state: latestState ? (latestState.grindInProgress ? "grinding" : "idle") : "unknown",
      rpm: FIXED_RPM,
    };
    const recipe = selectedRecipe();
    if (recipe) {
      snapshot.setting = String(recipe.discDistance);
    }
    return snapshot;
  }

  function snapshotKey(s) {
    return s.state + "|" + (s.setting == null ? "" : s.setting) + "|" + s.rpm;
  }

  // Publishes through the session's own context, and only on change: state
  // frames stream continuously while the snapshot rarely changes.
  function publishSnapshot(conn) {
    if (conn.closed) return;
    const snapshot = grinderSnapshot();
    const key = snapshotKey(snapshot);
    if (key === conn.lastPublished) return;
    conn.lastPublished = key;
    conn.context.publish(snapshot).catch((err) => log("publish failed: " + err));
  }

  // State frames stream continuously, so a protocol mismatch (e.g. after a
  // firmware update) would fail on every frame. Only the first failure of a
  // streak is logged, plus a count once frames decode again.
  function handleFrame(conn, event) {
    if (event.dataType !== "binary") {
      log("unexpected text frame: " + String(event.data).slice(0, 200));
      return;
    }
    let packet;
    try {
      packet = decodePacket(base64ToBytes(event.data));
    } catch (err) {
      if (conn.decodeFailures++ === 0) {
        log("failed to decode frame (further failures suppressed until a frame decodes): " + err);
      }
      return;
    }
    if (conn.decodeFailures > 0) {
      log("frames decoding again after " + conn.decodeFailures + " failed frame(s)");
      conn.decodeFailures = 0;
    }
    const wasGrinding = !!(latestState && latestState.grindInProgress);
    latestState = packet.state;
    if (packet.recipes) {
      latestRecipes = packet.recipes;
      settleRecipeWaiters();
    }
    publishSnapshot(conn);
    notifySkin();
    if (packet.recipes || (wasGrinding && !latestState.grindInProgress)) {
      maybeSyncDose();
    }
  }

  async function sendFrames(frames) {
    const conn = session;
    if (!conn || conn.closed) throw new Error("grinder not connected");
    for (const frame of frames) {
      await conn.transport.send(conn.handle, { type: "binary", data: bytesToBase64(frame) });
    }
  }

  // Full raw snapshot of every field the grinder's state frame carries.
  // JSON.stringify can't serialize BigInt (rawWeight/deviation/deviationRaw
  // use 64-bit reads), so those are stringified explicitly rather than
  // silently throwing inside the HTTP handler.
  function serializeState(s) {
    if (!s) return null;
    return {
      ...s,
      rawWeight: s.rawWeight.toString(),
      deviation: s.deviation.toString(),
      deviationRaw: s.deviationRaw.toString(),
      power: { ...s.power },
    };
  }

  function sensorSnapshot() {
    return {
      connected: !!(session && !session.closed),
      state: serializeState(latestState),
      recipes: latestRecipes,
      lastUpdated: latestState ? Date.now() : null,
    };
  }

  function currentBladeGap() {
    const recipe = selectedRecipe();
    return {
      liveRaw: latestState ? latestState.dddpos : null,
      selectedRecipeIndex: latestState ? latestState.selectedRecipe : null,
      selectedRecipeDiscDistance: recipe ? recipe.discDistance : null,
      note: "selectedRecipeDiscDistance is in µm; liveRaw's scale is unconfirmed",
    };
  }

  function currentTargetWeight() {
    const recipe = selectedRecipe();
    return {
      liveRaw: latestState ? latestState.weight : null,
      selectedRecipeIndex: latestState ? latestState.selectedRecipe : null,
      selectedRecipeTarget: recipe ? recipe.target : null,
      note: "selectedRecipeTarget is in mg (÷1000 = grams); liveRaw's scale vs. target not yet confirmed mid-grind",
    };
  }

  // Surfaces for the Streamline skin's Grind and Dose tiles (streamline-js
  // docs/plugin-surfaces.md). The skin renders them itself and calls back
  // `skin-burr-gap` / `skin-target-weight`; no plugin code runs in the skin.
  //   - tile-mode "µm": the tile's -/+, numpad and value set the selected
  //     recipe's burr gap on the grinder.
  //   - tile-hint: the current burr gap; tapping it copies it into the
  //     workflow's grinder setting. Shows "Grinding" while grinding.
  //   - tile-line: connection status while there's nothing to control (a
  //     tile-mode takes the line's place when connected).
  function skinSurfaces() {
    const connected = !!(session && !session.closed);
    const recipe = connected ? selectedRecipe() : null;
    if (!recipe) {
      const text = connected ? "Bentwood connecting" : connection.ip ? "Bentwood offline" : "Bentwood: set IP";
      return [{ id: "status", kind: "tile-line", tile: "grind", text }];
    }
    const gap = recipe.discDistance;
    const surfaces = [];
    // The skin clamps a mode's value into min..max; a gap outside the range
    // would be shown wrong, so the mode is left out and only the hint shows it.
    if (gap >= BURR_GAP.min && gap <= BURR_GAP.max) {
      surfaces.push({
        id: "burrgap", kind: "tile-mode", tile: "grind",
        label: "µm", unit: "µm", value: gap,
        min: BURR_GAP.min, max: BURR_GAP.max, step: BURR_GAP.step, decimals: 0,
        action: { type: "call", endpoint: "skin-burr-gap", field: "burrGap" },
      });
    }
    if (latestState && latestState.grindInProgress) {
      surfaces.push({ id: "gap", kind: "tile-hint", tile: "grind", text: "Grinding", active: true });
    } else {
      surfaces.push({
        id: "gap", kind: "tile-hint", tile: "grind", text: "BW " + gap + " µm",
        title: "Use the Bentwood burr gap as this shot's grinder setting",
        action: { type: "set", field: "grinderSetting", value: gap },
      });
      // The skin only accepts a dose of 1–30 g.
      const dose = Math.round(recipe.target / 100) / 10;
      if (dose >= DOSE_TILE.min && dose <= DOSE_TILE.max) {
        surfaces.push({
          id: "dose", kind: "tile-hint", tile: "dose", text: "BW " + dose.toFixed(1) + " g",
          title: "Use the Bentwood target weight as this shot's dose",
          action: { type: "set", field: "targetDoseWeight", value: dose },
        });
        if (recipe.target % TARGET_WEIGHT.step === 0) {
          surfaces.push({
            id: "dose-target", kind: "tile-mode", tile: "dose",
            label: "BW", unit: "g", value: dose,
            min: DOSE_TILE.min, max: DOSE_TILE.max, step: DOSE_TILE.step,
            decimals: DOSE_TILE.decimals,
            action: { type: "call", endpoint: "skin-target-weight", field: "targetWeight" },
          });
        }
      }
    }
    return surfaces;
  }

  function skinAnswer() {
    return { version: 1, surfaces: skinSurfaces(), live: { endpoint: SKIN_EVENT } };
  }

  function deviceSettingsView() {
    return {
      deviceId,
      connection: Object.assign({}, connection),
      connected: !!(session && !session.closed),
      fixedRpm: FIXED_RPM,
      limits: {
        burrGapUm: { min: BURR_GAP.min, max: BURR_GAP.max, step: BURR_GAP.step },
        targetWeightG: { min: TARGET_WEIGHT.min / 1000, max: TARGET_WEIGHT.max / 1000, step: TARGET_WEIGHT.step / 1000 },
      },
    };
  }

  // Patches a single field of the currently-selected recipe, leaving every
  // other field untouched, then re-requests recipes so the plugin's own
  // snapshot (latestRecipes) reflects the write. Requires a recipe snapshot
  // to already be loaded (recipes are requested on connect) since the
  // device protocol only supports patching a full 89-byte recipe struct,
  // not individual fields.
  async function patchCurrentRecipeField(fieldName, value) {
    const idx = latestState ? latestState.selectedRecipe : null;
    if (idx == null) {
      throw new Error("selected recipe unknown; no state received yet");
    }
    const base = latestRecipes && latestRecipes[idx];
    if (!base) {
      throw new Error("recipe snapshot not loaded yet; request recipes first");
    }
    const updated = Object.assign({}, base, { [fieldName]: value });
    await sendFrames(patchRecipeFrames(updated, idx));
    await sendFrames([requestRecipesFrame()]);
    return { recipeIndex: idx, [fieldName]: value };
  }

  // Values are taken verbatim or rejected, never rounded, clamped or snapped
  // to the step. Decaid only checks min/max for grindSetting, so the step and
  // integer checks live here.
  function parseRecipeValue(value, name, limits) {
    const s = String(value);
    const n = /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isSafeInteger(n) || n < limits.min || n > limits.max || (n - limits.min) % limits.step !== 0) {
      throw new Error(
        name + " must be an integer from " + limits.min + " to " + limits.max +
        " " + limits.unit + " in steps of " + limits.step
      );
    }
    return n;
  }

  function parseRecipeIndex(value) {
    const s = String(value);
    const n = /^\d+$/.test(s) ? Number(s) : NaN;
    const count = latestRecipes ? latestRecipes.length : 256;
    if (!Number.isInteger(n) || n >= count) {
      throw new Error("recipeIndex must be an integer from 0 to " + (count - 1));
    }
    return n;
  }

  // Decaid GrinderDevice handlers. Declared capabilities (manifest):
  // grindSetting -> setGrindSetting, rpmControl -> setRpm. rpmControl is
  // pinned to 1400–1400 so the fixed speed is visible in snapshots; the host
  // rejects any other value before setRpm runs. startStop is not declared:
  // no start/stop command is known in the grinder's protocol.
  const grinderHandlers = {
    async connect(context) {
      await connectionReady;
      const { ip, port } = connection;
      if (!ip) throw new Error("no grinder IP configured; set it in the plugin settings or the device settings");
      const url = "ws://" + ip + ":" + port + "/ws";

      // Invocation-bound transport: the host closes it when this session
      // retires, so an old handle can never send into a replacement session.
      const opened = await context.transport.open({ kind: "websocket", url });
      const conn = {
        context,
        transport: context.transport,
        handle: opened.handle,
        closed: false,
        lastPublished: null,
        decodeFailures: 0,
      };
      session = conn;
      lastDoseWrite = null;
      log("connected to " + url);
      notifySkin();

      context.transport.onEvent(conn.handle, (event) => {
        if (event.type === "data") {
          handleFrame(conn, event);
        } else if (event.type === "error") {
          log("transport error: " + event.message);
        } else if (event.type === "close") {
          log("transport closed: " + event.reason);
          if (conn.closed) return;
          conn.closed = true;
          if (session === conn) session = null;
          Promise.resolve().then(() => context.reportDisconnected()).catch(() => {});
          notifySkin();
        }
      });

      await sendFrames([requestRecipesFrame()]);
      // Readiness needs a valid initial snapshot; state frames refine it.
      publishSnapshot(conn);
    },

    async disconnect() {
      const conn = session;
      session = null;
      if (!conn || conn.closed) return;
      conn.closed = true;
      notifySkin();
      await conn.transport.close(conn.handle).catch(() => {});
    },

    async setGrindSetting(setting) {
      await patchCurrentRecipeField("discDistance", parseRecipeValue(setting, "setting", BURR_GAP));
    },

    // Nothing is sent to the grinder: its speed isn't settable. Anything but
    // the fixed speed is an error rather than a silent no-op.
    async setRpm(rpm) {
      if (rpm !== FIXED_RPM) {
        throw new Error("rpm is fixed at " + FIXED_RPM);
      }
    },
  };

  function json(status, body) {
    return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  // Validation failures are the caller's fault (400); anything thrown while
  // talking to the grinder means it's not in a state to accept the write (409).
  async function write(validate, perform) {
    let value;
    try {
      value = validate();
    } catch (err) {
      return json(400, { error: err.message });
    }
    try {
      return json(200, await perform(value));
    } catch (err) {
      return json(409, { error: err.message });
    }
  }

  async function handleDeviceSettings(request) {
    const isWrite = request.method === "POST" || request.method === "PUT";
    if (request.query.ui === "1" && !isWrite) {
      return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: DEVICE_SETTINGS_PAGE };
    }
    if (request.query.deviceId !== deviceId) {
      return json(404, { error: "unknown device" });
    }
    await connectionReady;
    if (isWrite) {
      const raw = request.body && typeof request.body === "object" ? request.body : request.query;
      return write(() => validateConnection(raw), saveConnection);
    }
    return json(200, deviceSettingsView());
  }

  return {
    id: PLUGIN_ID,
    version: "0.6.0",

    async onLoad(loadedSettings) {
      log("loading");
      try {
        const registration = await host.devices.register(
          { driverId: DRIVER_ID, instanceId: INSTANCE_ID, name: "Bentwood Grinder" },
          grinderHandlers
        );
        if (registration && registration.deviceId) deviceId = registration.deviceId;
      } catch (err) {
        log("device registration failed: " + err);
      }
      // Not awaited: storage answers through onEvent, and connect() /
      // device-settings wait on it themselves.
      connectionReady = loadConnection(loadedSettings);
    },

    onUnload() {
      // Decaid runs the grinder's disconnect() handler and closes its
      // transports on unload.
    },

    onEvent(event) {
      if (!event) return;
      if (event.name === "storageRead") {
        const payload = event.payload || {};
        settleStorage(pendingReads.get(payload.key), payload.value);
      } else if (event.name === "storageWrite") {
        settleStorage(pendingWrites);
      } else if (event.name === "workflowUpdated") {
        handleWorkflow(event.payload);
      }
    },

    async handleHttpRequest(request) {
      const query = request.query || {};
      switch (request.endpoint) {
        case "device-settings":
          return handleDeviceSettings(Object.assign({}, request, { query }));
        case "recipes":
          return json(200, latestRecipes || []);
        case "sensors":
          return json(200, sensorSnapshot());
        case "burrgap":
          return json(200, currentBladeGap());
        case "targetweight":
          return json(200, currentTargetWeight());
        case "request-recipes":
          return write(() => null, async () => {
            await sendFrames([requestRecipesFrame()]);
            return {};
          });
        case "select-recipe":
          return write(() => parseRecipeIndex(query.recipeIndex), async (idx) => {
            await sendFrames([selectRecipeFrame(idx), requestRecipesFrame()]);
            return { recipeIndex: idx };
          });
        case "set-burr-gap":
          return write(
            () => parseRecipeValue(query.discDistance, "discDistance", BURR_GAP),
            (value) => patchCurrentRecipeField("discDistance", value)
          );
        case "set-target-weight":
          return write(
            () => parseRecipeValue(query.target, "target", TARGET_WEIGHT),
            (value) => patchCurrentRecipeField("target", value)
          );
        case "skin-target-weight":
          return write(
            () => parseDoseTileValue(request.body && request.body.targetWeight),
            async ({ mg, grams }) => {
              // Serialize this explicit Dose-tile write with the debounced
              // workflow listener; Bentwood's recipe patch is a multi-frame
              // command sequence and must not overlap another one.
              await acquireDoseSync();
              try {
                // Workflow is the Decaid source of truth for dose. If the
                // grinder is temporarily unavailable, the workflow event keeps
                // the desired dose queued for the normal retry path.
                await updateWorkflowDose(grams);
                const confirmed = nextRecipes(3000);
                await patchCurrentRecipeField("target", mg);
                await confirmed;
                const recipe = selectedRecipe();
                return { targetWeight: recipe ? recipe.target / 1000 : grams };
              } finally {
                releaseDoseSync();
                maybeSyncDose();
              }
            }
          );
        case "skin":
          return json(200, skinAnswer());
        case "skin-burr-gap": {
          // Called by the Streamline skin's Grind tile mode with JSON
          // {"burrGap": <number>}. Answers once the grinder has sent its
          // recipes back (or after 3 s), so the skin's follow-up `skin` read
          // shows the stored value; a rejected value snaps back there.
          const body = request.body && typeof request.body === "object" ? request.body : {};
          return write(
            () => parseRecipeValue(body.burrGap, "burrGap", BURR_GAP),
            async (value) => {
              const confirmed = nextRecipes(3000);
              await patchCurrentRecipeField("discDistance", value);
              await confirmed;
              const recipe = selectedRecipe();
              return { burrGap: recipe ? recipe.discDistance : null };
            }
          );
        }
        default:
          return json(404, { error: "not found" });
      }
    },
  };
}
