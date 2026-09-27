// Two clients with the same interface:
//   GatewayClient - talks to the gateway's HTTP API (gateway/app_server.py)
//   DemoClient    - replays a season recorded from the real gateway and advisory
//                   service (demo_season.json); nothing in it is invented here.
//
// Neither client has a method that commands a pump. The only write that can
// lead to irrigation is dispose(), which records the farmer's decision; the
// gateway's controller then works out the run time on its own.

const TIMEOUT_MS = 12000;

async function fetchJSON(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { detail: text }; }
    if (!r.ok) {
      const msg = body && body.detail ? (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)) : `HTTP ${r.status}`;
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return body;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("The gateway did not answer in time.");
    if (e instanceof TypeError) throw new Error("Cannot reach the gateway. Check that the phone is on the farm Wi-Fi and the address is right.");
    throw e;
  } finally { clearTimeout(t); }
}

export class GatewayClient {
  constructor(baseUrl, token) {
    this.base = (baseUrl || "").replace(/\/+$/, "");
    this.token = token || "";
    this.kind = "gateway";
  }
  _h(json) {
    const h = {};
    if (this.token) h["x-gateway-token"] = this.token;
    if (json) h["content-type"] = "application/json";
    return h;
  }
  get(path) { return fetchJSON(this.base + path, { headers: this._h(false) }); }
  post(path, body) {
    return fetchJSON(this.base + path, { method: "POST", headers: this._h(true), body: JSON.stringify(body || {}) });
  }
  health() { return this.get("/api/health"); }
  status() { return this.get("/api/status"); }
  questions() { return this.get("/api/questions"); }
  advisories() { return this.get("/api/advisories?limit=60"); }
  commands() { return this.get("/api/commands"); }
  events() { return this.get("/api/events?limit=80"); }
  history() { return this.get("/api/history?limit=120"); }
  readings() { return this.get("/api/readings?limit=48"); }
  profile() { return this.get("/api/profile"); }
  dispose(id, disposition, modified_mm, reason_code) {
    const b = { disposition };
    if (modified_mm != null) b.modified_mm = modified_mm;
    if (reason_code) b.reason_code = reason_code;
    return this.post(`/api/advisories/${encodeURIComponent(id)}/disposition`, b);
  }
  answer(fields) { return this.post("/api/answers", { fields }); }
  setFailsafe(armed, confirm) { return this.post("/api/failsafe", { armed, confirm }); }
  advance() { return this.post("/api/sim/advance?days=1", {}); }
  sendReading() { return this.post("/api/sim/reading", {}); }
}

// --------------------------------------------------------------------------
// Demo: a recorded season. Each day holds the status the real gateway served
// that day. Decisions made here are kept on the phone only.
const DEMO_KEY = "wheat-demo-v1";

function loadLocal() {
  try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || null; } catch { return null; }
}
function saveLocal(s) { try { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); } catch { /* private mode */ } }

export class DemoClient {
  constructor() { this.kind = "demo"; this.data = null; this.s = loadLocal() || { i: 0, decided: {}, answers: {}, failsafe: false, events: [] }; }
  async _load() {
    if (!this.data) {
      const r = await fetch("demo_season.json");
      this.data = await r.json();
    }
    return this.data;
  }
  _day() { return this.data.days[Math.min(this.s.i, this.data.days.length - 1)]; }
  _event(kind, detail) { this.s.events.unshift({ ts: new Date().toISOString(), kind, detail }); this.s.events = this.s.events.slice(0, 200); saveLocal(this.s); }
  async health() { await this._load(); return { ok: true, version: "demo", sim: true, farm: this.data.farm, pairing_required: false, day: this._day().day }; }
  async status() {
    await this._load();
    const d = structuredClone(this._day());
    d.pending = (d.pending || []).filter(c => !this.s.decided[c.advisory_id]);
    d.questions = this.s.answeredAll ? [] : (d.questions || []);
    d.failsafe = { ...(d.failsafe || {}), armed: this.s.failsafe };
    d.farm = this.data.farm; d.sim = true; d.demo = true;
    return d;
  }
  async questions() { await this._load(); const d = this._day(); return { questions: this.s.answeredAll ? [] : (d.questions_ui || []), reasons: this.data.reasons }; }
  async advisories() {
    await this._load();
    const out = [];
    for (let k = this.s.i; k >= 0; k--) {
      for (const c of (this.data.days[k].pending || [])) {
        const dec = this.s.decided[c.advisory_id];
        out.push({ advisory_id: c.advisory_id, day: c.day, action: c.action, quantity_mm: c.quantity_mm, rationale: c.rationale,
          disposition: dec ? dec.disposition : (k < this.s.i ? "superseded" : null), modified_mm: dec ? dec.modified_mm : null, reason_code: dec ? dec.reason_code : null });
      }
    }
    return out;
  }
  async commands() {
    await this._load();
    return Object.entries(this.s.decided).filter(([, d]) => d.commanded).map(([id, d]) => ({ ts: d.ts, advisory_id: id, zone: 1, volume_mm: d.volume_mm, origin: "approved_advisory", run_minutes: d.run_minutes })).reverse();
  }
  async events() { return this.s.events; }
  async history() { await this._load(); return this.data.days.slice(0, this.s.i + 1).map(d => d.state).filter(Boolean); }
  async readings() { await this._load(); return this._day().nodes || []; }
  async profile() { return { ...this.s.answers }; }
  async dispose(id, disposition, modified_mm, reason_code) {
    await this._load();
    const c = (this._day().pending || []).find(x => x.advisory_id === id);
    if (!c || this.s.decided[id]) { const e = new Error("no such pending advisory"); e.status = 404; throw e; }
    if (disposition === "modify" && (!(modified_mm > 0) || modified_mm > c.max_event_mm)) { const e = new Error(`Amount must be between 1 and ${c.max_event_mm} mm`); e.status = 422; throw e; }
    const irrigate = c.action === "irrigate" && (disposition === "approve" || disposition === "modify");
    const vol = disposition === "modify" ? modified_mm : c.quantity_mm;
    // Same arithmetic as the gateway controller: 600 L/min over 2000 m2.
    const minutes = irrigate ? Math.round(vol * 2000 / 600 * 10) / 10 : null;
    this.s.decided[id] = { disposition, modified_mm, reason_code, commanded: irrigate, volume_mm: vol, run_minutes: minutes, ts: new Date().toISOString() };
    this._event(irrigate ? "pump_run_recorded" : "no_command", `${disposition} ${id}`);
    saveLocal(this.s);
    return { ok: true, commanded: irrigate, run_minutes: minutes, volume_mm: vol, disposition };
  }
  async answer(fields) { this.s.answers = { ...this.s.answers, ...fields }; this.s.answeredAll = true; this._event("question_answered", JSON.stringify(fields)); saveLocal(this.s); return { accepted: fields, rejected: [] }; }
  async setFailsafe(armed, confirm) {
    if (armed && confirm !== "ARM") { const e = new Error("Type ARM to confirm"); e.status = 422; throw e; }
    this.s.failsafe = armed; this._event(armed ? "failsafe_armed" : "failsafe_disarmed", "demo"); saveLocal(this.s); return { armed };
  }
  async advance() { await this._load(); if (this.s.i < this.data.days.length - 1) this.s.i += 1; saveLocal(this.s); return { day: this._day().day }; }
  async sendReading() { return {}; }
  async nextAdvice() {
    await this._load();
    while (this.s.i < this.data.days.length - 1) {
      this.s.i += 1;
      if ((this._day().pending || []).some(c => c.action === "irrigate")) break;
    }
    saveLocal(this.s); return { day: this._day().day };
  }
  reset() { this.s = { i: 0, decided: {}, answers: {}, failsafe: false, events: [] }; saveLocal(this.s); }
}
