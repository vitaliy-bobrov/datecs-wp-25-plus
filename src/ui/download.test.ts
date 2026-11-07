import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDownload, downloadText } from './download';

const source = {
  captureJsonl: () => '{"id":1}',
  captureText: () => 'id\t1',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('capture download', () => {
  it('maps JSONL and text to the right serializers, names and MIME types', () => {
    const now = new Date('2026-11-07T10:00:00.000Z');
    const jsonl = captureDownload('jsonl', source, now);
    const text = captureDownload('text', source, now);

    expect(jsonl.filename).toMatch(/\.jsonl$/);
    expect(jsonl.text).toBe('{"id":1}');
    expect(jsonl.mime).toBe('application/x-ndjson');
    expect(text.filename).toMatch(/\.txt$/);
    expect(text.text).toBe('id\t1');
    expect(text.mime).toBe('text/plain');
  });

  it('clicks a named anchor and revokes the object URL', () => {
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('document', {
      createElement: () => ({ href: '', download: '', click, remove }),
      body: { append },
    });

    downloadText('capture.jsonl', 'data', 'application/x-ndjson');

    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(append).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });
});
