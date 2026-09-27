import { GatewayClient, DemoClient } from "./api.js";

// ------------------------------------------------------------------ state
const CFG_KEY = "wheat-water-config";
const cfg = (() => { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; } })();
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* ignore */ } }

let client = null;
let tab = "home";
let last = null;           // last /status
let busy = false;

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, d = 0) => (v == null || isNaN(v) ? "–" : Number(v).toFixed(d));

function makeClient() {
  if (cfg.mode === "demo") return new DemoClient();
  if (cfg.url) return new GatewayClient(cfg.url, cfg.token);
  return null;
}

function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function setLink(kind, text) {
  const b = $("#linkDot"); b.className = "link " + kind; $("#linkText").textContent = text;
}

// ------------------------------------------------------------------ dialogs
function dialog(html, onSubmit) {
  const d = $("#dlg"), f = $("#dlgForm");
  f.innerHTML = html;
  d.showModal();
  const first = f.querySelector("input,select,button"); if (first) first.focus();
  return new Promise((resolve) => {
    f.onsubmit = async (ev) => {
      const btn = ev.submitter;
      if (!btn || btn.value === "cancel") { resolve(null); return; }
      ev.preventDefault();
      try { const r = await onSubmit(new FormData(f), btn.value); if (r !== false) { d.close(); resolve(r); } }
      catch (e) { const err = f.querySelector(".err"); if (err) err.textContent = e.message; else toast(e.message); }
    };
    d.onclose = () => resolve(null);
  });
}

// ------------------------------------------------------------------ helpers
const ACTION = {
  irrigate: { title: (c) => `Irrigate ${num(c.quantity_mm)} mm`, pill: "blue", word: "Irrigate" },
  wait: { title: () => "No irrigation needed", pill: "green", word: "Wait" },
  insufficient_data: { title: () => "Not enough information to advise", pill: "amber", word: "No advice" },
  scout: { title: () => "Check the field", pill: "amber", word: "Scout" },
  fertigate: { title: () => "Fertigation advised", pill: "amber", word: "Fertigate" },
};
const DISP = { approve: ["Approved", "green"], modify: ["Changed", "blue"], reject: ["Declined", "amber"],
  acknowledge: ["Seen", "grey"], superseded: ["Replaced by newer advice", "grey"], null: ["Waiting for you", "red"] };

function fmtWindow(w) {
  if (!w || !w.start) return "–";
  const s = new Date(w.start), e = new Date(w.end);
  const o = { weekday: "short", hour: "2-digit", minute: "2-digit" };
  return `${s.toLocaleString(undefined, o)} to ${e.toLocaleString(undefined, o)}`;
}
function ago(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`; return `${Math.round(h / 24)} days ago`;
}

function gauge(st) {
  if (!st) return `<p class="muted">No field state yet.</p>`;
  const taw = st.taw_mm || 1, pct = (v) => Math.max(0, Math.min(100, v / taw * 100));
  return `
  <div class="gauge" role="img" aria-label="Soil water used ${num(st.dr_mm)} of ${num(taw)} millimetres; irrigation trigger at ${num(st.raw_mm)}; tomorrow about ${num(st.forecast_dr_mm)}">
    <div class="bar">
      <div class="fill" style="width:${pct(st.dr_mm)}%"></div>
      <div class="mark" style="left:calc(${pct(st.raw_mm)}% - 1px)"></div>
      <div class="fc" style="left:${pct(st.forecast_dr_mm)}%"></div>
    </div>
    <div class="scale"><span>Full (0 mm used)</span><span>Empty (${num(taw)} mm)</span></div>
  </div>
  <div class="legend"><span><i style="background:var(--soil)"></i>Used now: ${num(st.dr_mm, 1)} mm</span>
    <span><i style="background:var(--red)"></i>Irrigate at: ${num(st.raw_mm, 1)} mm</span>
    <span><i style="border:3px solid var(--ink);border-radius:50%"></i>Tomorrow: ${num(st.forecast_dr_mm, 1)} mm</span></div>`;
}

// ------------------------------------------------------------------ views
function viewConnect(err, url) {
  return `
  <div class="card">
    <h3>Connect to your field gateway</h3>
    <p class="small muted">Join the gateway's Wi-Fi (or your farm Wi-Fi), then enter the address and pairing code printed on the gateway.</p>
    ${err ? `<p class="warn small">${esc(err)}</p>` : ""}
    <form id="connForm">
      <label for="u">Gateway address</label>
      <input id="u" name="url" type="url" inputmode="url" placeholder="http://192.168.4.1:8000" value="${esc(url || cfg.url || "")}" required>
      <label for="t">Pairing code</label>
      <input id="t" name="token" type="password" inputmode="numeric" autocomplete="off" value="${esc(cfg.token || "")}">
      <div class="actions"><button class="btn primary block" type="submit">Connect</button></div>
    </form>
    <div class="actions"><button class="btn block" id="demoBtn" type="button">Try demo (recorded season, no gateway)</button></div>
  </div>
  <p class="small muted" style="padding:0 6px">This app shows advice. It never runs the pump by itself: the gateway starts irrigation only after you approve an advisory.</p>`;
}

function viewHome(s) {
  const st = s.state, card = (s.pending || [])[0];
  const node = (s.nodes || [])[0];
  const q = (s.questions || []).length;
  const fs = s.failsafe || {};
  return `
  ${card ? `
  <div class="card hero ${card.action === "irrigate" ? "irrigate" : ""}">
    <div class="row between"><span class="pill ${ACTION[card.action]?.pill || "grey"}">Today's advice</span><span class="tiny muted">day ${esc(card.day)}</span></div>
    <div class="big">${esc(ACTION[card.action]?.title(card) || card.action)}</div>
    ${card.action === "irrigate" ? `<div class="muted">about ${num(card.pump_minutes)} min of pumping${card.pump_cost_rs != null ? `, about Rs ${num(card.pump_cost_rs)}` : ""}</div>` : ""}
    <div class="actions"><button class="btn primary block" data-go="advice">${card.action === "irrigate" ? "Review and decide" : "See why"}</button></div>
  </div>` : `
  <div class="card"><h3>No advice waiting</h3><p class="small muted">${s.link_ok === false ? "The advisory service could not be reached today, so there is no advice. Nothing will run by itself." : "The next advice arrives after the daily forecast."}</p></div>`}

  ${q ? `<div class="card"><div class="row between"><h3>The advisor has ${q === 1 ? "a question" : q + " questions"}</h3><span class="pill amber">1 min</span></div>
    <p class="small muted">Your answer changes which day it recommends.</p>
    <button class="btn block" data-go="advice">Answer</button></div>` : ""}

  <h2>Field</h2>
  <div class="card">
    <div class="row between"><h3>Root-zone water</h3>${st ? `<span class="pill ${st.health_ok ? "green" : "amber"}">${st.health_ok ? "Sensors OK" : "Check sensors"}</span>` : ""}</div>
    ${gauge(st)}
    ${st ? `<div class="grid2 kv" style="margin-top:12px">
      <div><div class="k">Crop stage</div><div class="v small">${esc(st.stage || "–")}</div></div>
      <div><div class="k">Day of season</div><div class="v">${esc(st.day ?? s.day)}</div></div>
      <div><div class="k">Water holding (root zone)</div><div class="v">${num(st.taw_mm)} mm</div></div>
      <div><div class="k">Crop water use</div><div class="v">${num(st.etc_mm, 1)} mm/day</div></div></div>` : ""}
  </div>

  <div class="card">
    <div class="row between"><h3>Sensor node</h3><span class="tiny muted">${node ? ago(node.ts) : ""}</span></div>
    ${node ? `<div class="grid2 kv"><div><div class="k">Battery</div><div class="v">${(node.battery_mv / 1000).toFixed(2)} V</div></div>
      <div><div class="k">Status</div><div class="v">${node.sensor_fault ? "Fault" : "OK"}</div></div></div>`
      : `<p class="small muted">No reading received yet.</p>`}
  </div>

  <div class="card"><div class="row between"><h3>Automatic safety watering</h3><span class="pill ${fs.armed ? "amber" : "grey"}">${fs.armed ? "On" : "Off"}</span></div>
    <p class="small muted">${fs.armed ? `If the gateway loses contact and the soil gets very dry, it may give ${num(fs.dose_mm)} mm by itself, at most ${fs.max_events} times.` : "Off: if contact is lost, nothing runs by itself. Change in Settings."}</p></div>

  ${s.sim ? `<h2>Simulation</h2><div class="card"><p class="small muted">${s.demo ? "Demo: a season recorded from the real gateway and advisory service on replayed weather." : "The gateway is replaying a recorded season."}</p>
    <div class="actions two"><button class="btn" id="nextDay">Next day</button>${s.demo ? `<button class="btn" id="nextAdvice">Next irrigation advice</button>` : `<button class="btn" id="sendReading">Send reading</button>`}</div>
    ${s.demo ? `<div class="actions"><button class="btn" id="resetDemo">Restart demo season</button></div>` : ""}</div>` : ""}`;
}

async function viewAdvice(s) {
  const cards = s.pending || [];
  let qhtml = "";
  try {
    const q = await client.questions();
    last._reasons = q.reasons;
    qhtml = (q.questions || []).map((qq, i) => `
      <div class="card"><h3>Question</h3><p>${esc(qq.text)}</p>
        <form class="qForm" data-i="${i}">
          ${(qq.inputs || []).map(inp => inputFor(inp)).join("")}
          <p class="err small" style="color:var(--red)"></p>
          <div class="actions two"><button class="btn primary" type="submit">Send answer</button><button class="btn" type="button" data-skip="1">Not now</button></div>
        </form></div>`).join("");
  } catch (e) { qhtml = ""; }
  if (!cards.length) return `<div class="card"><h3>No advice waiting</h3><p class="small muted">Decisions you made are in History.</p></div>${qhtml}`;
  return cards.map(c => {
    const a = ACTION[c.action] || { title: () => c.action, pill: "grey" };
    const plan = c.plan || {};
    const src = (c.sources || []).map(x => `${esc(x.document || "source")} p.${esc(x.page)}`).join("; ");
    return `
    <div class="card hero ${c.action === "irrigate" ? "irrigate" : ""}">
      <div class="row between"><span class="pill ${a.pill}">${esc(a.word || c.action)}</span><span class="tiny muted">issued ${esc(ago(c.issued))}</span></div>
      <div class="big">${esc(a.title(c))}</div>
      ${c.action === "irrigate" ? `
      <div class="grid2 kv" style="margin-top:10px">
        <div><div class="k">When</div><div class="v small">${esc(fmtWindow(c.window))}</div></div>
        <div><div class="k">Pump time (estimate)</div><div class="v">${num(c.pump_minutes)} min</div></div>
        <div><div class="k">Cost (estimate)</div><div class="v">${c.pump_cost_rs != null ? "Rs " + num(c.pump_cost_rs) : "add tariff"}</div></div>
        <div><div class="k">Why today</div><div class="v small">${c.clause === "pre-empt" ? "Water is available now and needed before the next turn" : "The field reaches the trigger"}</div></div>
      </div>` : ""}
      <p class="why">${esc(c.rationale)}</p>
      ${plan.stress_avoided_mm_days ? `<p class="small muted">Waiting for the next water turn would cost about ${num(plan.stress_avoided_mm_days)} mm-days of crop stress.</p>` : ""}
      ${src ? `<p class="tiny muted">Sources: ${src}</p>` : ""}
      ${c.action === "irrigate" ? `
      <div class="actions"><button class="btn primary block" data-act="approve" data-id="${esc(c.advisory_id)}">Approve ${num(c.quantity_mm)} mm</button></div>
      <div class="actions two"><button class="btn" data-act="modify" data-id="${esc(c.advisory_id)}">Change amount</button><button class="btn danger" data-act="reject" data-id="${esc(c.advisory_id)}">Not today</button></div>
      <div class="note"><strong>You are in control.</strong> The pump starts only after you approve. The gateway works out the run time itself from the amount you approve.</div>`
      : `<div class="actions"><button class="btn block" data-act="acknowledge" data-id="${esc(c.advisory_id)}">OK, understood</button></div>`}
    </div>`;
  }).join("") + qhtml;
}

function inputFor(inp) {
  const id = "f_" + inp.field, b = inp.bounds;
  const hint = inp.relative_day ? " (from today)" : "";
  if (inp.type === "choice") {
    return `<label for="${id}">${esc(inp.label)}</label><select id="${id}" name="${esc(inp.field)}" required><option value="">Choose…</option>${inp.choices.map(c => `<option>${esc(c)}</option>`).join("")}</select>`;
  }
  const step = inp.type === "int" ? "1" : "any";
  const lim = b ? `min="${b[0]}" max="${b[1]}"` : (inp.relative_day ? `min="0" max="30"` : "");
  return `<label for="${id}">${esc(inp.label)}${hint}${inp.unit ? ` (${esc(inp.unit)})` : ""}</label><input id="${id}" name="${esc(inp.field)}" type="number" step="${step}" ${lim} inputmode="decimal">`;
}

async function viewHistory() {
  const [adv, cmd, ev] = await Promise.all([client.advisories(), client.commands(), client.events()]);
  const advRows = (adv || []).filter(a => a.action === "irrigate" || a.disposition).slice(0, 40).map(a => {
    const [lab, col] = DISP[a.disposition ?? "null"] || [a.disposition, "grey"];
    return `<li><div class="row between"><strong>Day ${esc(a.day)} · ${esc((ACTION[a.action]?.word) || a.action)}${a.quantity_mm ? " " + num(a.quantity_mm) + " mm" : ""}</strong><span class="pill ${col}">${esc(lab)}</span></div>
      ${a.modified_mm ? `<div class="small muted">Changed to ${num(a.modified_mm)} mm</div>` : ""}${a.reason_code ? `<div class="small muted">Reason: ${esc((last?._reasons || {})[a.reason_code] || a.reason_code)}</div>` : ""}</li>`;
  }).join("");
  const cmdRows = (cmd || []).map(c => `<li><div class="row between"><strong>${num(c.volume_mm)} mm · ${num(c.run_minutes)} min</strong>
      <span class="pill ${c.origin === "fail_safe" ? "amber" : "green"}">${c.origin === "fail_safe" ? "Safety watering" : "You approved"}</span></div><div class="tiny muted">${esc(new Date(c.ts).toLocaleString())}</div></li>`).join("");
  const evRows = (ev || []).slice(0, 40).map(e => `<li class="small"><strong>${esc(e.kind.replaceAll("_", " "))}</strong> <span class="muted tiny">${esc(new Date(e.ts).toLocaleString())}</span><div class="tiny muted" style="word-break:break-word">${esc((e.detail || "").slice(0, 140))}</div></li>`).join("");
  return `<h2>Pump runs</h2><div class="card"><ul class="list">${cmdRows || `<li class="muted small">No pump runs yet.</li>`}</ul></div>
    <h2>Advice and your decisions</h2><div class="card"><ul class="list">${advRows || `<li class="muted small">Nothing yet.</li>`}</ul></div>
    <h2>Gateway log</h2><div class="card"><details><summary class="small">Show ${Math.min((ev || []).length, 40)} recent events</summary><ul class="list">${evRows}</ul></details></div>`;
}

function chart(hist) {
  const h = (hist || []).filter(x => x && x.dr_mm != null);
  if (h.length < 2) return `<p class="small muted">The chart appears after two days of data.</p>`;
  const W = 320, H = 150, P = 26;
  const maxY = Math.max(...h.map(x => x.taw_mm || x.raw_mm || x.dr_mm)) * 1.05;
  const x = (i) => P + i * (W - P - 6) / (h.length - 1), y = (v) => H - P - v / maxY * (H - P - 8);
  const line = (k) => h.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Soil water used and irrigation trigger over the last ${h.length} days">
    <line x1="${P}" y1="${H - P}" x2="${W - 4}" y2="${H - P}" stroke="var(--line)"/>
    <text x="2" y="${y(maxY / 1.05) + 4}" font-size="9" fill="var(--muted)">${Math.round(maxY / 1.05)}</text><text x="10" y="${H - P + 3}" font-size="9" fill="var(--muted)">0</text>
    <path d="${line("raw_mm")}" fill="none" stroke="var(--red)" stroke-width="2" stroke-dasharray="4 3"/>
    <path d="${line("dr_mm")}" fill="none" stroke="var(--soil)" stroke-width="2.5"/>
    <text x="${P}" y="${H - 8}" font-size="9" fill="var(--muted)">day ${esc(h[0].day)}</text><text x="${W - 40}" y="${H - 8}" font-size="9" fill="var(--muted)">day ${esc(h[h.length - 1].day)}</text>
  </svg><div class="legend"><span><i style="background:var(--soil)"></i>Water used (mm)</span><span><i style="background:var(--red)"></i>Irrigate at (mm)</span></div>`;
}

async function viewSensors() {
  const [nodes, hist] = await Promise.all([client.readings(), client.history()]);
  const latest = {}; (nodes || []).forEach(n => { if (!latest[n.node_id]) latest[n.node_id] = n; });
  const depths = ["10 cm", "20 cm", "50 cm"];
  const nodeCards = Object.values(latest).map(n => `
    <div class="card nodes"><div class="row between"><h3>Node ${esc(n.node_id)}</h3><span class="tiny muted">${esc(ago(n.ts))}</span></div>
      ${(n.vwc || []).map((v, i) => `<div class="depth"><span class="small">${depths[i] || ""}</span><div class="b"><span style="width:${Math.min(100, v / 0.45 * 100)}%"></span></div><span class="small">${(v * 100).toFixed(1)}%</span></div>`).join("")}
      <div class="grid2 kv" style="margin-top:8px"><div><div class="k">Soil temp. (10 cm)</div><div class="v">${num((n.soil_t || n.soil_t_c || [])[0], 1)} °C</div></div>
      <div><div class="k">Air</div><div class="v">${num(n.air_t ?? n.air_t_c, 1)} °C, ${num(n.rh ?? n.rh_pct)}%</div></div>
      <div><div class="k">Battery</div><div class="v">${(n.battery_mv / 1000).toFixed(2)} V</div></div><div><div class="k">Sensor</div><div class="v">${n.sensor_fault ? "Fault" : "OK"}</div></div></div>
    </div>`).join("");
  return `<h2>Water used in the root zone</h2><div class="card chart">${chart(hist)}</div>
    <h2>Probes (volumetric water content)</h2>${nodeCards || `<div class="card"><p class="small muted">No readings yet.</p></div>`}`;
}

function viewSettings(s) {
  const fs = (s && s.failsafe) || {};
  return `
  <h2>Connection</h2>
  <div class="card"><p class="small">${client ? (client.kind === "demo" ? "Demo mode: a recorded season, stored on this phone." : `Gateway: ${esc(client.base)}`) : "Not connected"}</p>
    <div class="actions two"><button class="btn" id="chgConn">Change gateway</button><button class="btn" id="toggleDemo">${cfg.mode === "demo" ? "Leave demo" : "Demo mode"}</button></div></div>
  <h2>Automatic safety watering</h2>
  <div class="card"><p class="small">If the gateway loses contact with the advisory service and the soil becomes very dry (${Math.round((fs.trigger_fraction_taw || 0.8) * 100)}% of the water it can hold is used), it can give ${num(fs.dose_mm || 25)} mm by itself, at most ${fs.max_events || 3} times and at least ${fs.min_interval_days || 3} days apart. This is the only way the pump can run without your approval of that day's advice, and it is off unless you switch it on.</p>
    <div class="row between"><strong>${fs.armed ? "On" : "Off"}</strong><button class="btn ${fs.armed ? "danger" : ""}" id="fsBtn">${fs.armed ? "Switch off" : "Switch on"}</button></div></div>
  <h2>About</h2>
  <div class="card small"><p><strong>Wheat Water</strong> 1.0 · M.Tech project (KTU).</p>
    <p class="muted">The advice comes from an FAO 56 water balance and a forecast. The app can approve, change or decline advice, answer questions and switch safety watering. It has no control that starts the pump directly.</p></div>`;
}

// ------------------------------------------------------------------ render
async function render() {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  if (!client) { view.innerHTML = viewConnect(); bind(); probeSameOrigin(); setLink("", "offline"); $("#farmLine").textContent = "Not connected"; return; }
  if (!view.innerHTML) view.innerHTML = `<div class="row" style="justify-content:center;padding:40px"><div class="spinner"></div></div>`;
  try {
    last = { ...(await client.status()), _reasons: last?._reasons };
    setLink(client.kind === "demo" ? "demo" : (last.link_ok === false ? "bad" : "ok"), client.kind === "demo" ? "demo" : (last.link_ok === false ? "no advisory" : "connected"));
    $("#farmLine").textContent = `${last.farm || "Farm"} · day ${last.day ?? "–"}`;
    const n = (last.pending || []).filter(c => c.action === "irrigate").length + (last.questions || []).length;
    const b = $("#adviceBadge"); b.hidden = !n; b.textContent = n;
    let html;
    if (tab === "home") html = viewHome(last);
    else if (tab === "advice") html = await viewAdvice(last);
    else if (tab === "history") html = await viewHistory();
    else if (tab === "sensors") html = await viewSensors();
    else html = viewSettings(last);
    view.innerHTML = html;
  } catch (e) {
    setLink("bad", "offline");
    if (e.status === 401) { view.innerHTML = viewConnect("The pairing code is wrong."); }
    else if (tab === "settings") view.innerHTML = viewSettings(last);
    else view.innerHTML = `<div class="card"><h3>Cannot load</h3><p class="small">${esc(e.message)}</p><div class="actions two"><button class="btn primary" id="retry">Try again</button><button class="btn" id="chgConn">Change gateway</button></div></div>`;
  }
  bind();
}

// When the gateway itself served this page, offer its address.
async function probeSameOrigin() {
  if (!location.protocol.startsWith("http") || window.Capacitor) return;
  try {
    const h = await new GatewayClient(location.origin).health();
    const u = $("#u"); if (h && h.ok && u && !u.value) u.value = location.origin;
  } catch { /* not served by a gateway */ }
}

function bind() {
  const cf = $("#connForm");
  if (cf) cf.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(cf);
    const c = new GatewayClient(fd.get("url"), fd.get("token"));
    try { await c.health(); await c.status(); cfg.url = c.base; cfg.token = fd.get("token"); cfg.mode = "gateway"; saveCfg(); client = c; toast("Connected"); view.innerHTML = ""; render(); }
    catch (e) { view.innerHTML = viewConnect(e.status === 401 ? "The pairing code is wrong." : e.message, fd.get("url")); bind(); }
  };
  const db = $("#demoBtn"); if (db) db.onclick = () => { cfg.mode = "demo"; saveCfg(); client = new DemoClient(); view.innerHTML = ""; render(); };
  view.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  view.querySelectorAll("[data-act]").forEach(b => b.onclick = () => decide(b.dataset.act, b.dataset.id));
  view.querySelectorAll(".qForm").forEach(f => {
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const fields = {}; for (const [k, v] of new FormData(f)) if (v !== "") fields[k] = isNaN(v) ? v : Number(v);
      if (!Object.keys(fields).length) { f.querySelector(".err").textContent = "Fill in at least one answer."; return; }
      try { const r = await client.answer(fields); if (r.rejected && r.rejected.length) f.querySelector(".err").textContent = "Not accepted: " + r.rejected.join("; "); else { toast("Thank you. The next advice will use this."); render(); } }
      catch (e) { f.querySelector(".err").textContent = e.message; }
    };
    const skip = f.querySelector("[data-skip]"); if (skip) skip.onclick = () => { f.closest(".card").remove(); };
  });
  const nd = $("#nextDay"); if (nd) nd.onclick = async () => { nd.disabled = true; try { await client.advance(); if (client.kind !== "demo") await client.sendReading(); } catch (e) { toast(e.message); } render(); };
  const sr = $("#sendReading"); if (sr) sr.onclick = async () => { try { await client.sendReading(); toast("Reading received"); } catch (e) { toast(e.message); } render(); };
  const na = $("#nextAdvice"); if (na) na.onclick = async () => { await client.nextAdvice(); render(); };
  const rd = $("#resetDemo"); if (rd) rd.onclick = () => { client.reset(); render(); };
  const rt = $("#retry"); if (rt) rt.onclick = () => render();
  const cc = $("#chgConn"); if (cc) cc.onclick = () => { cfg.mode = "gateway"; saveCfg(); client = null; view.innerHTML = viewConnect(); bind(); probeSameOrigin(); };
  const td = $("#toggleDemo"); if (td) td.onclick = () => { cfg.mode = cfg.mode === "demo" ? "gateway" : "demo"; saveCfg(); client = makeClient(); go("home"); };
  const fb = $("#fsBtn"); if (fb) fb.onclick = () => failsafe();
}

async function decide(act, id) {
  if (busy) return;
  const c = (last.pending || []).find(x => x.advisory_id === id); if (!c) return;
  let res;
  if (act === "approve") {
    res = await dialog(`<h3>Approve ${num(c.quantity_mm)} mm?</h3>
      <p>The gateway will run the pump for about <strong>${num(c.pump_minutes)} minutes</strong> in zone ${esc(c.zone)}.</p>
      <p class="small muted">It works out the exact time itself from the amount and its pump calibration.</p><p class="err small" style="color:var(--red)"></p>
      <div class="actions two"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Approve</button></div>`,
      () => client.dispose(id, "approve"));
  } else if (act === "modify") {
    res = await dialog(`<h3>Change the amount</h3><label for="mm">Amount to apply (mm)</label>
      <input id="mm" name="mm" type="number" min="1" max="${esc(c.max_event_mm)}" step="1" value="${num(c.quantity_mm)}" required inputmode="numeric">
      <p class="tiny muted">Most allowed for one irrigation on this farm: ${num(c.max_event_mm)} mm.</p>
      <label for="why">Why? (optional)</label><select id="why" name="why"><option value="">–</option><option value="labour">Not enough time or labour</option><option value="no_power">Electricity will not last</option><option value="other">Other</option></select>
      <p class="err small" style="color:var(--red)"></p>
      <div class="actions two"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Approve new amount</button></div>`,
      (fd) => { const mm = Number(fd.get("mm")); if (!(mm > 0 && mm <= c.max_event_mm)) throw new Error(`Enter 1 to ${c.max_event_mm} mm`); return client.dispose(id, "modify", mm, fd.get("why") || null); });
  } else if (act === "reject") {
    const reasons = last._reasons || { no_water: "No water in the channel today", no_power: "No electricity at that time", rain_expected: "I expect rain", field_too_wet: "Field is already wet", labour: "No one available to irrigate", other: "Other" };
    res = await dialog(`<h3>Not today</h3><p class="small">Tell the advisor why. After the same reason three times, it adjusts.</p>
      ${Object.entries(reasons).map(([k, v], i) => `<label class="row" style="font-weight:500;gap:10px"><input type="radio" name="r" value="${esc(k)}" ${i === 0 ? "checked" : ""} style="width:22px;height:22px">${esc(v)}</label>`).join("")}
      <p class="err small" style="color:var(--red)"></p>
      <div class="actions two"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Send</button></div>`,
      (fd) => client.dispose(id, "reject", null, fd.get("r")));
  } else {
    busy = true; try { res = await client.dispose(id, "acknowledge"); } catch (e) { toast(e.message); } busy = false;
  }
  if (res) {
    if (res.commanded) toast(`Approved. Pump run recorded: ${num(res.volume_mm)} mm, about ${num(res.run_minutes)} min.`, 5000);
    else if (act === "reject") toast("Declined. Nothing will run.");
    else if (act !== "acknowledge") toast(res.why ? `Recorded. The pump did not run: ${res.why}` : "Recorded.");
    render();
  }
}

async function failsafe() {
  const armed = last?.failsafe?.armed;
  if (armed) { try { await client.setFailsafe(false); toast("Safety watering is off."); } catch (e) { toast(e.message); } return render(); }
  const r = await dialog(`<h3>Switch on safety watering?</h3>
    <p class="small">When contact is lost and the soil is very dry, the gateway may irrigate <strong>without asking you that day</strong>, at most ${last?.failsafe?.max_events ?? 3} times.</p>
    <label for="c">Type ARM to confirm</label><input id="c" name="c" type="text" autocomplete="off" autocapitalize="characters">
    <p class="err small" style="color:var(--red)"></p>
    <div class="actions two"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Switch on</button></div>`,
    (fd) => client.setFailsafe(true, String(fd.get("c") || "").trim().toUpperCase()));
  if (r) toast("Safety watering is on."); render();
}

function go(t) { tab = t; view.innerHTML = ""; render(); window.scrollTo(0, 0); }
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => go(b.dataset.tab));

client = makeClient();
render();
setInterval(() => { if (client && document.visibilityState === "visible" && !$("#dlg").open && (tab === "home")) render(); }, 60000);

if ("serviceWorker" in navigator && window.isSecureContext && !window.Capacitor) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
