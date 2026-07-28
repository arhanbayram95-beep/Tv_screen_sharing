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

### Why `localhost` for the sender

Browsers only expose `navigator.mediaDevices.getDisplayMedia` in a *secure context*. `http://localhost`
counts as secure; `http://192.168.x.x` does not. So run the server on the machine you are sharing
**from** and use the `localhost` URL there. The TV only *receives*, which plain HTTP allows, so the
TV side needs no certificate.

To share from a *different* machine than the server, give it TLS:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem -subj "/CN=$(hostname -I | awk '{print $1}')"

TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start
```

You will have to accept the self-signed warning on both ends.

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

## Remote control reference

| Key | Action |
|---|---|
| **Arrows** | Move focus (geometry-aware, not DOM order) |
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
| **Black screen, audio fine** | Codec mismatch — the TV cannot decode what is being sent. Press 🔴 Red to check the codec. If it is not H.264, confirm **Force H.264 only** is ticked and restart the share; some Chromium builds ship without an H.264 encoder, in which case use Chrome or Edge. |
| **Stutter, tearing, or a few fps** | Software decoding or too much bitrate. Drop to 720p / 15 fps / 2.5 Mbps on the sender, and prefer 5 GHz Wi-Fi or Ethernet for the TV. |
| **No sound at all** | The capture has no audio track — the sender warns about this. Re-share and tick **Share system audio** in the picker. On macOS Chrome cannot capture system audio for a whole screen; share a **tab** instead, or install a loopback device. |
| **Sound only after pressing OK** | Working as designed; TV autoplay policy. |
| **Text looks soft** | Set **Optimise for → Text & detail**. That pins resolution and drops frames under load instead of blurring. |
| **"Too many wrong PINs"** | Ten failed attempts from one address triggers a 10-minute block. Wait it out, or restart the server. |
| **Picture stops when the laptop sleeps** | Expected. Disable sleep on the sender for long sessions. |
| **Everything is tiny / cut off at the edges** | The TV is overscanning. Set **Picture → Picture format → Fill screen / Unscaled** in the TV's own menu. |

Live diagnostics: 🔴 Red on the TV shows codec, resolution, fps, bitrate, packet loss, decoder and
RTT. The sender mirrors the TV's numbers in **Connected TVs**, so you can debug from the couch or
from the keyboard.

---

## Configuration

Environment variables, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_VIEWERS` | `4` | Concurrent TVs per share |
| `JOIN_FAIL_MAX` | `10` | Wrong PINs before an address is blocked |
| `JOIN_FAIL_WINDOW_MS` | `600000` | Block window, ms |
| `TLS_CERT` / `TLS_KEY` | – | Serve HTTPS instead of HTTP |
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
