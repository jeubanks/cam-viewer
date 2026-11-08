# cam-viewer

Kiosk viewer for the Reolink NVR cameras: go2rtc and Caddy in one compose stack.
It replaces the old `kiosk` (caddy) and `go2rtc` stacks.

```
browser ──► Caddy :8082 ──► static site (site/)
               │
               └─► go2rtc :1985 (over loopback, so no login needed)
                     /api/ws         live video (WebRTC, MSE fallback)
                     /api/frame.jpeg thumbnails
                     /video-rtc.js   player library
browser ◄── WebRTC media ── go2rtc :8565 (UDP/TCP)
go2rtc  ──► NVR HTTP-FLV (sub streams; main streams for HD)
```

## Setup

```sh
cp .env.example .env   # fill in NVR_PASS and GO2RTC_ADMIN_PASS
docker compose up -d
```

- Kiosk: `http://HOST_IP:8082/` (add `?cam=garden` to choose the start camera)
- go2rtc admin: `http://HOST_IP:1985/` (login from `.env`)

In Dockhand: create a stack named `cam-viewer`, then put this folder's files in
`/opt/stacks/cam-viewer/`, or point the stack at this repo.

## Cameras

Change cameras in two places, with matching names:

1. `go2rtc/go2rtc.yaml` `streams:`. Reolink FLV channel numbers start at 0.
2. `site/cameras.json`. `id` = stream name. The optional `hd` names a full-res stream.

The first camera in the list is "home": the kiosk goes back to it after
`idleReturnSec` with no touches. The page also reloads every day at `dailyReloadAt`.

## Reliability design

- **Watchdog** (`site/player.js`). If no video frame is decoded for 8 s, or
  go2rtc reports a source error, the player tears down the connection and
  reconnects, with backoff from 1 s to 30 s. The stock go2rtc player only
  reconnects when its WebSocket closes, so it stays black after an NVR EOF.
- **Thumbnails** come from go2rtc's `frame.jpeg` (~50 KB from the substream),
  one request at a time. They don't use NVR `Snap`, which returns full 4K/8K
  JPEGs (0.5–3 MB each) and competes with live streams for the NVR's web server.
- **Sleep and wake.** Streams stop when the screen is hidden and reconnect when it returns.

## Security

- NVR credentials live only in `.env`. They are never sent to the browser.
- go2rtc requires a login for any non-loopback request.
- Caddy forwards only `/api/ws` and `/api/frame.jpeg`, and only for `src` values
  that look like a stream name. go2rtc would otherwise create a new source
  from any URL passed as `src`.

## Switching over from the old stacks

Defaults avoid the old ports, so both can run side by side. When done:

1. Stop the `kiosk` and `go2rtc` stacks in Dockhand.
2. Optionally set `SITE_PORT=8081`, `GO2RTC_API_PORT=1984`, `GO2RTC_WEBRTC_PORT=8555`
   in `.env` and redeploy, so kiosk bookmarks keep working.
