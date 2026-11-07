# Datecs WP-25 Plus — capture shell

Web Serial or simulator capture shell: a deployable Vite/React/TypeScript app with connection diagnostics, the known short preflight, a Type2 response logger and an NBP USD/EUR reference panel. It sends no currency read or write.

## Develop

CI uses Node 26 (see `.nvmrc`); the package requires Node 20.19+.

```bash
npm ci
npm run dev
npm test
npm run build
```

The app is one page: connection controls, preflight capture, NBP reference and the in-memory device logger. The logger holds 2000 entries and shows the newest 250; it downloads as JSONL and text. Diagnostics include the failing stage, browser error name/message, device/USB IDs, interface/alternate/endpoint and open settings, while serial numbers and OS paths are excluded.

The device log never leaves the browser. The NBP panel makes a direct browser request to `https://api.nbp.pl/api/exchangerates/tables/A/last/2/`; there is no backend, analytics or telemetry.

## Deploy to GitHub Pages

1. Create the repository and push this project on `main`.
2. In **Settings → Pages**, set **Source: GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` runs typecheck, Biome, jscpd, tests and build, then deploys on `main`.
4. Open the Pages URL in Chrome or Edge **on the host machine** that has the cashier attached.

The static build uses relative asset paths (`base: './'`), so it works under a project Pages URL. Pages requires HTTPS/localhost for Web Serial.

## Host smoke test

Simulator:

1. Open the Pages URL on the host.
2. Choose **Open simulator**.
3. Click **Run preflight** and confirm `captured · type2` with the exact tx/rx bytes.

Hardware:

1. Choose **Connect Web Serial** and select the cashier.
2. Click **Run preflight**.
3. Download the JSONL and/or text log.
4. Confirm the log contains the exact preflight tx and the raw Type2 response, with no currency read or write.

Web Serial settings: **9600 8N1, no flow control**, known device filter `0xFFF0:0x0100`. The exact preflight is:

```text
01 30 30 32 3a 20 30 30 34 3a 05 30 31 3b 3f 03
```

Response timeout: 500 ms; NAK retry: once after 3000 ms; ambiguous or unrecognised frames are preserved as `captureOnly`. See [i90-frame-format.md](docs/datecs/i90-frame-format.md), [protocol-comparison.md](docs/datecs/protocol-comparison.md) and [host-capture-runbook.md](docs/datecs/host-capture-runbook.md).

No Docker USB passthrough is used. The DSH/container environment is for building and tests only; hardware access belongs to the host browser. WebUSB is intentionally dropped: on macOS the serial driver owns interface 0 and `claimInterface` fails. Web Serial is the only supported path.

## Quality gates

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # Biome lint + format check
npm run dupes       # jscpd duplication threshold
npm test            # Vitest
npm run build       # typecheck + Vite production build
npm run check       # all of the above except build
```

GitHub Actions runs on pushes to `main` and on pull requests; deployment is `main`-only. It runs `npm ci`, typecheck, Biome, jscpd, tests and build. The duplication threshold is 3%; tests and generated files are excluded.

## Architecture and terms

- `src/app` — composition and external NBP client wiring
- `src/adapters` — Web Serial, simulator and NBP HTTP adapters
- `src/domain` — capture log, NBP selection/staleness
- `src/ports` — transport, clock, lock and capture contracts
- `src/protocol` — preflight bytes and Type2/wrapped response parsing
- `src/session` — connection, lock and preflight orchestration
- `src/ui` — one-page operator UI

**NBP** means Narodowy Bank Polski. **I90 Type2** is the short ASCII handshake response observed from the WP-25 Plus. The **short preflight** means the `002: 004:` request, not the response `short` candidate mode.

## Current scope

Web Serial for hardware; an explicit simulator for the same preflight path. The app connects, sends the exact short preflight, captures and validates the I90 Type2 response, and shows the previous-business-day NBP USD/EUR reference rates with effective date and stale handling. It sends no `0xFF`, currency read or write.

The read/write epic remains gated on a real currency-read capture plus a non-production test device or an approved-risk decision. The current app is capture/reference-only.

## License

MIT. See [LICENSE](LICENSE).
