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

  it('keeps the commit enabled with no gate reason by default', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="Apply NBP update?"
        confirmLabel="Update cashier"
        confirmTone="primary"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        Body
      </ConfirmDialog>,
    );
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain('modal-reason');
  });

  it('disables the commit with a visible, associated gate reason', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="Apply NBP update?"
        confirmLabel="Update cashier"
        confirmTone="primary"
        confirmDisabled
        confirmReason="Confirm this is the cashier at the till to enable Update cashier."
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        Body
      </ConfirmDialog>,
    );
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Update cashier<\/button>/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain('Confirm this is the cashier at the till to enable Update cashier.');
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

  it('shows a fallback reason whenever confirm is disabled without copy', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Test"
        confirmLabel="Go"
        confirmTone="primary"
        confirmDisabled
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        Body
      </ConfirmDialog>,
    );
    expect(html).toContain('Complete the required confirmation to continue.');
  });
});
