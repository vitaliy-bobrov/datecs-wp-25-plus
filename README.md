# Datecs WP-25 Plus — capture shell

Web Serial-only capture shell: a deployable Vite/React/TypeScript app with connection diagnostics, the known short preflight, a Type2 response logger and an NBP USD/EUR reference panel. It sends no currency read or write.

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
2. Choose **Connect Web Serial**. WebUSB is not supported.
3. Select the cashier, confirm the connected state, then disconnect.
4. Download the JSONL and/or text log.
5. Connect, run the preflight, and download the JSONL/text. The log must contain the exact preflight tx and raw response (or timeout/control result), with no currency read or write.

No Docker USB passthrough is used. The DSH/container environment is for building and tests only; hardware access belongs to the host browser. WebUSB is intentionally dropped: on macOS the serial driver owns interface 0 and `claimInterface` fails. Web Serial is the only supported path.

## Current scope

Web Serial only. The app connects, sends the exact short preflight, captures and validates the I90 Type2 response, and shows the previous-business-day NBP USD/EUR reference rates with effective date and stale handling. It sends no `0xFF`, currency read or write.

The next step is analysing the hardware response; the read/write epic remains gated on real evidence.
