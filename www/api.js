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

// --------------------------------------------------------------------------
// Remote access through the cloud relay (deploy/relay.py).
// The phone holds a P-256 signing key created on the phone and never exported.
// Every decision sent through the relay is signed with it; the gateway checks
// the signature, freshness and nonce before applying it, so the relay can
// carry a decision but can never make or change one.

const KEYDB = "wheat-water-keys";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(KEYDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction("keys").objectStore("keys").get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
async function idbPut(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction("keys", "readwrite").objectStore("keys").put(v, k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }

export function remoteSupported() { return !!(window.isSecureContext && window.crypto && crypto.subtle && window.indexedDB); }

export async function deviceKey() {
  let k = await idbGet("device");
  if (!k) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
    k = { privateKey: pair.privateKey, jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
    await idbPut("device", k);
  }
  return k;
}

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function nonce() { const a = new Uint8Array(16); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(2, "0")).join(""); }

export async function pairWithGateway(gatewayClient, deviceName) {
  const k = await deviceKey();
  return gatewayClient.post("/api/pair", { public_key: k.jwk, device_name: deviceName || "Farmer phone" });
}

export class RelayClient {
  constructor(remote) {
    this.r = remote; this.kind = "internet";
    this.base = remote.relay_url.replace(/\/+$/, "") + "/relay/" + encodeURIComponent(remote.farm_id);
    this.snap = null;
  }
  _h(json) { const h = { "x-farm-token": this.r.farm_token }; if (json) h["content-type"] = "application/json"; return h; }
  async _snapshot(force) {
    if (!this.snap || force || Date.now() - this._t > 5000) {
      const s = await fetchJSON(this.base + "/snapshot", { headers: this._h(false) });
      if (!s.snapshot) throw new Error("The gateway has not reported to the internet relay yet.");
      this.snap = s.snapshot; this._t = Date.now(); this.updated = s.updated;
    }
    return this.snap;
  }
  async health() { const s = await this._snapshot(true); return { ok: true, farm: s.status.farm, day: s.status.day }; }
  async status() { const s = await this._snapshot(true); return { ...s.status, via: "internet", snapshot_time: this.updated }; }
  async questions() { return (await this._snapshot()).questions; }
  async advisories() { return (await this._snapshot()).advisories; }
  async commands() { return (await this._snapshot()).commands; }
  async events() { return (await this._snapshot()).events; }
  async history() { return (await this._snapshot()).history; }
  async readings() { return (await this._snapshot()).readings; }
  async profile() { return {}; }
  async _send(kind, body, advisory_id) {
    const k = await deviceKey();
    const payload = JSON.stringify({ v: 1, farm_id: this.r.farm_id, kind, advisory_id: advisory_id || null, body, nonce: nonce(), ts: new Date().toISOString() });
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, new TextEncoder().encode(payload));
    const m = await fetchJSON(this.base + "/messages", { method: "POST", headers: this._h(true), body: JSON.stringify({ payload, sig: b64u(sig), key_id: this.r.key_id }) });
    // Wait for the gateway to collect and apply it (it checks in every ~20 s).
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const st = await fetchJSON(this.base + "/messages/" + m.id, { headers: this._h(false) });
      if (st.status === "applied") { this.snap = null; return st.result; }
      if (st.status === "rejected") { const e = new Error("The gateway refused it: " + (st.result && st.result.why || "unknown reason")); e.status = 422; throw e; }
    }
    return { queued: true };
  }
  dispose(id, disposition, modified_mm, reason_code) {
    const b = { disposition }; if (modified_mm != null) b.modified_mm = modified_mm; if (reason_code) b.reason_code = reason_code;
    return this._send("disposition", b, id);
  }
  answer(fields) { return this._send("answers", fields); }
  setFailsafe(armed, confirm) { const b = { armed }; if (confirm) b.confirm = confirm; return this._send("failsafe", b); }
  advance() { throw new Error("Only available on the farm Wi-Fi."); }
  sendReading() { throw new Error("Only available on the farm Wi-Fi."); }
}
