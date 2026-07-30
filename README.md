# TV Screen Share

**Put your computer screen on the TV over Wi-Fi. No HDMI cable, no Chromecast, no app on the TV.**

The TV's own web browser is the receiver. You open a page on your laptop, a 6-digit PIN appears, you
type that PIN on the TV, and your screen — with system audio — shows up. Everything stays on your
local network; the picture travels peer-to-peer over WebRTC and never leaves the building.

It is built for **old televisions**. Verified working on a **2016-era Philips running Chromium 49**,
a browser that predates promises in WebRTC, `srcObject` on video elements, and H.264 in WebRTC
entirely. Sets like that break modern WebRTC in about six different ways; each one is handled here,
and the ones that cannot be handled are detected and explained on screen.

---

## Quick start

```bash
npm install
npm start
```

The server prints the addresses to use:

```
  TV Screen Share is running
  ─────────────────────────────────────────────
  Share this screen  :  http://localhost:3000/share
  Open on the TV     :  http://192.168.1.42:3000/tv   (wlan0)
  ─────────────────────────────────────────────
```

1. **On the computer** open `http://localhost:3000/share` → **Start sharing** → pick a screen.
   **Tick "Share system audio"** in the picker if you want sound — on Windows that option only
   appears for *Entire Screen* or a *Chrome Tab*, never for a single window. A 6-digit PIN appears,
   and the sender states whether audio was actually captured.
2. **On the TV** open `http://<computer-ip>:3000/tv` in the TV browser and type the PIN with the
   remote's number keys.
3. The TV shows **"Press OK to start"**. Press OK — video autoplays muted under TV policy, and this
   press is what unmutes it. **🟡 Yellow** toggles mute later.

Then open the firewall, or the TV cannot reach the page at all:

```powershell
New-NetFirewallRule -DisplayName "TV Screen Share" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow   # Windows, as admin
```
```bash
sudo ufw allow 3000/tcp    # Linux
```

`npm run dev` restarts the server as you edit.

### If port 3000 is taken

```bash
npm start -- --port 4000
```

`--port` works identically on macOS, Linux and Windows. (`PORT=4000 npm start` also works, but that
syntax is invalid in Windows `cmd` and PowerShell, which is why the flag exists.) The TV URL becomes
`http://<your-ip>:<port>/tv`, and a busy port prints what to run instead of a stack trace.

### Why `localhost` for the sender

Browsers only expose `getDisplayMedia` in a *secure context*. `http://localhost` counts;
`http://192.168.x.x` does not. Run the server on the machine you are sharing **from** and use the
`localhost` URL there. The TV only receives, which plain HTTP allows, so the TV needs no certificate.

To share from a *different* machine — or from a phone — use `npm run start:https`, which generates a
certificate on first run and listens on **both** HTTP (for the TV) and HTTPS (for the sender).

---

## What makes it work on a 2016 television

Each of these is a real failure found on a real Philips set, not a precaution.

| The TV does this | What the app does about it |
|---|---|
| WebSocket blocked or unsupported | Connects by HTTP polling first, upgrades to WebSocket only where it works |
| Rejects Chrome's `a=extmap-allow-mixed`, discarding the whole offer | Strips that one line before the offer goes over the wire |
| Validates the entire codec list and rejects all of it if one entry is unusable | **Legacy TV mode** reduces the offer to one video codec plus retransmission, no RTP header extensions, no `transport-cc` |
| Has **no H.264 in WebRTC at all** (Chromium 49 predates it) | H.264 is preferred but never forced; VP8 is kept as a fallback, and if the TV still rejects the offer the sender re-offers once with H.264 removed entirely |
| `createAnswer` and `addIceCandidate` have no promise form | Detects the callback-only API from its declared arity and uses it |
| `setLocalDescription` does the work but returns `undefined` | Treated as complete instead of being called twice, which would fail with `STATE_INPROGRESS` |
| No `srcObject` on video elements | Feature-detected, falls back to `URL.createObjectURL` |
| `getStats` is callback-only with different key names | Both APIs are normalised, so the on-screen stats work either way |
| No Fullscreen API | Falls back to painting the video over the whole document with CSS |
| Caches pages forever, with no devtools and often no way to clear it | Every HTML response is `no-store`, and a **build marker** is printed on screen so a stale page is obvious |
| Overscans, cropping the screen edges | All UI keeps a 4% margin |
| Blocks audio autoplay, leaving the video silent | Starts muted (which is permitted), then a persistent on-screen badge says whether it is muted or the source has no audio, and **OK** or **🟡 Yellow** turns sound on |

The whole client is **ES5** — no arrow functions, `let`/`const` or template literals — because one
unparseable token gives you a blank TV screen and no console to diagnose it with.

**Tested on:** Philips `TPM186E` / Saphi (NetTV, Zeasn Whale OS), `Chrome/49.0.2629` `OPR/36`,
ARM Linux, 2018–2019 firmware. Sender: Chrome on Windows.

---

## Navigating the Philips TV browser

Check **Settings → General settings → About** if you are unsure which platform you have.

### Saphi / NetTV (Linux-based, no Play Store)

1. Press **Home**.
2. Open **Apps → Browser**. Some regional builds hide it.
3. Focus the address bar and press **OK** for the on-screen keyboard.
4. Type `192.168.1.42:3000/tv` with your IP. `http://` is optional; **delete any `www.`** the browser
   inserts.
5. Press **✓ / Done**, then **OK** to load.
6. **Bookmark it** so you never retype the address.

The remote's number row types digits straight into the address bar, and digits are most of this URL.

### Android TV / Google TV

There is often no preinstalled browser. From the Play Store:

| Browser | Notes |
|---|---|
| **TV Bro** | Best pick. Built for remotes, current engine. |
| **Chrome** (sideloaded) | Works, but no D-pad affordances; use a USB keyboard. |
| **Puffin TV** | Renders server-side — **WebRTC will not work**. Avoid. |

### Skipping the typing

- Bookmark it once.
- Or put the PIN in the URL: `http://192.168.1.42:3000/tv?pin=482913`.
- A USB keyboard in the TV works everywhere and turns a two-minute chore into five seconds.

---

## Remote control reference

| Key | Action |
|---|---|
| **Arrows** | Move focus (geometry-aware, not DOM order) |
| **0–9** | Type the PIN straight from the remote's number pad |
| **OK / Enter** | Activate; on the start screen, begins playback with sound |
| **Back / Return** | Leave playback, then leave PIN entry |
| **🔴 Red** | Show/hide the stats panel |
| **🟢 Green** | Fullscreen on/off |
| **🟡 Yellow** | Mute/unmute |
| **🔵 Blue** | Reconnect |

On a desktop keyboard, `f`, `m` and `s` mirror green, yellow and red.

---

## Reading the stats panel

Press **🔴 Red** on the TV. This is the single most useful diagnostic in the app, and it works even
on browsers whose stats API predates the current standard.

```
video VP8 1280x720 @ 25 fps
bitrate 2.1 Mbps · lost 0
decoder libvpx
audio opus
rtt 4 ms
signalling polling · build 10
```

A black screen has two very different causes and the panel names which one you have:

- **`no media arriving`** — transport. Firewall, or the sender is offering only `.local` mDNS
  candidates the TV cannot resolve; tick **Strip `.local` mDNS ICE candidates**.
- **`arriving but no frames render`** — the TV cannot decode that codec.

Both also appear on the sender under **Connected TVs**, so you can diagnose from the keyboard rather
than from the sofa.

### Is the TV running the current page?

Every screen shows a build marker — bottom of the PIN screen, top of `/diag`, in the stats panel. If
it does not match the `BUILD` constant in `public/index.html`, the TV is serving a cached copy and
you are debugging code that is not running. Load `/tv?x=2`, changing the number, to force a refetch.

### `/diag` — ask the TV what it supports

Open `http://<computer-ip>:<port>/diag` **on the TV**. It prints, large enough to read from a sofa:
the browser identity, whether WebRTC and WebSocket exist, and the exact list of video codecs that
browser can receive. Also reachable from the PIN screen via *What this TV supports*.

If it reports no H.264, that is expected on **Chromium 49 or older** — H.264 did not reach
Chromium's WebRTC until version 50–52. VP8 is used instead, in software.

---

## Phones and tablets

The same page adapts to touch. There is no app to install.

| Mobile use | Works? | Requirement |
|---|---|---|
| **Phone/tablet as viewer** | Yes | Plain HTTP is fine |
| **Phone camera → TV** | Yes | HTTPS; on iOS also a trusted certificate |
| **Mirroring the phone's own screen** | No | Not possible from any mobile browser |

### Watching on a phone

Open `http://<computer-ip>:3000/tv`, tap in the PIN, tap **OK — Play with sound**. Tapping the
picture hides and shows the controls, **Fullscreen** rotates to landscape where the browser permits
it, and the screen stays awake while you watch.

### Sending the phone's camera

Useful as a document camera or a second angle. Phones refuse camera access on `http://192.168.x.x`,
so run over TLS — a certificate is generated on first use:

```bash
npm run start:https
```

Both listeners run at once, sharing one set of rooms:

| Listener | Port | For |
|---|---|---|
| HTTP | 3000 | the TV, and the certificate download |
| HTTPS | 3443 | the phone that is sending its camera |

The split is deliberate: several TV browsers cannot dismiss a certificate warning at all, so the TV
stays on plain HTTP while the phone gets the HTTPS origin its camera requires. The certificate
covers `localhost` plus every LAN address under `subjectAltName` — browsers ignore Common Name, so a
CN-only certificate is rejected outright.

Then open `https://<computer-ip>:3443/` on the phone and tap **Share this camera**. **Flip camera**
switches front/back mid-stream with `replaceTrack`, so the TV never renegotiates.

#### iPhone and iPad: trust the certificate first

Safari refuses `getUserMedia` on a page whose certificate is untrusted, and **tapping through the
warning is not enough** — the camera stays blocked with no visible error.

1. On the iPhone open **`http://<computer-ip>:3000/cert`** — plain HTTP, so no warning to fight
   through. Only the certificate is sent; the private key never leaves the machine.
2. **Settings → General → VPN & Device Management** → install the *TV Screen Share* profile.
3. **Settings → General → About → Certificate Trust Settings** → switch it **on**. Separate step,
   easily missed, and skipping it leaves the camera silently off.
4. Open `https://<computer-ip>:3443/` and tap **Share this camera**.

### Why phone screen mirroring isn't here

No mobile browser implements `getDisplayMedia` — not Chrome on Android, not Safari on iOS. Mirroring
a phone's screen needs a native app: Android's `MediaProjection`, or on iOS a ReplayKit Broadcast
Upload Extension. The web app detects the situation and offers the camera instead of failing
silently.

**For an iPhone, try AirPlay first.** Philips sets from roughly 2019 onward ship AirPlay 2; Control
Centre → Screen Mirroring then does full phone mirroring natively. Android TV models without it can
install **AirScreen** from the Play Store. Saphi has neither, so a £30 dongle is the realistic route.

---

## Sharing with someone outside your network

The default is LAN-only on purpose. To let a friend elsewhere watch, tunnel the HTTP port:

```bash
npm start -- --port 4000 --stun
ngrok http 4000
```

Give them the ngrok URL with `/tv` on the end, plus the PIN.

**`--stun` is not optional here.** WebRTC media is peer-to-peer, so the tunnel only carries the
handshake — without a STUN server the PIN is accepted and then no video ever arrives. `--stun` with
no value uses Google's public STUN; pass a URL to choose your own. If your friend is on mobile data
or behind CGNAT, STUN is not enough and you need a **TURN** relay:

```bash
npm start -- --port 4000 --turn turn:relay.example.com:3478 --turn-user USER --turn-pass PASS
```

Two things to know before you send the link: the URL is public, so the 6-digit PIN is the only thing
protecting your screen (ten wrong tries per address per ten minutes), and ngrok's free tier shows an
interstitial page on first visit.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **"Start sharing" does nothing** | Not a secure context. Use `http://localhost:<port>/share`, not the LAN IP. |
| **TV can't reach the page at all** | Firewall, or different subnets — TV on guest Wi-Fi is the classic. Test the URL on a phone on the same Wi-Fi first. |
| **Stuck on "Connecting"** | ICE never completed. Usually mDNS: the sender offers only `.local` addresses the TV cannot resolve. Tick **Strip `.local` mDNS ICE candidates** and press 🔵 Blue. |
| **Black screen, no error** | Press 🔴 Red and read the diagnosis line. See *Reading the stats panel*. |
| **Any WebRTC error naming `extmap`, `STATE_INPROGRESS`, `createAnswer`, or `send parameters`** | All handled automatically. If one appears, the TV is running a cached page — check the build marker, then load `/tv?x=2`. |
| **Stutter, tearing, a few fps** | Software decoding, which is expected on pre-2017 sets using VP8. Drop to **720p / 15 fps / 2.5 Mbps** and prefer 5 GHz or Ethernet. |
| **No sound on the TV** | Two causes, and the sender tells you which. If it says **no audio captured**, re-share and tick **Share system audio** — on Windows that box only appears for **Entire Screen** or a **Chrome Tab**, never for a single window, which is the usual trap. If it says **audio captured**, the TV is simply still muted: press **OK** on the overlay, or **🟡 Yellow** during playback. macOS cannot capture whole-screen audio in Chrome at all — share a tab, or install a loopback driver. |
| **Sound only after pressing OK** | Working as designed; TV autoplay policy. |
| **Text looks soft** | Set **Optimise for → Text & detail**: pins resolution, drops frames under load instead of blurring. |
| **`EADDRINUSE`** | `npm start -- --port 4000`. |
| **"Too many wrong PINs"** | Ten failures from one address triggers a ten-minute block. Wait, or restart the server. |
| **Everything cropped at the edges** | The TV is overscanning. Set **Picture → Picture format → Unscaled**. |
| **Phone: "Share this camera" greyed out** | The page is not HTTPS. See *Phones and tablets*. |
| **Phone: "Share this screen" greyed out** | Correct — no mobile browser can share its screen. |
| **Remote viewer joins, then nothing** | No STUN. See *Sharing with someone outside your network*. |

---

## Configuration

Flags take precedence over environment variables.

| Flag | Variable | Default | Purpose |
|---|---|---|---|
| `--port` | `PORT` | `3000` | HTTP port |
| `--https-port` | `HTTPS_PORT` | `3443` | HTTPS port, with `--https` |
| `--stun [url]` | `STUN_URL` | – | STUN for viewers outside the LAN; bare flag uses Google's |
| `--turn <url>` | `TURN_URL` | – | TURN relay |
| `--turn-user` | `TURN_USERNAME` | – | TURN username |
| `--turn-pass` | `TURN_CREDENTIAL` | – | TURN credential |
| – | `HOST` | `0.0.0.0` | Bind address |
| – | `MAX_VIEWERS` | `4` | Concurrent TVs per share |
| – | `JOIN_FAIL_MAX` | `10` | Wrong PINs before an address is blocked |
| – | `JOIN_FAIL_WINDOW_MS` | `600000` | Block window, ms |
| – | `TLS_CERT` / `TLS_KEY` | – | Use your own certificate |

Scripts: `start`, `start:https`, `dev` (watch mode), `cert` (generate only), `check` (syntax).

---

## How it works

```
Sender (Chrome)                Node server                 TV browser
  getDisplayMedia  ──┐                                        │
                     ├─ host:create ──▶ room + 6-digit PIN     │
                     │                                         │
                     │        ◀── viewer:join (PIN) ───────────┤
                     │◀─ viewer:joined ─┤                      │
  offer ─────────────┼──── signal ──────┼─────────────────────▶│
                     │◀─── signal ──────┼──── answer ──────────┤
  ICE candidates ◀───┼──── signal ──────┼────────────────────▶ │
                     │                                         │
  ═══════════════ direct WebRTC media, server not involved ════▶
```

The server only brokers the handshake — it never sees a frame. Rooms are keyed by PIN, a socket can
only signal to peers inside its own room, wrong PINs are rate-limited per address, and rooms
disappear the moment the host disconnects.

```
server.js            Express + Socket.IO signalling, rooms, PIN rate limiting, TLS
public/index.html    Entire client: home / sender / PIN entry / playback / diagnostics (ES5, no build)
scripts/make-cert.js Self-signed certificate with subjectAltName for every LAN address
```

No build step, no bundler, no framework. Two runtime dependencies: `express` and `socket.io`.

---

## Limitations

- One sender per PIN; up to `MAX_VIEWERS` TVs watch the same stream.
- Pre-2017 sets decode VP8 in software. 720p30 is realistic; 1080p is not.
- No recording. No internet traversal without STUN, and none behind symmetric NAT without TURN.
- Audio capture depends on the OS: Windows gives full system audio, Linux usually does, macOS is
  tab-audio-only without a loopback driver.
- The PIN is the only access control. On a LAN that is proportionate; if you expose the server to
  the internet, understand that is all that stands between a URL and your screen.

## License

MIT — see [LICENSE](LICENSE).
