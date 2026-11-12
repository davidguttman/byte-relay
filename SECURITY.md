# Security model and deployment requirements

## Anonymous broadcast, not a secure messaging system

Byte Relay intentionally allows **anyone** to subscribe or publish to any channel, from any origin. A channel key is a routing label, **not authentication or authorization**. Knowing or guessing a key permits reading current messages and injecting arbitrary messages. There is no confidentiality, authenticity, replay protection, durable storage, history, delivery guarantee or subscriber identity. A malicious participant can impersonate senders, spam a channel, consume quotas or monopolize subscriber slots. A distributed attacker can deny availability even with all application bounds enabled.

Use independently generated high-entropy random channel keys to reduce accidental discovery, but do not mistake secrecy of a URL for security. When confidentiality or authenticity matters, **encrypt and authenticate messages end-to-end in clients**, with keys exchanged outside this relay; use appropriate client-side replay checks and expiry. Do not send secrets or trusted commands in plaintext. Treat every received payload as untrusted data, not HTML or executable content. TLS protects a network hop, not against the relay operator or other channel participants.

## What this implementation bounds

Channels use a Map, not EventEmitter names: `error`, `newListener`, `removeListener` and prototype names have no special behavior or metadata access. Active subscriptions are bounded globally/per peer/per channel. Admission bounds apply before channel decoding/body accumulation, including invalid routes and preflights. Separate inflight caps, body byte limits/deadlines, global ingress and encoded-byte-times-fanout token budgets limit processing and retained memory. Source rate tracking is bounded and expires. Slow readers have no application queue: one bounded Node writable backlog waits for drain; another send while blocked or exceeding the backlog cap disconnects the subscriber. Connection lifetime also bounds stalled subscriptions. One shared maintenance timer handles heartbeats, lifetime expiry and request deadlines. Close/error/abort cleanup releases subscription and request accounting, including drain listeners. No raw key/payload logging is implemented. Error bodies are fixed; health exposes only status.

These measures are best-effort application defenses, not a firewall or proof of safety. Token buckets allow bursts. Dropped connections, missed messages, 429s and temporary unavailability are deliberate overload behavior. Resource use still depends on configured limits, Node/framework allocations and kernel buffers. The health endpoint bypasses application admission to remain useful under saturation; **the edge must bound health traffic**. Requests rejected before the body is consumed close keep-alive rather than drain unbounded uploads. Complete TCP, TLS and HTTP protection requires deployment controls.

## Required before public deployment

1. Use the supported pinned Node runtime and locked dependencies; scan both npm and the OS/container base. Keep current with upstream advisories. `npm audit` reports only known package advisories, not application correctness, configuration, OS vulnerabilities or unknown flaws; zero findings is **not** an audit guarantee.
2. Verify TLS, SSE buffering/idle settings, body/header/upload deadlines, edge rate/concurrency limits (including health), and memory/CPU/network/file-descriptor limits. Test reconnect and overload behavior in an authorized staging environment before production.
3. Ensure the edge identifies clients safely and removes untrusted forwarding headers. The app deliberately trusts only the socket peer and ignores XFF. Behind one proxy, application per-source limits aggregate all its clients; set intentional caps and enforce individual quotas at the edge. Do not turn on blanket proxy trust to fix quota sharing.
4. Disable/redact full URL paths, query strings and bodies in proxy/CDN/load-balancer/APM/access logs. Avoid embedding credentials in channel URLs. Do not expose origin or administrative services inadvertently.
5. Run exactly one process unless implementing and reviewing distributed broadcast/budget coordination. Restarts lose all subscriptions/state and require clients to reconnect. No Redis persistence or cross-worker transport exists.
6. Verify image construction, current base-package scans and live behavior independently. Unit tests use only mocks/in-memory streams and cannot establish real socket, proxy, browser or production performance guarantees.

## Compatibility changes

The default body cap is 64 KiB (formerly 1 MiB); it can be increased to at most 1 MiB. Compressed bodies now fail with 415. Empty/no-Content-Type POSTs have defined UTF-8 behavior. HEAD/trailing-slash routes no longer create SSE subscriptions; health is GET-only and exact. Health metadata, key logs, automatic dotenv loading, unused Redis/fakeredis, healthpoint and productionize are removed. Open CORS remains; preflights allow Content-Type only rather than reflecting arbitrary requested headers. Clients must reconnect for lifetime expiry/backpressure and handle rate limits. There is no forced key migration, authentication layer or delivery persistence.

## Reporting

For sensitive findings, contact the repository owner privately through an established trusted channel; do not publish live channel keys, payloads, credentials or exploit traffic in a public issue. Provide a minimal offline reproduction, affected revision, impact and recommended mitigation. No formal response-time/SLA or bug-bounty commitment is implied.
