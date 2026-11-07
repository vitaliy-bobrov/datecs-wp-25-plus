import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('uses the primary tone for the update commit', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Apply NBP update?"
        confirmLabel="Update cashier"
        confirmTone="primary"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        Body
      </ConfirmDialog>,
    );
    expect(html).toContain('class="button primary"');
    expect(html).toContain('Update cashier');
  });

  it('keeps the danger tone for destructive confirmation', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Clear the device log?"
        confirmLabel="Clear"
        confirmTone="danger"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        Body
      </ConfirmDialog>,
    );
    expect(html).toContain('class="button danger"');
    expect(html).toContain('Clear');
  });
});
