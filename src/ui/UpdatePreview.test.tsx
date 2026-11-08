import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NbpSnapshot } from '../domain/nbp';
import type {
  ConverterSnapshot,
  ForeignRecordSnapshot,
  FullUpdateResult,
} from '../domain/update-plan';
import type { NbpState } from './NbpPanel';
import { UpdatePreview } from './UpdatePreview';

const foreign: ForeignRecordSnapshot = {
  slot0Name: 'USD',
  slot0Rate: '39251',
  slot1Name: 'EUR',
  slot1Rate: '43955',
  slot0FullName: 'US Dollar',
  slot0ChangeAfterZ: '1',
  slot1FullName: 'Euro',
  slot1ChangeAfterZ: '0',
};

const converter: ConverterSnapshot = { name: 'USD', rate: '39251', printFlag: '1' };

const nbpData: NbpSnapshot = {
  today: '2026-11-07',
  ageDays: 1,
  stale: false,
  fetchedAt: '2026-11-07T10:00:00.000Z',
  table: {
    effectiveDate: '2026-11-06',
    no: '215/A/NBP/2026',
    table: 'A',
    rates: [
      { code: 'USD', currency: 'dolar amerykański', mid: '3.9321' },
      { code: 'EUR', currency: 'euro', mid: '4.3925' },
    ],
  },
};

const nbp: NbpState = { status: 'ready', data: nbpData };

const staleNbp: NbpState = {
  status: 'ready',
  data: { ...nbpData, ageDays: 8, stale: true },
};

const noDiffForeign: ForeignRecordSnapshot = {
  ...foreign,
  slot0Rate: '39321',
  slot1Rate: '43925',
};

const noDiffConverter: ConverterSnapshot = { name: 'USD', rate: '39321', printFlag: '1' };

const restoredResult: FullUpdateResult = {
  backups: { usd: '39251', eur: '43955', converter: '39251', printFlag: '1' },
  targets: { usdRaw: 39321, eurRaw: 43925, converterRaw: 39321, printFlag: '1' },
  outcome: 'restored',
  restored: true,
};

type PreviewProps = ComponentProps<typeof UpdatePreview>;

function markup(overrides: Partial<PreviewProps> = {}): string {
  return renderToStaticMarkup(
    <UpdatePreview
      foreign={foreign}
      converter={converter}
      nbp={nbp}
      readFresh
      updateState="idle"
      onRequestUpdate={() => undefined}
      {...overrides}
    />,
  );
}

function render(readFresh: boolean): string {
  return markup({
    readFresh,
    readAt: readFresh ? undefined : '2026-11-06T08:00:00.000Z',
  });
}

describe('UpdatePreview', () => {
  it('renders the review trigger, signed changes and semantic records', () => {
    const html = render(true);
    expect(html).toContain('Review update');
    expect(html).not.toContain('>Update cashier<');
    expect(html).not.toContain('NBP target');
    expect(html).toContain('Update to');
    expect(html).toContain('Change');
    expect(html).toContain('+0.0070');
    expect(html).toContain('−0.0030');
    expect(html).toContain('class="records"');
    expect(html).toContain('Print currency converter after update');
    expect(html).toContain('US Dollar');
    expect(html).not.toMatch(/<button[^>]*aria-disabled="true"[^>]*>Review update/);
  });

  it('disables the review trigger with a visible reason when the read is not fresh', () => {
    const html = render(false);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Review update/);
    expect(html).toContain('Cashier records are not current.');
    expect(html).toContain('the values above are the last complete read');
    expect(html).toContain('Last read');
  });

  it('keeps a disabled Review update when no plan exists after a failed first read', () => {
    const html = renderToStaticMarkup(
      <UpdatePreview
        nbp={nbp}
        readFresh={false}
        updateState="idle"
        onRequestUpdate={() => undefined}
      />,
    );
    expect(html).toContain('Complete the foreign reads');
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Review update/);
    expect(html).toContain('Cashier records are incomplete.');
  });

  it('disables Review when the print flag is unavailable', () => {
    const html = markup({ converter: { ...converter, printFlag: undefined } });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Review update/);
    expect(html).toContain('A current rate or print flag is unavailable.');
  });

  it('disables Review when the converter record is incomplete', () => {
    const html = markup({ converter: undefined });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Review update/);
    expect(html).toContain('converter record is unavailable');
  });
  it('seeds the print setting from a current flag of 0 without checking it', () => {
    const html = markup({ converter: { ...converter, printFlag: '0' } });
    expect(html).not.toMatch(/<input[^>]*checked=""/);
    expect(html).toContain('Disabled → Disabled');
  });

  it('seeds the print setting from a current flag of 1 as checked', () => {
    const html = markup();
    expect(html).toMatch(/<input[^>]*checked=""/);
    expect(html).toContain('Enabled → Enabled');
  });

  it('disables Review with the stale reason when the NBP table is stale', () => {
    const html = markup({ nbp: staleNbp });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Review update/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain('NBP table is stale (older than seven calendar days).');
    expect(html).toContain('Refresh the reference before updating.');
  });

  it('disables Review after any failed update, including a verified restore', () => {
    const html = markup({ updateState: 'failed', updateResult: restoredResult });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Review update/);
    expect(html).toContain('The last update failed. Read the cashier again before retrying.');
    expect(html).toContain('Update failed; original records were restored.');
  });

  it('reports an aborted update as no write, not a restore', () => {
    const html = markup({
      updateState: 'failed',
      updateResult: { ...restoredResult, outcome: 'not-written' },
    });
    expect(html).toContain('Update aborted before writing; records are unchanged.');
    expect(html).not.toContain('original records were restored');
  });

  it('disables Review with the no-difference reason', () => {
    const html = markup({ foreign: noDiffForeign, converter: noDiffConverter });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Review update/);
    expect(html).toContain(
      'No changes: USD/EUR, converter rate and print flag already match the target.',
    );
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });
});
