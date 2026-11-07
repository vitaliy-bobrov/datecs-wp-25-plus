# Datecs WP-25 Plus — currency reader

Vite/React/TypeScript app with connection diagnostics, the known short preflight, local/foreign/converter reads, an NBP comparison and update preview. It sends no `0xFF` and no rate write; the only write is an explicit slot-0 full-name diagnostic test with readback and restore.

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
4. Open the Pages URL in Chrome or Edge in the browser with the cashier attached.

The static build uses relative asset paths (`base: './'`), so it works under a project Pages URL. Web Serial requires a secure browser context (HTTPS or a local development origin).

## Hardware smoke test

Simulator:

1. Open the Pages URL in the browser.
2. Choose **Open simulator**; the preflight runs automatically.
3. Confirm `captured · type2` with the exact tx/rx bytes; use **Run preflight** to retry.

Hardware:

1. Choose **Connect Web Serial** and select the cashier. The preflight, foreign reads and converter read run automatically.
2. Use the read buttons only for a retry.
3. Download the JSONL and/or text log.
4. Confirm the read records. The local frame set runs automatically only as the proven read bootstrap and its values are not shown. No rate write is sent; the one-field full-name test is separate and requires explicit confirmation.

Web Serial settings: **9600 8N1, no flow control**, known device filter `0xFFF0:0x0100`. The exact preflight is:

```text
01 30 30 32 3a 20 30 30 34 3a 05 30 31 3b 3f 03
```

Preflight timeout: 500 ms; NAK retry: once after 3000 ms; ambiguous or unrecognised preflight frames are preserved as `captureOnly`. Read-frame failures are logged without a capture-only fallback.

WebUSB is not supported. Web Serial is the only supported transport.

## Quality gates

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # Biome lint + format check
npm run knip        # unused files, exports, types and dependencies
npm run dupes       # jscpd duplication threshold
npm test            # Vitest
npm run build       # typecheck + Vite production build
npm run check       # all of the above except build
```

GitHub Actions runs on pushes to `main` and on pull requests; deployment is `main`-only. It runs `npm ci`, typecheck, Biome, Knip, jscpd, tests and build. The duplication threshold is 3%; tests and generated files are excluded.

## Architecture and terms

- `src/app` — composition and external NBP client wiring
- `src/adapters` — Web Serial, simulator and NBP HTTP adapters
- `src/domain` — capture log, NBP selection/staleness, rate normalization and update preview
- `src/ports` — transport, clock, lock and error contracts
- `src/protocol` — preflight, local/foreign/converter reads and the one-field write frame
- `src/session` — connection, lock, read sequences, comparison state and the guarded write test
- `src/ui` — one-page operator UI

**NBP** means Narodowy Bank Polski. **I90 Type2** is the short ASCII handshake response observed from the WP-25 Plus. The **short preflight** means the `002: 004:` request, not the response `short` candidate mode.

## Current scope

Web Serial for hardware; an explicit simulator for the same preflight path. Connect automatically runs the short preflight, the two foreign-slot reads (name, full name, four-decimal rate and Change-after-Z flag) and the converter read, then compares them with NBP and shows the previous-business-day NBP USD/EUR reference rates with effective date and stale handling. It sends no `0xFF`; the only write is an explicit slot-0 full-name test with readback and restore. The connection reuses the last granted port when available; otherwise it opens the browser picker.

An update preview shows the exact four-decimal targets from NBP against the read records. The only device write is the explicitly confirmed slot-0 full-name marker/restore test; rate, multi-field and converter writes are not implemented.


## Boundary validation

Knip is the boundary gate: `knip.json` declares the project globs; Knip derives entry points from Vite/index.html, and CI fails on unused files, exports, exported types or dependencies. Remove dead modules rather than suppressing them.

## License

MIT. See [LICENSE](LICENSE).
