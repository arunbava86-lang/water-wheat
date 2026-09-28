"""UI test of remote access: pair on the farm Wi-Fi, then decide through the internet relay."""
import json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
GW = Path("/home/claude/revise/decisioncore"); TMP = Path(tempfile.mkdtemp())
procs = [subprocess.Popen([sys.executable, "-m", "uvicorn", "relay:app", "--app-dir", str(GW / "deploy"), "--port", "8090", "--log-level", "warning"],
                          env={**os.environ, "RELAY_DB": str(TMP / "r.db")})]
procs.append(subprocess.Popen([sys.executable, "app_server.py"], cwd=GW / "gateway",
             env={**os.environ, "GATEWAY_SIM": "1", "GATEWAY_TOKEN": "123456", "GATEWAY_DB": str(TMP / "g.db"), "PORT": "8000",
                  "APP_WWW": "/home/claude/mobile/www", "RELAY_URL": "http://127.0.0.1:8090", "FARM_ID": "farm-ui", "RELAY_POLL_S": "3"},
             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
time.sleep(7)
BASE = "http://localhost:8000"; OUT = "/home/claude/mobile/shots/"; ok = []; errs = []
def check(n, c, d=""): ok.append(bool(c)); print(("PASS " if c else "FAIL ") + n + ("" if c else f" [{d}]"))
def api(path, method="GET", body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"x-gateway-token": "123456", "content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE + "/"); pg.wait_for_function("document.querySelector('#u') && document.querySelector('#u').value !== ''", timeout=15000)
        pg.fill("#t", "123456"); pg.click("#connForm button[type=submit]"); pg.wait_for_selector("text=Root-zone water")
        pg.click("[data-tab=settings]"); pg.wait_for_selector("#pairBtn"); pg.click("#pairBtn")
        pg.wait_for_selector("#useNet", timeout=15000)
        check("phone paired on the farm Wi-Fi", len(api("/api/devices")) == 1)
        pg.screenshot(path=OUT + "12_paired.png", full_page=True)
        api("/api/answers", "POST", {"fields": {"water_source": "canal", "canal_interval_days": 7, "canal_next_day": 2, "area_ha": 0.2, "pump_flow_lpm": 600, "tariff_per_hour": 40}})
        for _ in range(200):
            api("/api/sim/advance?days=1", "POST", {}); s = api("/api/status")
            if s["pending"] and s["pending"][0]["action"] == "irrigate": break
        aid = s["pending"][0]["advisory_id"]; time.sleep(5)          # let the gateway report to the relay
        # leave the farm: the saved Wi-Fi address no longer answers
        pg.evaluate("""() => { const c = JSON.parse(localStorage.getItem('wheat-water-config')); c.url = 'http://10.255.255.1:8000'; localStorage.setItem('wheat-water-config', JSON.stringify(c)); }""")
        pg.reload(); pg.wait_for_selector("text=via internet", timeout=40000)
        check("off the farm Wi-Fi, the app switches to the internet by itself", pg.is_visible("text=via internet"))
        pg.wait_for_selector("text=Today's advice", timeout=20000)
        check("advice visible through the relay", "Irrigate" in pg.inner_text(".hero"))
        pg.screenshot(path=OUT + "13_remote_home.png")
        n0 = len(api("/api/commands"))
        pg.click("[data-go=advice]"); pg.wait_for_selector("[data-act=approve]"); pg.click("[data-act=approve]")
        pg.wait_for_selector("dialog[open]"); pg.click("dialog button[value=ok]")
        pg.wait_for_function("document.querySelector('#toast').textContent.includes('Pump run') || document.querySelector('#toast').textContent.includes('Sent') || document.querySelector('#toast').textContent.includes('refused')", timeout=60000); t = pg.inner_text("#toast")
        check("remote approval confirmed on the phone", "Pump run recorded" in t, t)
        cm = api("/api/commands")
        check("gateway ran exactly one command for that advisory", len(cm) == n0 + 1 and cm[0]["advisory_id"] == aid, cm[:1])
        ev = [e for e in api("/api/events?limit=50") if e["kind"] == "remote_message_applied"]
        check("gateway log records the remote, signed decision", len(ev) >= 1)
        pg.screenshot(path=OUT + "14_remote_approved.png")
        b.close()
    check("no JavaScript exceptions", not errs, errs[:2])
finally:
    for pr in procs: pr.terminate()
print(f"\n{sum(ok)} of {len(ok)} remote UI checks passed")
