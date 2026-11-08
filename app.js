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
  design: document.documentElement.dataset.design || "slate", // set before paint by the inline script in index.html
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
  const skyOf = (word) => (snow ? "snow" : word.toLowerCase());
  const roundMin = (m) => Math.max(5, Math.round(m / 5) * 5);
  // Every summary also carries: num/unit/label (a countdown the designs can show big),
  // sky (dry|light|moderate|heavy|snow), at (minute index of the next change, or null), kind, wet.

  if (wetNow) {
    const end = curve.findIndex((r) => r < WET);
    const word = intensityWord(peakOf(0, end > 0 ? end : WINDOW));
    if (end > 0) return { head: `${word} ${kind} stopping in about ${minutesText(end)}.`, sub: `Then dry for a while.`, mood: snow ? "snow" : "stopping",
      num: roundMin(end), unit: "min", label: `until the ${kind} stops`, sky: skyOf(word), at: end, kind, wet: true };
    return { head: `${word} ${kind} for the next two hours.`, sub: `No break expected before ${clock(nowSec + WINDOW * 60, data.timezone)}.`, mood: snow ? "snow" : "continuing",
      num: "2h+", unit: "", label: `of ${kind} ahead`, sky: skyOf(word), at: null, kind, wet: true };
  }

  const start = curve.findIndex((r) => r >= WET);
  if (start >= 0) {
    const restEnd = curve.slice(start).findIndex((r) => r < WET);
    const end = restEnd < 0 ? -1 : start + restEnd;
    const word = intensityWord(peakOf(start, end < 0 ? WINDOW : end));
    return {
      head: `${word} ${kind} starting in about ${minutesText(start)}.`,
      sub: end < 0 ? `Likely to continue past ${clock(nowSec + WINDOW * 60, data.timezone)}.` : `Lasting about ${minutesText(end - start)}.`,
      mood: snow ? "snow" : "start" + word,
      num: roundMin(start), unit: "min", label: `until ${kind}`, sky: skyOf(word), at: start, kind, wet: false,
    };
  }

  const dry = { num: "0", unit: "min", label: "of rain ahead", sky: "dry", at: null, kind: "rain", wet: false };
  const h = data.hourly;
  for (let i = 0; i < h.time.length; i++) {
    if (h.time[i] <= nowSec + WINDOW * 60) continue;
    if ((h.precipitation_probability[i] || 0) >= 40) {
      return { ...dry, head: "No rain for the next two hours.", sub: `${h.precipitation_probability[i]}% chance around ${clock(h.time[i], data.timezone)}.`, mood: "dryLater" };
    }
  }
  return { ...dry, head: "No rain for the next two hours.", sub: "The next 12 hours look dry too.", mood: "dry" };
}

/* ---------- a little personality (humor: 5/10) ---------- */
const QUIPS = {
  dry: ["Umbrella status: decorative.", "The sky has nothing to say. Enjoy the quiet.", "Dry as a weather app's sense of humor."],
  dryClear: ["Clear skies. Even the clouds took the day off.", "Sunglasses optional, smugness encouraged."],
  dryCloudy: ["Gray, but holding it together.", "The clouds are all talk and no drizzle.", "Overcast, not overdramatic."],
  dryLater: ["Dry for now. Keep an umbrella within negotiating distance.", "Enjoy the break. The clouds are scheduling a meeting.", "Good window for errands. It won't stay open forever."],
  startLight: ["Just enough to ruin a good hair day.", "Light stuff. A hood will handle it.", "Drizzle incoming: technically weather, mildly inconvenient."],
  startModerate: ["Real rain. The umbrella finally earns its keep.", "Now's a good time to bring the laundry in.", "Prime hours for a warm drink and a window seat."],
  startHeavy: ["Not a hood situation. A roof situation.", "Puddles will be deeper than they look.", "If you were going to run that errand, now's the time."],
  stopping: ["Hang in there. The sky is wrapping up.", "Leaving soon, like a guest who finally found their keys.", "Almost over. Your patience has been noted."],
  continuing: ["It's settled in. Make tea.", "The rain has cleared its schedule for you.", "Indoor plans recommended. Strongly."],
  snow: ["Snow incoming. Your car is getting a white coat.", "Flakes on the way. Walk like a penguin.", "Snow: pretty from the window, slippery from the sidewalk."],
  thunder: ["Thunder possible. Golf can wait.", "The sky is clearing its throat. Loudly."],
  fog: ["Foggy. Visibility is more of a suggestion today.", "Peak mysterious-movie-opening weather."],
  windy: ["Breezy enough to restyle your hair for free.", "Hold onto your hat. Literally."],
  icy: ["Rain at freezing temperatures. Sidewalks are now ice rinks.", "Freezing rain: walk like you're carrying soup."],

  /* Temperature variants, looked up as "<situation>:<band>" before the plain situation.
     Bands come from the feels-like temperature: frigid ≤20°F, cold ≤40°F, mild, warm ≥80°F, hot ≥90°F.
     A missing "frigid" variant falls back to "cold", and a missing "hot" one to "warm". */
  "dry:frigid": ["Dry, but the air has teeth.", "Clear and frigid. Your breath gets its own scene."],
  "dry:cold": ["Dry but cold. Your nose will know first.", "No rain, just a strong case for gloves.", "Layers. All of them."],
  "dry:warm": ["Dry and warm. Patio weather, officially.", "No rain and plenty of excuses to be outside."],
  "dry:hot": ["Hot one. Hydrate like it's your job.", "Dry and hot. The sidewalk could cook breakfast."],
  "dryLater:cold": ["Dry for now. Cold rain later, so plan accordingly.", "Enjoy the break. Cold and wet is on the way."],
  "dryLater:warm": ["Dry for now. A storm may drop by to cool things off.", "Warm and dry for the moment. The clouds are plotting."],
  "startLight:cold": ["Cold drizzle: weather being passive-aggressive.", "Light rain and chilly. Hood up, hands in pockets."],
  "startLight:warm": ["Warm drizzle. Basically a free misting fan.", "Light rain, warm air. Your hair will have opinions."],
  "startModerate:cold": ["Cold, steady rain. Soup was invented for this.", "Wet and chilly. Keep a towel by the door."],
  "startModerate:warm": ["Warm rain. Refreshing, unless you're wearing suede.", "Summer rain incoming. The garden says thanks."],
  "startHeavy:cold": ["Heavy, cold rain. Stay in and claim the warmest blanket.", "Downpour plus chill. Outdoor plans: politely decline."],
  "startHeavy:warm": ["Heavy rain, warm air. Strong thunderstorm energy.", "A downpour to break the heat. Dramatic, but effective."],
  "stopping:cold": ["Rain's wrapping up. The cold is staying for dessert.", "Almost dry. Still not warm, though."],
  "stopping:warm": ["Rain's leaving. The humidity is moving into its room.", "Wrapping up soon. Expect steam off the pavement."],
  "continuing:cold": ["Cold rain for a while. Make tea. Make two.", "Chilly and wet for the long haul. Socks matter today."],
  "continuing:warm": ["Warm rain sticking around. Sauna, but outside.", "Raining and muggy. Your windows will fog up."],
  "snow:frigid": ["Snow and frigid. The powdery kind of miserable.", "Snow plus deep cold. Shovel in short shifts."],
  "thunder:warm": ["Hot and stormy. Nature's air conditioning, with sound effects.", "Thunder on a warm day. The sky is venting."],
  "windy:cold": ["Windy and cold. The wind chill is working overtime.", "Gusty and cold. Zip everything."],
  "windy:warm": ["Warm and windy. Like standing in front of a giant hair dryer.", "Breezy and warm. Hats will travel."],
  "fog:cold": ["Cold fog. Very haunted-moor of you, Mother Nature.", "Foggy and chilly. Headlights on, mittens too."],
};

function tempBand(feelsF) {
  if (feelsF <= 20) return "frigid";
  if (feelsF <= 40) return "cold";
  if (feelsF >= 90) return "hot";
  if (feelsF >= 80) return "warm";
  return "mild";
}

function quipFor(mood, data) {
  const c = data.current;
  const imperial = state.units === "imperial";
  const toF = (t) => (imperial ? t : t * 9 / 5 + 32);
  const airF = toF(c.temperature_2m);
  const band = tempBand(toF(c.apparent_temperature));
  const windMph = imperial ? c.wind_speed_10m : c.wind_speed_10m / 1.609;
  const rainy = mood.startsWith("start") || mood === "stopping" || mood === "continuing";

  let key = mood;
  if (c.weather_code >= 95) key = "thunder";
  else if (rainy && airF <= 32) key = "icy";
  else if (mood === "dry") {
    if (c.weather_code === 45 || c.weather_code === 48) key = "fog";
    else if (windMph >= 25) key = "windy";
    else if (band === "mild" && c.weather_code <= 1) key = "dryClear";
    else if (band === "mild" && c.weather_code <= 3) key = "dryCloudy";
  }

  const softer = { frigid: "cold", hot: "warm" }[band];
  const list = QUIPS[`${key}:${band}`] || (softer && QUIPS[`${key}:${softer}`]) || QUIPS[key] || QUIPS.dry;
  // Same joke for the whole hour, so it doesn't change on every refresh.
  const seed = Math.floor(Date.now() / 3600e3) + key.length * 7 + band.length;
  return list[seed % list.length];
}

function clock(sec, tz) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(sec * 1000);
}
function hourLabel(sec, tz) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: tz }).format(sec * 1000).replace(/\s/g, "");
}

/* ---------- designs ---------- */
const DESIGNS = [
  { id: "slate", name: "Slate", blurb: "The control. A plain sentence, a line chart, cool grays." },
  { id: "aneroid", name: "Aneroid", blurb: "A barometer dial. The next two hours wrap around the face like a clock." },
  { id: "gate", name: "Gate Change", blurb: "An arrivals board. Rain is announced like a delayed flight." },
  { id: "minute", name: "Minute Hand", blurb: "One enormous countdown on a field of color that changes with the sky." },
  { id: "margin", name: "Margin Notes", blurb: "A field notebook on graph paper, with scribbles in the margins." },
];

const CAP = 16; // mm/h at the top of every intensity scale
const scale = (r) => Math.log1p(Math.min(r, CAP)) / Math.log1p(CAP); // 0..1, log so drizzle still shows
const avgOf = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
const f1 = (n) => n.toFixed(1);

/* Each design draws the 2-hour nowcast its own way. All return markup for #chart. */
const CHARTS = {
  slate(nc) {
    const W = 340, H = 150, L = 6, R = 58, T = 8, B = 22;
    const pw = W - L - R, ph = H - T - B;
    const y = (r) => T + ph - scale(r) * ph;
    const x = (k) => L + (k / WINDOW) * pw;
    let pts = "";
    nc.curve.forEach((r, k) => { pts += `${f1(x(k))},${f1(y(r))} `; });
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
    return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${bands}
      <line class="grid" x1="${L}" x2="${L + pw}" y1="${T + ph}" y2="${T + ph}"/>${ticks}
      <path class="area" d="${area}"/><polyline class="edge" points="${pts}"/>
      <circle class="now-dot" cx="${x(0)}" cy="${y(nc.curve[0])}" r="3.5"/></svg>`;
  },

  /* Barometer face: "now" at 12 o'clock, two hours once around. Rain is drawn as rays off the ring. */
  aneroid(nc, s) {
    const C = 160, R0 = 86, RM = 128;
    const pol = (deg, r) => [C + r * Math.cos(deg * Math.PI / 180), C + r * Math.sin(deg * Math.PI / 180)];
    let rays = "", ticks = "";
    for (let k = 0; k < WINDOW; k++) {
      const r = nc.curve[k];
      if (r < 0.05) continue;
      const a = -90 + k * 3;
      const [x1, y1] = pol(a, R0 + 3), [x2, y2] = pol(a, R0 + 3 + Math.max(0.08, scale(r)) * (RM - R0));
      rays += `<line class="ray${r < WET ? " trace" : ""}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
    }
    for (let k = 0; k < WINDOW; k += 5) {
      const a = -90 + k * 3, major = k % 15 === 0;
      const [x1, y1] = pol(a, 133), [x2, y2] = pol(a, major ? 143 : 138);
      ticks += `<line class="tick${major ? " major" : ""}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
      if (k % 30 === 0) {
        const [tx, ty] = pol(a, 152);
        ticks += `<text class="tlabel" x="${f1(tx)}" y="${f1(ty + 3.5)}" text-anchor="middle">${k === 0 ? "NOW" : k}</text>`;
      }
    }
    const ha = -90 + (s.at ?? 0) * 3;
    const [hx, hy] = pol(ha, 124), [tx0, ty0] = pol(ha, 64);
    const caption = [s.unit, s.label].filter(Boolean).join(" ").toUpperCase();
    return `<svg viewBox="0 0 320 320" aria-hidden="true">
      <circle class="face" cx="${C}" cy="${C}" r="${R0}"/>
      ${ticks}${rays}
      <line class="hand" x1="${f1(tx0)}" y1="${f1(ty0)}" x2="${f1(hx)}" y2="${f1(hy)}"/>
      <circle class="pivot" cx="${f1(hx)}" cy="${f1(hy)}" r="4"/>
      <text class="num" x="${C}" y="${C + 14}" text-anchor="middle">${s.num}</text>
      <text class="unit" x="${C}" y="${C + 38}" text-anchor="middle">${caption}</text>
    </svg>`;
  },

  /* Arrivals board: one row per 15 minutes. */
  gate(nc, s, d, nowSec) {
    let rows = "";
    for (let k = 0; k < WINDOW; k += 15) {
      const avg = avgOf(nc.curve.slice(k, k + 15));
      const wet = avg >= WET;
      const lvl = !wet ? 0 : avg < LIGHT_MAX ? 1 : avg < MOD_MAX ? 2 : 3;
      const status = wet ? `${intensityWord(avg)} ${nc.snow ? "snow" : "rain"}` : "Clear";
      const pips = [1, 2, 3].map((i) => `<i class="${i <= lvl ? "on" : ""}"></i>`).join("");
      rows += `<tr class="${wet ? "wet" : ""}"><td class="tm">${k === 0 ? "Now" : clock(nowSec + k * 60, d.timezone)}</td><td class="st">${status}</td><td class="pips">${pips}</td></tr>`;
    }
    return `<table class="board"><thead><tr><th>Time</th><th>Forecast</th><th>Level</th></tr></thead><tbody>${rows}</tbody></table>`;
  },

  /* 24 chunky bars, five minutes each. */
  minute(nc) {
    const W = 340, H = 170, T = 4, B = 24, n = 24, gap = 4;
    const ph = H - T - B, bw = (W - gap * (n - 1)) / n;
    let bars = "";
    for (let i = 0; i < n; i++) {
      const avg = avgOf(nc.curve.slice(i * 5, i * 5 + 5));
      const wet = avg >= WET;
      const h = wet ? Math.max(8, scale(avg) * ph) : 3;
      bars += `<rect class="${wet ? "b wet" : "b"}" x="${f1(i * (bw + gap))}" y="${f1(T + ph - h)}" width="${f1(bw)}" height="${f1(h)}" rx="2"/>`;
    }
    const lab = [[0, "NOW", "start"], [W / 2, "1 HR", "middle"], [W, "2 HR", "end"]]
      .map(([x, t, a]) => `<text x="${x}" y="${H - 4}" text-anchor="${a}">${t}</text>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${bars}${lab}</svg>`;
  },

  /* Pencil sketch with hatching and a margin note pointing at the change. */
  margin(nc, s) {
    const W = 340, H = 180, L = 8, R = 8, T = 40, B = 26;
    const pw = W - L - R, ph = H - T - B, base = T + ph;
    const x = (k) => L + (k / WINDOW) * pw;
    const wob = (k, amt) => (Math.sin(k * 1.7) + Math.sin(k * 0.53 + 1)) * amt;
    const y = (r, k) => base - scale(r) * ph + (r >= 0.05 ? wob(k, 0.7) : 0);
    let line = "";
    for (let k = 0; k <= WINDOW; k += 3) line += `${f1(x(k))},${f1(y(nc.curve[k], k))} `;
    const area = `M${x(0)},${base} L${line.trim().split(" ").join(" L")} L${x(WINDOW)},${base} Z`;
    let baseline = "";
    for (let k = 0; k <= WINDOW; k += 10) baseline += `${f1(x(k))},${f1(base + 2 + wob(k + 3, 0.6))} `;
    const ticks = [[0, "now"], [30, "30"], [60, "1 hr"], [90, "90"], [120, "2 hrs"]]
      .map(([k, t], i, arr) => `<text class="tk" x="${x(k)}" y="${H - 4}" text-anchor="${i === 0 ? "start" : i === arr.length - 1 ? "end" : "middle"}">${t}</text>`).join("");
    let note = "";
    if (s.at != null) {
      const ax = x(s.at), ay = y(nc.curve[s.at], s.at) - 6;
      const tx = Math.min(Math.max(ax + 30, 70), W - 70);
      const words = s.wet ? "dry from here!" : `${s.kind} starts here`;
      note = `<text class="note" x="${f1(tx)}" y="22" text-anchor="middle">${words}</text>
        <path class="arrow" d="M${f1(tx - 10)},28 Q${f1((tx + ax) / 2 - 12)},${f1((28 + ay) / 2 - 10)} ${f1(ax)},${f1(ay)}"/>
        <path class="arrow" d="M${f1(ax - 6)},${f1(ay - 7)} L${f1(ax)},${f1(ay)} L${f1(ax + 7)},${f1(ay - 4)}"/>`;
    } else if (s.wet) {
      note = `<text class="note" x="${W / 2}" y="22" text-anchor="middle">wet the whole way →</text>`;
    } else {
      note = `<text class="note" x="${W / 2}" y="${base - 30}" text-anchor="middle">nothing. zip. nada.</text>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(40)"><line class="hatch" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>
      <path class="hatched" d="${area}"/>
      <polyline class="scrawl" points="${line}"/>
      <polyline class="base" points="${baseline}"/>
      ${ticks}${note}</svg>`;
  },
};

function drawChart(nc, s, d, nowSec) {
  const el = $("chart");
  el.className = `chart chart-${state.design}${nc.snow ? " snow" : ""}`;
  el.innerHTML = (CHARTS[state.design] || CHARTS.slate)(nc, s, d, nowSec);
}

function syncThemeColor() {
  const bg = getComputedStyle(document.body).backgroundColor;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = bg; });
}

function paintDesignList() {
  $("designName").textContent = (DESIGNS.find((d) => d.id === state.design) || DESIGNS[0]).name;
  $("designList").innerHTML = DESIGNS.map((d) => `
    <button type="button" class="design-opt" role="radio" aria-checked="${d.id === state.design}" data-id="${d.id}">
      <span class="dn">${d.name}</span><small>${d.blurb}</small>
    </button>`).join("");
}

function applyDesign(id) {
  if (!DESIGNS.some((d) => d.id === id)) id = "slate";
  state.design = id;
  document.documentElement.dataset.design = id;
  try { localStorage.setItem("design", id); } catch { /* storage unavailable */ }
  const link = $("designCss");
  link.onload = syncThemeColor;
  link.href = `designs/${id}.css`;
  paintDesignList();
  if (state.data) render();
}

function render() {
  const d = state.data;
  if (!d) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const nc = nowcast(d, nowSec);
  const s = summarize(d, nc, nowSec);

  $("headline").textContent = s.head;
  $("subline").textContent = s.sub;
  $("quip").textContent = quipFor(s.mood, d);
  $("quip").hidden = false;
  $("bigNum").innerHTML = [...String(s.num)].map((ch) => `<span class="ch">${ch}</span>`).join("");
  $("bigLabel").textContent = [s.unit, s.label].filter(Boolean).join(" ");
  document.documentElement.dataset.sky = s.sky;
  drawChart(nc, s, d, nowSec);
  renderWhere(d);

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
      <span class="bar" title="${pr}% chance"><i style="--p:${Math.max(pr, 3)}%"></i></span>
      <span class="p">${pr}%</span>
      <span class="tmp">${Math.round(h.temperature_2m[i])}°</span>
    </li>`);
  }
  $("hours").innerHTML = items.join("");
  syncThemeColor();
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
  if ($("sheet").open) $("sheet").close();
  if (!state.data) {
    $("headline").textContent = "Checking the sky…";
    $("subline").textContent = " ";
  }
  load();
}

/* Nearest street address via OpenStreetMap (called once per new position, never on a timer). */
async function reverseAddress(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`, { headers: { "Accept-Language": navigator.language || "en" } });
    if (!r.ok) throw new Error();
    const a = (await r.json()).address || {};
    const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || "";
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    const area = a.neighbourhood || a.suburb || "";
    const address = [street, area !== town ? area : "", town, a.state].filter(Boolean).join(", ");
    return { name: town || "Current location", address: address || "No street address nearby" };
  } catch {
    return { name: "Current location", address: "Address lookup unavailable" };
  }
}

function distKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function fmtDist(km) {
  if (state.units === "imperial") {
    const mi = km / 1.609;
    return mi < 0.2 ? Math.max(10, Math.round(mi * 5280 / 10) * 10) + " ft" : mi.toFixed(1) + " mi";
  }
  return km < 1 ? Math.max(5, Math.round(km * 1000 / 5) * 5) + " m" : km.toFixed(1) + " km";
}

function renderWhere(d) {
  const L = state.loc;
  if (!L) return;
  $("where").hidden = false;
  $("whereAddr").textContent = L.address || L.name;
  $("whereHow").textContent = L.gps
    ? (L.acc ? `GPS, accurate to within ${fmtDist(L.acc / 1000)}` : "GPS")
    : "City search, so the forecast uses the city center";
  const km = distKm(L.lat, L.lon, d.latitude, d.longitude);
  $("whereGrid").textContent = `${fmtDist(km)} from ${L.gps ? "you" : "the city center"} (${d.latitude.toFixed(3)}, ${d.longitude.toFixed(3)})`;
  $("whereElev").textContent = state.units === "imperial"
    ? Math.round(d.elevation * 3.281).toLocaleString() + " ft"
    : Math.round(d.elevation).toLocaleString() + " m";
}

function useGeolocation(fromButton) {
  const msg = $("geoMsg");
  if (!("geolocation" in navigator)) {
    msg.hidden = false; msg.textContent = "This browser can't share your location. Search for a city instead.";
    return;
  }
  msg.hidden = false; msg.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const prev = state.loc;
    const moved = !prev || !prev.gps || !prev.address || distKm(prev.lat, prev.lon, lat, lon) > 0.1;
    const place = moved ? await reverseAddress(lat, lon) : { name: prev.name, address: prev.address };
    msg.hidden = true;
    setLoc({ lat, lon, name: place.name, address: place.address, acc: Math.round(accuracy), gps: true });
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
      b.addEventListener("click", () => setLoc({ lat: p.latitude, lon: p.longitude, name: p.name, address: [p.name, p.admin1, p.country].filter(Boolean).join(", ") }));
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

// Design switcher (development setting). Also reachable as ?design=slate|aneroid|gate|minute|margin
$("designBtn").addEventListener("click", () => { paintDesignList(); $("designSheet").showModal(); });
$("designList").addEventListener("click", (e) => {
  const b = e.target.closest(".design-opt");
  if (b) { applyDesign(b.dataset.id); $("designSheet").close(); }
});

paintUnits();
paintDesignList();
try { localStorage.setItem("design", state.design); } catch { /* storage unavailable */ }
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
