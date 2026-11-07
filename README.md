# Datecs WP-25 Plus — capture shell

Initial shell plus transport diagnostics: a deployable Vite/React/TypeScript app with Web Serial as the working transport, WebUSB as an experimental option, and a local logger. It sends **no device command** — no preflight, currency read, NBP request or write yet.

## Develop

Requires Node 20.19+ and npm.

```bash
npm ci
npm run dev
npm test
npm run build
```

The app is one page: connection controls, connection facts and the in-memory logger. The logger holds 2000 entries and downloads as JSONL and text. Diagnostics include the failing stage, browser error name/message, device/USB IDs, interface/alternate/endpoint and open settings, while serial numbers and OS paths are excluded. No data is sent to a backend.

## Deploy to GitHub Pages

1. Create the repository and push this project on `main`.
2. In **Settings → Pages**, set **Source: GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` runs tests, builds `dist/` and deploys it.
4. Open the Pages URL in Chrome or Edge **on the host machine** that has the cashier attached.

The static build uses relative asset paths (`base: './'`), so it works under a project Pages URL.

## Host smoke test

1. Open the Pages URL on the host.
2. Choose **Connect with Web Serial** (the working transport). WebUSB is experimental.
3. Select the cashier, confirm the connected state, then disconnect.
4. Download the JSONL and/or text log.
5. Confirm the log contains only connection lifecycle entries and no command bytes.

No Docker USB passthrough is used. The DSH/container environment is for building and tests only; hardware access belongs to the host browser. On 2026-11-07 WebUSB failed with `device-unavailable`; Web Serial connected. The logger now records enough detail to diagnose the WebUSB failure on the next retest.

## Current scope

The read-only protocol work (known preflight, raw capture, strict frame validation and NBP display) is the next story. The read/write epic remains gated on real hardware evidence.
