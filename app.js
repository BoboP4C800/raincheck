"use strict";

/* ---------- small helpers ---------- */
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const WET = 0.25;          // mm/h: below this we call it dry
const LIGHT_MAX = 2.5;     // mm/h: light < 2.5 <= moderate < 7.6 <= heavy
const MOD_MAX = 7.6;
const WINDOW = 120;        // minutes shown in the nowcast

const WX = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail",
};

const state = {
  loc: store.get("loc"),                       // {lat, lon, name}
  units: store.get("units") || "imperial",     // imperial | metric
  data: null,
  fetchedAt: 0,
};

/* ---------- data ---------- */
async function fetchForecast(loc) {
  const imperial = state.units === "imperial";
  const p = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    timezone: "auto",
    timeformat: "unixtime",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    minutely_15: "precipitation,snowfall",
    past_minutely_15: "2",
    forecast_minutely_15: "10",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    forecast_hours: "14",
    temperature_unit: imperial ? "fahrenheit" : "celsius",
    wind_speed_unit: imperial ? "mph" : "kmh",
  });
  const res = await fetch("https://api.open-meteo.com/v1/forecast?" + p);
  if (!res.ok) throw new Error("Forecast service returned " + res.status);
  return res.json();
}

/* Turn 15-minute sums into a per-minute intensity curve (mm/h) for the next WINDOW minutes.
   Each minutely_15 value is the total for the 15 minutes *ending* at its timestamp,
   so we place it at the middle of that interval and interpolate between them. */
function nowcast(data, nowSec) {
  const m = data.minutely_15;
  const pts = m.time.map((t, i) => ({
    t: t - 450,
    rate: (m.precipitation[i] || 0) * 4,
    snow: (m.snowfall[i] || 0) > 0,
  }));
  const curve = [];
  let snow = false;
  for (let k = 0; k <= WINDOW; k++) {
    const t = nowSec + k * 60;
    let rate = 0;
    if (pts.length) {
      if (t <= pts[0].t) rate = pts[0].rate;
      else if (t >= pts[pts.length - 1].t) rate = pts[pts.length - 1].rate;
      else {
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          if (t >= a.t && t <= b.t) { rate = a.rate + (b.rate - a.rate) * ((t - a.t) / (b.t - a.t)); break; }
        }
      }
    }
    curve.push(rate);
  }
  for (const p of pts) if (p.t >= nowSec - 900 && p.t <= nowSec + WINDOW * 60 && p.snow && p.rate > 0) snow = true;
  return { curve, snow };
}

const intensityWord = (r) => (r < LIGHT_MAX ? "Light" : r < MOD_MAX ? "Moderate" : "Heavy");

function minutesText(min) {
  const m = Math.max(5, Math.round(min / 5) * 5);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60), r = m % 60;
  return h + " hr" + (r ? " " + r + " min" : "");
}

function summarize(data, nc, nowSec) {
  const { curve, snow } = nc;
  const kind = snow ? "snow" : "rain";
  const peakOf = (a, b) => Math.max(...curve.slice(a, b + 1));
  const wetNow = curve[0] >= WET || (data.current.precipitation || 0) > 0.05;

  if (wetNow) {
    const end = curve.findIndex((r) => r < WET);
    const word = intensityWord(peakOf(0, end > 0 ? end : WINDOW));
    if (end > 0) return { head: `${word} ${kind} stopping in about ${minutesText(end)}.`, sub: `Then dry for a while.` };
    return { head: `${word} ${kind} for the next two hours.`, sub: `No break expected before ${clock(nowSec + WINDOW * 60, data.timezone)}.` };
  }

  const start = curve.findIndex((r) => r >= WET);
  if (start >= 0) {
    const restEnd = curve.slice(start).findIndex((r) => r < WET);
    const end = restEnd < 0 ? -1 : start + restEnd;
    const word = intensityWord(peakOf(start, end < 0 ? WINDOW : end));
    return {
      head: `${word} ${kind} starting in about ${minutesText(start)}.`,
      sub: end < 0 ? `Likely to continue past ${clock(nowSec + WINDOW * 60, data.timezone)}.` : `Lasting about ${minutesText(end - start)}.`,
    };
  }

  const h = data.hourly;
  for (let i = 0; i < h.time.length; i++) {
    if (h.time[i] <= nowSec + WINDOW * 60) continue;
    if ((h.precipitation_probability[i] || 0) >= 40) {
      return { head: "No rain for the next two hours.", sub: `${h.precipitation_probability[i]}% chance around ${clock(h.time[i], data.timezone)}.` };
    }
  }
  return { head: "No rain for the next two hours.", sub: "The next 12 hours look dry too." };
}

function clock(sec, tz) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(sec * 1000);
}
function hourLabel(sec, tz) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: tz }).format(sec * 1000).replace(/\s/g, "");
}

/* ---------- rendering ---------- */
function drawChart(nc) {
  const W = 340, H = 150, L = 6, R = 58, T = 8, B = 22;
  const pw = W - L - R, ph = H - T - B;
  const CAP = 16;
  const y = (r) => T + ph - (Math.log1p(Math.min(r, CAP)) / Math.log1p(CAP)) * ph;
  const x = (k) => L + (k / WINDOW) * pw;

  let pts = "";
  nc.curve.forEach((r, k) => { pts += `${x(k).toFixed(1)},${y(r).toFixed(1)} `; });
  const area = `M${x(0)},${y(0)} L${pts.trim().split(" ").join(" L")} L${x(WINDOW)},${y(0)} Z`;

  const bands = [[0.5, "Light"], [LIGHT_MAX, "Moderate"], [MOD_MAX, "Heavy"]]
    .map(([r, label]) => `<line class="band" x1="${L}" x2="${L + pw}" y1="${y(r)}" y2="${y(r)}"/>
      <text x="${L + pw + 6}" y="${y(r) + 3.5}">${label}</text>`).join("");

  const ticks = [[0, "Now"], [30, "30m"], [60, "1h"], [90, "1h30"], [120, "2h"]]
    .map(([k, label], i, arr) => {
      const anchor = i === 0 ? "start" : i === arr.length - 1 ? "end" : "middle";
      return `<line class="grid" x1="${x(k)}" x2="${x(k)}" y1="${T + ph}" y2="${T + ph + 4}"/>
        <text x="${x(k)}" y="${H - 6}" text-anchor="${anchor}">${label}</text>`;
    }).join("");

  const el = $("chart");
  el.classList.toggle("snow", nc.snow);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
    ${bands}
    <line class="grid" x1="${L}" x2="${L + pw}" y1="${T + ph}" y2="${T + ph}"/>
    ${ticks}
    <path class="area" d="${area}"/>
    <polyline class="edge" points="${pts}"/>
    <circle class="now-dot" cx="${x(0)}" cy="${y(nc.curve[0])}" r="3.5"/>
  </svg>`;
}

function render() {
  const d = state.data;
  if (!d) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const nc = nowcast(d, nowSec);
  const s = summarize(d, nc, nowSec);

  $("headline").textContent = s.head;
  $("subline").textContent = s.sub;
  drawChart(nc);

  const deg = "°";
  const c = d.current;
  $("nowTemp").textContent = Math.round(c.temperature_2m) + deg;
  $("nowDesc").textContent = WX[c.weather_code] || "";
  $("feels").textContent = Math.round(c.apparent_temperature) + deg;
  $("wind").textContent = Math.round(c.wind_speed_10m) + (state.units === "imperial" ? " mph" : " km/h");
  $("humid").textContent = Math.round(c.relative_humidity_2m) + "%";
  $("updated").textContent = "Updated " + clock(state.fetchedAt / 1000, d.timezone);

  const h = d.hourly;
  const items = [];
  for (let i = 0; i < h.time.length && items.length < 12; i++) {
    if (h.time[i] <= nowSec) continue;
    const pr = h.precipitation_probability[i] ?? 0;
    items.push(`<li class="hour${pr >= 40 ? " wet" : ""}">
      <span class="t">${hourLabel(h.time[i], d.timezone)}</span>
      <span class="bar" title="${pr}% chance"><i style="height:${Math.max(pr, 3)}%"></i></span>
      <span class="p">${pr}%</span>
      <span class="tmp">${Math.round(h.temperature_2m[i])}°</span>
    </li>`);
  }
  $("hours").innerHTML = items.join("");
}

async function load() {
  if (!state.loc) return;
  $("placeName").textContent = state.loc.name;
  try {
    state.data = await fetchForecast(state.loc);
    state.fetchedAt = Date.now();
    render();
  } catch (e) {
    $("headline").textContent = "Couldn't load the forecast.";
    $("subline").textContent = "Check your connection, then pull down or reopen the app to try again.";
  }
}

/* ---------- location ---------- */
function setLoc(loc) {
  state.loc = loc;
  store.set("loc", loc);
  $("sheet").close();
  $("headline").textContent = "Checking the sky…";
  $("subline").textContent = " ";
  load();
}

async function reverseName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const j = await r.json();
    return j.city || j.locality || j.principalSubdivision || "Current location";
  } catch { return "Current location"; }
}

function useGeolocation(fromButton) {
  const msg = $("geoMsg");
  if (!("geolocation" in navigator)) {
    msg.hidden = false; msg.textContent = "This browser can't share your location. Search for a city instead.";
    return;
  }
  msg.hidden = false; msg.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const name = await reverseName(lat, lon);
    msg.hidden = true;
    setLoc({ lat, lon, name, gps: true });
  }, (err) => {
    msg.textContent = err.code === 1
      ? "Location permission is off. Allow it in your browser settings, or search for a city."
      : "Couldn't get your location. Search for a city instead.";
    if (!fromButton) openSheet();
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}

function openSheet() {
  const s = $("sheet");
  if (!s.open) s.showModal();
}

let searchTimer;
async function search(q) {
  const list = $("results");
  if (q.trim().length < 2) { list.innerHTML = ""; return; }
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=${encodeURIComponent(q.trim())}`);
    const j = await r.json();
    const rows = j.results || [];
    list.innerHTML = rows.length ? "" : `<li class="geo-msg">No places match "${q.replace(/[<>&"]/g, "")}".</li>`;
    for (const p of rows) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      const strong = document.createElement("span"); strong.textContent = p.name;
      const small = document.createElement("small"); small.textContent = [p.admin1, p.country].filter(Boolean).join(", ");
      b.append(strong, small);
      b.addEventListener("click", () => setLoc({ lat: p.latitude, lon: p.longitude, name: p.name }));
      li.append(b); list.append(li);
    }
  } catch { list.innerHTML = `<li class="geo-msg">Search isn't reachable right now.</li>`; }
}

/* ---------- wiring ---------- */
$("placeBtn").addEventListener("click", openSheet);
$("geoBtn").addEventListener("click", () => useGeolocation(true));
$("q").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(e.target.value), 250); });
$("searchForm").addEventListener("submit", (e) => { if (e.submitter?.value !== "close") { e.preventDefault(); search($("q").value); } });

function paintUnits() { $("unitBtn").textContent = state.units === "imperial" ? "°F" : "°C"; }
$("unitBtn").addEventListener("click", () => {
  state.units = state.units === "imperial" ? "metric" : "imperial";
  store.set("units", state.units);
  paintUnits();
  load();
});

// Refresh when the app comes back to the foreground, and every 5 minutes while open.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.fetchedAt > 5 * 60e3) load();
});
setInterval(() => { if (document.visibilityState === "visible") load(); }, 5 * 60e3);
// Re-render every minute so "starting in N min" counts down between fetches.
setInterval(() => { if (state.data) render(); }, 60e3);

paintUnits();
if (state.loc) {
  load();
  if (state.loc.gps) useGeolocation(true); // quietly refresh GPS position
} else {
  $("headline").textContent = "Where are you?";
  $("subline").textContent = "Share your location or search for a city to see when rain arrives.";
  useGeolocation(false);
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
