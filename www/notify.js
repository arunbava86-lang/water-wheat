// Push notifications in the installed Android app (Firebase Cloud Messaging,
// through the @capacitor/push-notifications plugin).
//
// A notification only says "something needs a look": new irrigation advice, a
// question, no advice today, or the safety watering having run. Tapping it
// opens the app. It has no buttons and cannot approve anything; approving
// still happens on the advice card, as before.
//
// In a browser page (not the installed app) there are no notifications.

const plugin = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
  && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications) || null;

export function pushSupported() { return !!plugin(); }

let wired = false;

// handlers: { client(), cfg, saveCfg(), onOpen(data), onForeground(notification), onError(msg) }
function wire(h) {
  const PN = plugin(); if (!PN || wired) return; wired = true;
  PN.addListener("registration", async (t) => {
    const token = t && t.value; if (!token) return;
    h.cfg.push = { ...(h.cfg.push || {}), on: true, token }; h.saveCfg();
    const c = h.client();
    if (!c || c.kind === "demo") return;
    if (h.cfg.push.sent === token + "@" + (c.base || c.kind)) return;       // already told this gateway
    try {
      await c.pushToken(token, h.cfg.remote && h.cfg.remote.key_id, "Farmer phone");
      h.cfg.push.sent = token + "@" + (c.base || c.kind); h.saveCfg();
    } catch (e) { h.onError("The gateway did not accept the notification token: " + e.message); }
  });
  PN.addListener("registrationError", (e) => h.onError("Notifications could not start: " + ((e && e.error) || "unknown error")));
  PN.addListener("pushNotificationReceived", (n) => h.onForeground(n || {}));
  PN.addListener("pushNotificationActionPerformed", (a) => h.onOpen((a && a.notification && a.notification.data) || {}));
}

export async function enablePush(h) {
  const PN = plugin(); if (!PN) throw new Error("Notifications work in the installed Android app only.");
  let p = await PN.checkPermissions();
  if (p.receive === "prompt" || p.receive === "prompt-with-rationale") p = await PN.requestPermissions();
  if (p.receive !== "granted") throw new Error("Notifications are blocked. Allow them in Android Settings > Apps > Wheat Water > Notifications.");
  h.cfg.push = { ...(h.cfg.push || {}), on: true }; h.saveCfg();   // the farmer's choice, before the token arrives
  wire(h);
  await PN.register();                  // the token arrives in the "registration" listener
}

export async function disablePush(h) {
  const PN = plugin();
  const token = h.cfg.push && h.cfg.push.token;
  const c = h.client();
  if (token && c && c.kind !== "demo") await c.pushOff(token);   // throws off the farm Wi-Fi, by design
  if (PN) { try { await PN.unregister(); } catch { /* already off */ } }
  h.cfg.push = { on: false }; h.saveCfg();
}

// On every start: if the farmer switched notifications on, re-register (tokens can change).
export async function resumePush(h) {
  if (!(h.cfg.push && h.cfg.push.on) || !plugin()) return;
  try { wire(h); await plugin().register(); } catch (e) { h.onError(e.message); }
}
