# Wheat Water: the farmer's Android app

This is the farmer's app for the low-cost IoT and ML wheat irrigation system. It shows the day's advice, the field state and the sensors. The farmer can approve, change or decline each piece of advice.

**It has no button that starts the pump.** The gateway runs the pump only after the farmer approves an advisory. It then works out the run time itself from the approved amount.

## What is in this folder

| Path | What it is |
|---|---|
| `www/` | The app itself (HTML, CSS and JavaScript, with no framework). The same files run as a web app and inside the APK. |
| `www/demo_season.json` | A season recorded from the real gateway and advisory service, used by demo mode. |
| `android/` | The Android project (Capacitor 7). |
| `.github/workflows/android.yml` | Builds the APK on GitHub's servers. |
| `ui_test.py` | End-to-end test in a phone-sized browser: 25 checks (6 for the "why?" chat and rain line). |
| `www/notify.js` | Notifications (Firebase Cloud Messaging) in the installed app. |
| `ui_push_test.py` | End-to-end test of notifications with a stand-in for Android's push plugin: 15 checks. |

The gateway side is `decisioncore/gateway/app_server.py`, with 42 API tests in `test_app_server.py` and 44 unit tests for rain and "why?" in `test_rain_why.py`.

## 1. Run it on your laptop (emulated gateway)

```bash
pip install fastapi uvicorn langgraph joblib scikit-learn pandas
cd decisioncore/gateway
./run_app_emulation.sh          # prints the address and the pairing code (123456)
```

1. Put the phone on the same Wi-Fi as the laptop.
2. Open the printed address in Chrome, for example `http://192.168.1.20:8000`.
3. Enter the pairing code.
4. Press **Next day** to step through the replayed season.

If the phone cannot connect, allow port 8000 through the laptop's firewall.

## 2. Use it as a web app (no APK)

In Chrome on the phone, open the gateway address and choose **⋮ → Add to Home screen**.

The gateway serves plain HTTP on the farm Wi-Fi. Chrome therefore adds a shortcut rather than a full offline install. The app still works fully while the phone is on that Wi-Fi.

## 3. Get the APK from GitHub (recommended)

You need a free GitHub account. Do this once, from a computer.

1. On github.com, choose **New repository**, name it `wheat-water`, keep it **Private**, and create it.
2. Choose **uploading an existing file** and drag in *everything inside this `mobile` folder*. Include `.github`, which is hidden on some computers.
   - Do **not** upload `node_modules`.
3. Commit. Then open the **Actions** tab. The *Build Android APK* run takes about 5–8 minutes.
4. Open the finished run and download **wheat-water-apk**. Unzip it to get `app-debug.apk`.
5. Copy the APK to the phone and open it. Android will ask you to allow installing from this source. Allow it for this one install.

This is a *debug* build, signed with a development key. That is fine for a demo and the viva. A Play Store release needs a release key, which is not set up.

## 4. Or build the APK in Android Studio

1. Install Node 22 and Android Studio (it includes the SDK and JDK 21).
2. In this folder, run `npm install` and then `npx cap sync android`.
3. Open the `android` folder in Android Studio.
4. Choose **Build → Build APK(s)**.

## 5. Demo mode

On the first screen, choose **Try demo** to use the app with no gateway. It replays a season recorded from the real gateway and advisory service. That service used the template narrator and the three-page test corpus, and the canal schedule was answered on day 5.

In demo mode, your decisions are stored on the phone only. They do not change later advice.

## Remote access (the farmer away from the gateway)

The gateway already needs the internet to fetch advice, so the same connection lets the farmer decide from anywhere. No extra hardware is needed.

1. **Pair once, on the farm Wi-Fi.** Go to Settings, then Remote access, then **Pair this phone**.
   - The phone creates a signing key that never leaves it.
   - The gateway stores the matching public key.
2. **The gateway reports to a cloud relay** (`decisioncore/deploy/relay.py`), which acts as a mailbox.
   - The gateway uploads the day's status every 20 s and collects the phone's messages.
   - It only makes outgoing connections; nothing on the internet can open a connection to it.
3. **Away from the farm,** the app switches to the internet by itself. It shows the same advice.
4. **Every approval, change, decline, answer or fail-safe switch is signed by the phone.** The gateway applies it only if:
   - the signature matches a paired phone, and the message was not altered;
   - it is for this farm;
   - it is fresh (under 6 hours old) and has never been seen before, so it cannot be replayed;
   - it passes the same rules as on the farm Wi-Fi (pending advisory, the 60 mm cap, a reason code, typing ARM).

The relay can therefore *carry* a decision but can never make or change one. A lost phone can be revoked on the gateway. If the relay or the internet is down, approval on the farm Wi-Fi still works.

Push notifications ("new advice") are not added yet. They need a Firebase project on your Google account. For now, the app checks for new advice whenever it is opened.

## "Why?" questions, rain and the forecaster (added 28 Sep)

- **Why? button.** Each advice card has a **Why? Ask about this advice** button. It offers seven questions: why today, why this amount, what if I wait, what about rain, how sure is this, where does this come from, and what happens when I approve.
  - The gateway builds the answers from the advice's own numbers (`decisioncore/gateway/why.py`). A test checks that every number in an answer comes from those facts.
  - They work on the farm Wi-Fi, through the internet relay and in demo mode.
  - A typed question is matched to one of the seven by keywords. Anything else gets "I can only answer questions about this advice". There is no language model in the app.
  - Asking never changes the advice, and no new API route was added.
- **Rain.** The card shows the rain forecast for the 24 hours the advice covers. In the emulation and the demo the forecast is *simulated* from the replayed record and says so. On a real gateway, set `RAIN_SOURCE=open-meteo`, `FARM_LAT` and `FARM_LON`.
  - Rain can only turn "irrigate" into "wait". It does so only when enough rain is forecast at more than a 91% chance, the point at which, at the thesis's 10:1 costs, waiting becomes cheaper.
- **Forecaster.** The gateway now loads the forecaster chosen on validation data for its region (`GATEWAY_REGION=scan` or `india`). In both regions that is the plain FAO 56 step: today's depletion plus one day of crop water use. It beat all 67 learned models once they could see today's depletion. Settings → the status shows which forecaster is running and what it was tested on.
- **Demo.** The demo season is now a replayed Punjab test season (India data, template narrator).

**For GitHub:** replace `www/app.js`, `www/styles.css`, `www/sw.js` and `www/demo_season.json`. `Upload-to-GitHub.zip` holds just those files.

## Notifications (added 28 Sep)

The gateway can tell the phone that something needs a look: new irrigation
advice, a question, no advice today (once per outage), or safety watering having
run. A plain "wait" day sends nothing. Tapping a notification opens the advice.

**What a notification cannot do.** It has no buttons and carries only its text,
the kind of notice and the advisory id. It cannot approve anything: approving
still happens on the advice card, on the farm Wi-Fi or signed by this phone
through the relay. A lost, late or fake notification changes nothing on the
farm. Every number in the text comes from the advice, and the gateway refuses
to send text that tells the farmer to operate equipment
(`decisioncore/gateway/push.py`, 51 tests in `test_push.py`).

**Set-up (once).**
1. In the Firebase console, create a project and add an **Android app** with
   the package name `in.ktu.mtech.wheatwater`. Download
   **`google-services.json`** and put it in `android/app/` (on GitHub: upload it
   into that folder). The GitHub build then includes notifications; without it
   the APK still works, with no notifications, and the build log says so.
2. In **Project settings > Service accounts**, choose **Generate new private
   key**. Save the file as
   `decisioncore/gateway/firebase-service-account.json` on the computer that
   runs the gateway. **This file is a secret.** It is excluded from Git; never
   upload it or send it to anyone. Without it the gateway only logs notices.
3. In the app: **Settings > Notifications > Switch on**, and allow
   notifications when Android asks.

## What the app can and cannot do

The app can **read** the following from the gateway:
- field state (depletion, trigger and tomorrow's forecast);
- sensor readings;
- advice, with the pump time and cost the gateway computes;
- questions from the advisor;
- pump runs and the event log.

The app can **write** only these:
1. **Approve, change or decline an advisory.**
   - A changed amount is capped at the farm's per-event maximum (60 mm).
   - A decline needs a reason. After three of the same reason, the farm profile is updated.
2. **Answer the advisor's questions.** The gateway checks each answer against its bounds. It rejects an out-of-range value rather than clipping it.
3. **Switch automatic safety watering on or off.**
   - This is the bounded fail-safe.
   - Switching it on needs the farmer to type `ARM`.
   - It is off by default.
4. **Simulation only:** step to the next day and send a simulated sensor packet.
5. **Register or remove a notification token.** It only tells the gateway where to send notices.

The tests check that no API route names a pump, relay, valve or duration. They also check that a request body carrying an extra field such as `run_minutes` is refused. Every pump command in the database has a matching approve or modify row.

## Verified here and not verified

- **Verified in this workspace:**
  - notifications: 51/51 gateway checks (message text, the FCM v1 sign-in and send against a stand-in for Google's servers, token handling, when a notice is sent) and 15/15 phone-screen checks with a stand-in for Android's push plugin;
  - the gateway API (42/42 tests, against the real advisory service) and the rain rule, Open-Meteo client (against a mock) and "why?" answers (44/44);
  - remote access through the relay: 25/25 security checks and 7/7 phone-screen checks. A tampered, unpaired, wrong-key, stale, replayed or other-farm message is refused; a revoked phone is refused; the Wi-Fi path works with the relay down;
  - the app in a 390×844 phone viewport in Chromium (25/25 checks, including approve, cancel, decline, change amount, the "why?" chat, fail-safe, demo mode and dark mode).
- **Not verified here:** the APK build itself. Google's Android download servers are blocked from this workspace. The GitHub workflow is a standard Capacitor 7 build; the first run on GitHub is its first real test.
- **Not verified here:** the live Open-Meteo call (the workspace cannot reach it; tested against a mock reply).
- **Not verified here:** a real notification arriving on a real phone. Google's servers are not reachable from this workspace, so Firebase and Android's plugin were replaced by stand-ins. The first real test is your phone after the set-up above.
- **Not built yet:** the Raspberry Pi gateway, real ESP-NOW nodes, a relay or pump, and a language-model narrator. The app talks to the laptop emulation of the gateway.
- **Languages:** English only. All text is in `www/app.js`, ready for Hindi or Punjabi later.
