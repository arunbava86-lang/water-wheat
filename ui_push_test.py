"""
End-to-end test of notifications in the app, against the real gateway API
(simulation) and advisory service. Android's push plugin is replaced by a
stand-in injected into the page (window.Capacitor), because Firebase and a
phone are not reachable from this workspace. What is tested is everything on
our side of that plugin:
  - the Notifications card, the permission request and its refusal;
  - the token reaching the gateway (/api/push/register) exactly once;
  - an irrigate advisory producing a logged notice with its advisory id;
  - tapping a notice opening the advice screen, and approval still needing
    the button on the card;
  - switching off unregistering the token.
Run with the gateway on :8000 (GATEWAY_SIM=1 GATEWAY_TOKEN=123456) and the
advisory service on :8080.
"""
import json
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8000"; TOK = "123456"; OUT = "/home/claude/mobile/shots/"
ok, errs = [], []


def check(n, c, d=""):
    ok.append(bool(c)); print(("PASS " if c else "FAIL ") + n + ("" if c else f" [{d}]"))


def api(path, method="GET", body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=(json.dumps(body).encode() if body is not None else None),
                                 headers={"x-gateway-token": TOK, "content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())


MOCK = """
window.__push = { perm: window.__permAnswer || 'granted', listeners: {}, registered: 0, unregistered: 0 };
window.Capacitor = {
  isNativePlatform: () => true,
  Plugins: { PushNotifications: {
    checkPermissions: async () => ({ receive: 'prompt' }),
    requestPermissions: async () => ({ receive: window.__push.perm }),
    addListener: (ev, fn) => { (window.__push.listeners[ev] ||= []).push(fn); return { remove(){} }; },
    register: async () => { window.__push.registered++;
      setTimeout(() => (window.__push.listeners.registration || []).forEach(f => f({ value: 'fcm-token-' + 'x'.repeat(40) })), 50); },
    unregister: async () => { window.__push.unregistered++; },
  } },
};
window.__fire = (ev, payload) => (window.__push.listeners[ev] || []).forEach(f => f(payload));
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    # 1. an ordinary browser page: no plugin, so the card says so
    pg0 = b.new_page(); pg0.goto(BASE + "/")
    pg0.evaluate(f"localStorage.setItem('wheat-water-config', JSON.stringify({{url: '{BASE}', token: '{TOK}', mode: 'gateway'}}))")
    pg0.reload(); pg0.wait_for_selector("text=Root-zone water"); pg0.click(".tabs button[data-tab=settings]")
    pg0.wait_for_selector("text=Notifications")
    check("browser page: notifications explained as app-only", "installed Android app only" in pg0.inner_text("#view"))
    pg0.close()

    # 2. permission refused
    ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script("window.__permAnswer = 'denied';" + MOCK)
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/")
    pg.evaluate(f"localStorage.setItem('wheat-water-config', JSON.stringify({{url: '{BASE}', token: '{TOK}', mode: 'gateway'}}))")
    pg.reload(); pg.wait_for_selector("text=Root-zone water"); pg.click(".tabs button[data-tab=settings]")
    pg.wait_for_selector("#pushBtn"); pg.click("#pushBtn"); pg.wait_for_timeout(400)
    check("refused permission: the farmer is told where to allow it", "Android Settings" in pg.inner_text("#toast"))
    check("refused permission: nothing registered with the gateway", api("/api/push")["phones"] == 0)
    ctx.close()

    # 3. permission granted
    ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(MOCK)
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/")
    pg.evaluate(f"localStorage.setItem('wheat-water-config', JSON.stringify({{url: '{BASE}', token: '{TOK}', mode: 'gateway'}}))")
    pg.reload(); pg.wait_for_selector("text=Root-zone water"); pg.click(".tabs button[data-tab=settings]")
    pg.wait_for_selector("#pushBtn")
    txt = pg.inner_text("#view")
    check("card states that a notice only asks you to look", "Approving still happens here" in txt)
    check("card warns when the gateway has no Firebase key", "no Firebase key yet" in txt)
    pg.click("#pushBtn"); pg.wait_for_timeout(800)
    info = api("/api/push")
    check("switching on registers one phone with the gateway", info["phones"] == 1, str(info))
    check("card now shows On", "Switch off" in pg.inner_text("#pushBtn"))
    pg.screenshot(path=OUT + "push_01_settings_on.png", full_page=True)
    pg.reload(); pg.wait_for_timeout(1200)
    check("restarting the app re-registers without a second gateway entry",
          pg.evaluate("window.__push.registered") >= 1 and api("/api/push")["phones"] == 1)

    # an irrigate advisory produces a logged notice
    api("/api/answers", "POST", {"fields": {"water_source": "tubewell", "area_ha": 0.2, "pump_flow_lpm": 600}})
    card = None
    for _ in range(250):
        api("/api/sim/advance?days=1", "POST", {})
        s = api("/api/status")
        if s["pending"] and s["pending"][0]["action"] == "irrigate":
            card = s["pending"][0]; break
    log = api("/api/push")["log"]
    hit = [x for x in log if card and x["advisory_id"] == card["advisory_id"]]
    check("an irrigate advisory is logged as a notice with its id", bool(hit), str(log[:2]))
    check("the notice text states the approval gate", bool(hit) and "until you approve" in hit[0]["body"])
    n_cmd = len(api("/api/commands"))
    # the phone receives it in the foreground, then the farmer taps it
    pg.evaluate("window.__fire('pushNotificationReceived', {title: 'Irrigation advice', body: 'x'})"); pg.wait_for_timeout(600)
    check("a notice in the foreground shows a toast", "Irrigation advice" in pg.inner_text("#toast"))
    pg.evaluate(f"window.__fire('pushNotificationActionPerformed', {{notification: {{data: {{kind: 'advisory', advisory_id: '{card['advisory_id']}'}}}}}})")
    pg.wait_for_selector("[data-act=approve]", timeout=8000)
    check("tapping the notice opens the advice with its approve button", pg.is_visible("[data-act=approve]"))
    check("tapping the notice ran nothing", len(api("/api/commands")) == n_cmd)
    pg.screenshot(path=OUT + "push_02_opened_advice.png", full_page=True)

    # switching off
    pg.click(".tabs button[data-tab=settings]"); pg.wait_for_selector("#pushBtn"); pg.click("#pushBtn"); pg.wait_for_timeout(600)
    check("switching off unregisters at the gateway and on the phone",
          api("/api/push")["phones"] == 0 and pg.evaluate("window.__push.unregistered") == 1)
    ctx.close(); b.close()

check("no JavaScript errors", not errs, str(errs[:3]))
print(f"\n{sum(ok)} of {len(ok)} checks passed")
