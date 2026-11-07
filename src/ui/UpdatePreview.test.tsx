import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConverterSnapshot, ForeignRecordSnapshot } from '../domain/update-plan';
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

const nbp: NbpState = {
  status: 'ready',
  data: {
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
  },
};

function render(readFresh: boolean): string {
  return renderToStaticMarkup(
    <UpdatePreview
      foreign={foreign}
      converter={converter}
      nbp={nbp}
      readFresh={readFresh}
      updateState="idle"
      onRequestUpdate={() => undefined}
    />,
  );
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
    expect(html).toContain('Cashier records are not current.');
  });
});
