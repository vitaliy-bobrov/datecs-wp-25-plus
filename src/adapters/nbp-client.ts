import {
  NbpError,
  type NbpSnapshot,
  parseNbpTables,
  selectPreviousTable,
  toSnapshot,
  warsawDate,
} from '../domain/nbp';

const NBP_URL = 'https://api.nbp.pl/api/exchangerates/tables/A/?format=json';
const TIMEOUT_MS = 8000;

export class NbpClient {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchPreviousRates(): Promise<NbpSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await this.fetcher(NBP_URL, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new NbpError('timeout', 'NBP request timed out.');
        }
        throw new NbpError('fetch-failed', 'NBP request failed.');
      }

      if (!response.ok) {
        throw new NbpError('fetch-failed', `NBP returned HTTP ${response.status}.`);
      }

      const raw = await response.text();
      const tables = parseNbpTables(raw);
      const now = this.now();
      const today = warsawDate(now);
      const table = selectPreviousTable(tables, today);
      if (!table) {
        throw new NbpError('unavailable', 'No table exists before today.');
      }
      return toSnapshot(table, today, now.toISOString());
    } finally {
      clearTimeout(timeout);
    }
  }
}
