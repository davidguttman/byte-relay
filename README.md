# Byte Relay

A small, **anonymous, single-process, best-effort broadcast relay**. A GET subscribes to a channel over Server-Sent Events (SSE); a POST broadcasts its raw body to currently connected subscribers of the same channel. CORS is deliberately open. **Channel keys are not authentication.** Read [SECURITY.md](SECURITY.md) before exposing it publicly.

## Run and test

Use Node `>=24.22.1 <25` (deployment pins `24.22.1`):

```sh
npm ci --ignore-scripts
npm test
npm audit
npm start
```

`npm test` uses native `node:test` with mocked requests/responses and in-memory streams: no listeners, ports, live service requests, or supertest. Import `createApp` from `app.js` without listening; call `app.locals.relay.close()` to release its one maintenance timer and all requests/subscriptions. `index.js` only starts HTTP when run directly.

## Protocol

- `GET /:key`: SSE, immediate `:ok` comment, periodic heartbeat comments, UTF-8 `data:` events. Clients must reconnect after the maximum connection lifetime or any disconnect. There are no IDs or replay. `/health` is reserved.
- `POST /:key`: any content type, including absent content type; body bytes are decoded as UTF-8 (invalid sequences become U+FFFD), **not a binary-transparent transport**. Encode binary yourself. Empty body sends an empty data event. CR/LF lines are individually prefixed, not interpreted as SSE fields.
- `201`: accepted for best-effort delivery, including when there are zero subscribers. It is **not** a delivery acknowledgment; slow subscribers may be disconnected during fanout.
- `GET /health`: exactly this path (optional query ignored), `{ "status": "ok" }`. No PID, memory, uptime or channel information. Not a readiness/capacity guarantee.
- OPTIONS preflight: open origin, `GET, POST, OPTIONS`, allows `Content-Type`; no credentials. Preflights consume admission limits.
- Keys are one URL path parameter, decoded by Express, up to 256 UTF-8 bytes by default, without C0/C1 control characters. Ordinary existing keys remain valid, including `error`, `newListener`, `removeListener`, Unicode and punctuation. No forced new format. Routes are case-sensitive and do not accept trailing slashes. Query strings are ignored and query parsing is disabled.
- `400` invalid input/path; `404` unknown route; `405` unsupported method (including HEAD); `408` body deadline; `413` body too large; `415` non-identity content encoding; `429` rate/capacity/budget exhausted; `503` closing. Compressed POST bodies are never inflated. Failures return fixed text, not keys, payloads, stacks or internals; rejected requests close HTTP keep-alive.

## Limits and configuration

Environment variables only: `.env` is not loaded automatically. All values below must be plain **positive decimal integers** within `config.js` upper bounds; empty, zero, negative, fractional, non-finite, exponential and oversized values fail startup. Unknown environment names are ignored. Limits are **per process**, not cluster-wide.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PORT` | 3000 | HTTP listen port (1–65535) |
| `MAX_KEY_BYTES` | 256 | Decoded channel UTF-8 bytes |
| `MAX_BODY_BYTES` | 65536 | Raw POST bytes, checked before encoding/fanout |
| `MAX_CONNECTIONS` | 1000 | Active SSE subscriptions |
| `MAX_CONNECTIONS_PER_SOURCE` | 20 | SSE subscriptions per socket peer IP |
| `MAX_CONNECTIONS_PER_CHANNEL` | 100 | SSE subscribers per key |
| `MAX_REQUESTS` | 100 | Inflight non-health requests, separate from SSE |
| `MAX_REQUESTS_PER_SOURCE` | 10 | Inflight requests per socket peer IP |
| `GLOBAL_REQUESTS_PER_SECOND` | 200 | Global token bucket refill and burst capacity |
| `REQUESTS_PER_SOURCE_PER_SECOND` | 20 | Source token bucket refill and burst capacity |
| `MAX_RATE_SOURCES` | 10000 | Rate-tracking entries; full table rejects new sources |
| `GLOBAL_BODY_BYTES_PER_SECOND` | 1048576 | Ingress byte token bucket, including chunked bodies |
| `GLOBAL_FANOUT_BYTES_PER_SECOND` | 8388608 | Encoded SSE byte budget multiplied by fanout |
| `MAX_BACKLOG_BYTES` | 524288 | Per-response write backlog plus next frame bound |
| `HEARTBEAT_MS` | 15000 | Heartbeat interval |
| `MAX_CONNECTION_MS` | 300000 | Maximum subscription lifetime |
| `BODY_TIMEOUT_MS` | 10000 | Absolute admitted-request deadline |
| `HEADERS_TIMEOUT_MS` | 10000 | Bootstrap HTTP header deadline |

Token buckets permit a burst of up to one second of capacity, not strict fixed-window counts. Source rate entries expire after one idle second (the bucket refill period). Maintenance runs at most once a second; body/lifetime deadlines may therefore overrun by up to a second. A heartbeat is skipped if the fanout budget is exhausted. Initial `:ok` frames are bounded by admission and connection caps.

The relay serializes a message **once** and budgets its actual encoded UTF-8 length times subscribers, before any delivery. Newline-heavy or invalid UTF-8 input can expand significantly. No application-side slow-reader queue exists: a `write()` returning false retains its already-accepted frame in Node's bounded writable backlog and waits for `drain`. Another publication or heartbeat before drain disconnects that subscriber without adding more data. A frame that would exceed the existing backlog plus next-frame cap also disconnects it, and the connection lifetime bounds stalled subscriptions. This deliberately favors bounded resource use over reliable delivery. Choose body, backlog, fanout and connection limits together; increasing them increases the worst-case memory and bandwidth footprint.

Bootstrap also limits HTTP headers to 8 KiB/50 fields, keep-alive idle time to 5 seconds, requests per socket to 100, and TCP connections to `MAX_CONNECTIONS + MAX_REQUESTS + 10`. These are not substitutes for edge controls, especially for incomplete uploads, health floods and distributed attackers.

## Deployment

- Nixpacks retains the checksum-pinned upstream Node 24.22.1 Linux x64 download; installs use `npm ci --omit=dev --ignore-scripts`.
- CapRover uses the checked-in `Dockerfile` via `captain-definition` `dockerfilePath`, not an obsolete Node 18 template. The Dockerfile checks the **same Node checksum**, installs locked dependencies without scripts, copies only runtime source, and runs as UID 10001. This Dockerfile is intentionally **amd64 only**. Its Debian OS base is a maintained tag, not digest-pinned: scan and refresh base packages as part of release operations. The allowlist `.dockerignore` excludes credentials and artifacts from build context.
- One process only: channels, limits and subscriptions are in memory. Multiple replicas/workers do not share broadcasts or budgets. Redis was unused and is not configured. Do not add replicas expecting distributed behavior.
- Terminate TLS at a trusted reverse proxy; disable response buffering/compression for SSE; allow long-lived responses but set connection/header/upload deadlines, body limits, and global/per-client rate/concurrency limits. Set the edge idle timeout above `HEARTBEAT_MS`, allowing for skipped heartbeats under budget pressure. Enforce edge limits on `/health` too.
- **Proxy trust is always false**. Quotas use `req.socket.remoteAddress`, never user-controlled `X-Forwarded-For`. Behind a proxy, all its clients share that peer's quotas; tune source caps and enforce real client quotas at the edge. No environment flag enables arbitrary proxy trust. Any future trust configuration needs an explicit reviewed trusted-proxy topology.
- Restrict direct origin access to the proxy where appropriate. Configure edge access logs to omit/redact paths/query strings, and disable request/response body capture in proxies/APM. The app never logs keys/payloads, but URLs also reach browser history, intermediaries and infrastructure.
- Set memory/CPU/file-descriptor/bandwidth budgets and monitor disconnects/429s at the edge without logging channel names. Reassess defaults against actual capacity and shared-NAT/proxy traffic.

The source hardening and dependency audit are not a public-safety certificate. Container build, TLS/proxy settings, production capacity and runtime behavior must be verified in the deployment environment before release.
