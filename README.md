# TV Screen Share

Cast a computer screen (with system audio) to a Philips Smart TV's built-in browser over your
local network. Node.js + Express + Socket.IO handle signalling; the picture travels peer-to-peer
over WebRTC and never leaves the LAN.

Built specifically around what TV browsers get wrong: **H.264 is forced**, audio waits behind an
explicit "press OK" gesture, every control is reachable with the D-pad, and fullscreen falls back
to CSS when the Fullscreen API is missing.

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
  Share from this computer :  http://localhost:3000/share
  Open on the TV           :  http://192.168.1.42:3000/tv   (wlan0)
  ─────────────────────────────────────────────
```

1. **On the computer** open `http://localhost:3000/share` → **Start sharing** → pick a screen or
   window. Tick **Share system audio** / **Share tab audio** in Chrome's picker if you want sound.
   A 6-digit PIN appears.
2. **On the TV** open `http://<computer-ip>:3000/tv` in the TV browser and type the PIN with the
   remote's number keys.
3. The TV shows **"Press OK to start"**. Press OK. Picture and sound begin.

Run `npm run dev` instead of `npm start` to auto-restart the server while editing.

### If port 3000 is taken

Very likely — 3000 is the default for half the Node backends in existence. Pick another:

```bash
npm start -- --port 4000            # any free port
npm run start:https -- --port 4000 --https-port 4443
```

`--port` works identically on macOS, Linux and Windows. (`PORT=4000 npm start` also works, but that
syntax is invalid in Windows `cmd` and PowerShell, which is why the flag exists.) The server prints
the URLs for whichever port it ends up on, and tells you what to do if the port is busy rather than
dumping a stack trace.

Whatever port you choose, the TV URL becomes `http://<your-ip>:<port>/tv`.

### Why `localhost` for the sender

Browsers only expose `navigator.mediaDevices.getDisplayMedia` in a *secure context*. `http://localhost`
counts as secure; `http://192.168.x.x` does not. So run the server on the machine you are sharing
**from** and use the `localhost` URL there. The TV only *receives*, which plain HTTP allows, so the
TV side needs no certificate.

To share from a *different* machine than the server — or from a phone — start it with TLS instead:

```bash
npm run start:https
```

That generates a certificate on first run and listens on **both** HTTP (for the TV) and HTTPS (for
the sender). See [Phones and tablets](#phones-and-tablets) for the details.

---

## Navigating the Philips TV browser

Which browser you get depends on the platform your set runs. Check **Settings → General settings →
About** if you are unsure.

### Philips with Titan OS (2024+) or Saphi

1. Press **Home** on the remote.
2. Find the **Web Browser** app (Titan OS: in the **Apps** row; Saphi: **Apps → Browser**). Some
   regional builds hide it — see the workarounds below.
3. Press **OK**, then move focus to the **address bar** at the top and press **OK** to open the
   on-screen keyboard.
4. Type `192.168.1.42:3000/tv` using the substituted IP. The `http://` prefix is optional, and
   **skipping `www.`** matters — some builds append it automatically, so delete it if it appears.
5. Press the **✓ / Done** key on the on-screen keyboard, then **OK** to load.
6. **Bookmark it** (browser menu → *Add to favourites*) so you never retype the address.

Typing tip: the number row on the remote usually types digits directly into the address bar, and
digits are most of what this URL is.

### Philips with Android TV / Google TV (most 2015–2023 models)

There is no preinstalled browser on many of these. Install one from the Play Store:

| Browser | Notes |
|---|---|
| **TV Bro** | Best pick. Built for remotes, proper D-pad focus, current Chromium/WebView engine. |
| **Puffin TV Browser** | Remote-friendly, but renders server-side — **WebRTC will not work**. Avoid for this tool. |
| **Chrome** (sideloaded) | Works, but has no D-pad affordances; you need a mouse-mode remote or a USB/Bluetooth keyboard. |

TV Bro plus this page's built-in D-pad navigation is the combination that behaves best.

### Getting the URL onto the TV without typing

- Bookmark it once and reuse the bookmark.
- Or append the PIN to the address to skip PIN entry entirely: `http://192.168.1.42:3000/tv?pin=482913`.
- A USB keyboard plugged into the TV works in every one of these browsers and turns a two-minute
  chore into five seconds.

---

## Phones and tablets

The same page adapts to touch — there is no separate app to install.

| Mobile use | Works? | Requirement |
|---|---|---|
| **Phone/tablet as viewer** | Yes | Plain HTTP is fine |
| **Phone camera → TV** | Yes | HTTPS; on iOS also a trusted certificate |
| **Mirroring the phone's own screen** | No | Not possible from any mobile browser |

### Watching on a phone

Open `http://<computer-ip>:3000/tv`, tap in the PIN, tap **OK — Play with sound**. Tapping the
picture hides and shows the controls, **Fullscreen** rotates to landscape where the browser permits
it, and the screen is kept awake while you watch.

### Sending the phone's camera

Useful as a document camera or a second angle. Phones refuse camera access on `http://192.168.x.x`,
so run the server over TLS — it generates its own certificate on first use:

```bash
npm run start:https
```

This runs **both** listeners at once, sharing one set of rooms:

| Listener | Port | For |
|---|---|---|
| HTTP | 3000 | the TV, and the certificate download |
| HTTPS | 3443 | the phone that is sending its camera |

The split is deliberate. The TV stays on plain HTTP because several TV browsers cannot dismiss a
certificate warning at all, while the phone gets the HTTPS origin its camera requires.

The certificate is generated on first run and covers `localhost` plus every LAN address the machine
has, listed under `subjectAltName`. That last part matters: browsers ignore a certificate's Common
Name entirely, so a cert with only a CN is rejected outright.

Then open `https://<computer-ip>:3443/` on the phone and tap **Share this camera**. **Flip camera**
switches front/back mid-stream using `replaceTrack`, so the TV never renegotiates.

#### iPhone and iPad: trust the certificate first

Safari refuses `getUserMedia` on a page whose certificate is untrusted, and **tapping through the
warning is not enough** — the camera stays blocked with no visible error. Install it once:

1. On the iPhone, open **`http://<computer-ip>:3000/cert`** — plain HTTP, so there is no warning to
   fight through. The server sends the certificate only; the private key never leaves the machine.
2. Safari says a profile was downloaded. Go to **Settings → General → VPN & Device Management**, tap
   the *TV Screen Share* profile, and **Install**.
3. Then — a separate step, easy to miss — go to **Settings → General → About → Certificate Trust
   Settings** and switch the profile **on**.
4. Open `https://<computer-ip>:3443/` and tap **Share this camera**.

Skip step 3 and Safari still shows a certificate warning, with the camera silently staying off.

### Why phone screen mirroring isn't here

No mobile browser implements `getDisplayMedia` — not Chrome on Android, not Safari on iOS. Mirroring
a phone's screen needs a native app: Android's `MediaProjection`, or on iOS a ReplayKit Broadcast
Upload Extension. That is a separate app project, not a change to this page. The web app detects the
situation and offers the camera instead of failing silently.

**For an iPhone, try AirPlay before building anything.** Most Philips sets from roughly 2019 onward
ship AirPlay 2 — check *Settings → Apps* or the TV's feature list for an AirPlay entry. If it is
there, iOS **Control Centre → Screen Mirroring** already does full phone-screen mirroring, with
audio, at better quality than a custom app would manage. It costs nothing to check.

---

## Remote control reference

| Key | Action |
|---|---|
| **Arrows** | Move focus (geometry-aware, not DOM order) |
| **0-9** | Type the PIN straight from the remote's number pad |
| **OK / Enter** | Activate; on the start screen, begins playback with sound |
| **0–9** | Type the PIN directly |
| **Back / Return** | Leave playback, then leave PIN entry |
| **🔴 Red** | Show/hide the stats panel |
| **🟢 Green** | Fullscreen on/off |
| **🟡 Yellow** | Mute/unmute |
| **🔵 Blue** | Reconnect |

On a desktop keyboard `f`, `m` and `s` mirror green, yellow and red.

---

## Philips-specific behaviour, and why it's there

**H.264 is forced.** Philips Saphi and Titan OS panels, and most Android TV boxes, have hardware
decoders for H.264 only. Handed VP8 or VP9 they either fall back to a software decoder that manages
about 5 fps at 1080p, or show a black frame. The sender therefore:

- calls `setCodecPreferences()` with H.264 first, ranked by profile — constrained baseline
  (`42e01f`) ahead of baseline (`42001f`) ahead of main, with high profile last, because that is
  the order of decreasing hardware support on TV silicon;
- with **Force H.264 only** ticked (the default), removes VP8/VP9/AV1 from the offer entirely, so
  there is nothing else to negotiate down to;
- falls back to rewriting the SDP by hand on browsers too old for `setCodecPreferences()`.

The viewer's stats panel (🔴 Red) shows the codec that was actually negotiated and the decoder
backing it. If it says anything other than H.264, that is your problem.

**Audio needs a gesture.** TV browsers block autoplay with sound, and some block autoplay entirely.
Video starts muted (which is permitted) behind a large "OK — Play with sound" button. Pressing OK
supplies the gesture the media policy requires. If the TV still refuses sound, playback continues
muted rather than stalling.

**Fullscreen degrades gracefully.** Several TV browsers ship no Fullscreen API. When
`requestFullscreen()` is missing or rejects, the page paints the video over the whole document with
CSS instead. The button behaves the same either way.

**Overscan.** All UI keeps a 4% margin so nothing lands under the bezel on sets that overscan.

**Old engines.** The entire client is ES5 — no arrow functions, `let`/`const` or template literals —
because a single unparseable token anywhere in the file gives you a blank TV screen and no console
to diagnose it with.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **"Start sharing" does nothing / capture error** | The page is not in a secure context. Use `http://localhost:3000/share`, not the LAN IP. |
| **TV browser can't reach the page at all** | Different subnets (very common: TV on guest Wi-Fi, laptop on the main SSID), or a host firewall. Allow TCP 3000: `sudo ufw allow 3000/tcp`. |
| **PIN accepted, then stuck on "Connecting"** | ICE never completed. Usually Chrome's mDNS candidate obfuscation: the sender offers only `.local` addresses the TV cannot resolve. Tick **Strip `.local` mDNS ICE candidates** on the sender and reconnect. |
| **"Failed to parse SessionDescription... a=extmap expects two fields"** | An older TV WebRTC stack rejecting Chrome's `a=extmap-allow-mixed`. Stripped automatically since v1.0.4 — if you see it, the TV is running a cached copy of the page. Clear the TV browser cache or load the URL with `?x=1`. |
| **Black screen, audio fine** | Codec mismatch — the TV cannot decode what is being sent. Press 🔴 Red to check the codec. If it is not H.264, confirm **Force H.264 only** is ticked and restart the share; some Chromium builds ship without an H.264 encoder, in which case use Chrome or Edge. |
| **Stutter, tearing, or a few fps** | Software decoding or too much bitrate. Drop to 720p / 15 fps / 2.5 Mbps on the sender, and prefer 5 GHz Wi-Fi or Ethernet for the TV. |
| **No sound at all** | The capture has no audio track — the sender warns about this. Re-share and tick **Share system audio** in the picker. On macOS Chrome cannot capture system audio for a whole screen; share a **tab** instead, or install a loopback device. |
| **Sound only after pressing OK** | Working as designed; TV autoplay policy. |
| **Text looks soft** | Set **Optimise for → Text & detail**. That pins resolution and drops frames under load instead of blurring. |
| **`EADDRINUSE` / port in use** | Another program holds that port. `npm start -- --port 4000`. |
| **"Too many wrong PINs"** | Ten failed attempts from one address triggers a 10-minute block. Wait it out, or restart the server. |
| **Picture stops when the laptop sleeps** | Expected. Disable sleep on the sender for long sessions. |
| **Phone: "Share this camera" is greyed out** | The page is not HTTPS. See *Phones and tablets* above. |
| **Phone: "Share this screen" is greyed out** | Correct — no mobile browser can share its screen. Use the camera. |
| **Phone: stats stop updating while sharing** | The browser throttles background tabs. The stream keeps running; only the numbers stall. Return to the tab. |
| **Everything is tiny / cut off at the edges** | The TV is overscanning. Set **Picture → Picture format → Fill screen / Unscaled** in the TV's own menu. |

Live diagnostics: 🔴 Red on the TV shows codec, resolution, fps, bitrate, packet loss, decoder and
RTT. The sender mirrors the TV's numbers in **Connected TVs**, so you can debug from the couch or
from the keyboard.

---

## Configuration

Environment variables, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `--port` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_VIEWERS` | `4` | Concurrent TVs per share |
| `JOIN_FAIL_MAX` | `10` | Wrong PINs before an address is blocked |
| `JOIN_FAIL_WINDOW_MS` | `600000` | Block window, ms |
| `HTTPS_PORT` / `--https-port` | `3443` | HTTPS port when started with `--https` |
| `TLS_CERT` / `TLS_KEY` | – | Use your own certificate instead of a generated one |
| `STUN_URL` | – | STUN server; unnecessary on a LAN |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | – | TURN relay, for segmented networks |

## How it works

```
Sender (Chrome)                Node server                 TV browser
  getDisplayMedia  ──┐                                        │
                     ├─ host:create ──▶ room + 6-digit PIN     │
                     │                                         │
                     │        ◀── viewer:join (PIN) ───────────┤
                     │◀─ viewer:joined ─┤                      │
  offer (H.264) ─────┼──── signal ──────┼─────────────────────▶│
                     │◀─── signal ──────┼──── answer ──────────┤
  ICE candidates ◀───┼──── signal ──────┼────────────────────▶ │
                     │                                         │
  ═══════════════ direct WebRTC media, server not involved ════▶
```

The server only brokers the handshake — it never sees a frame. Rooms are keyed by PIN, a socket can
only signal to peers inside its own room, and rooms disappear the moment the host disconnects.

### Layout

```
server.js            Express + Socket.IO signalling, rooms, PIN rate limiting
public/index.html    Entire client: home / sender / PIN entry / playback (ES5, no build step)
```

## Limitations

- One sender per PIN; up to `MAX_VIEWERS` TVs watch the same stream.
- No recording, no relay, no internet traversal without configuring TURN.
- Audio capture depends on the OS: Windows and Chrome give you full system audio, Linux usually
  does, macOS is tab-audio-only without a loopback driver.

## License

MIT
