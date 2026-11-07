export type CaptureFormat = 'jsonl' | 'text';

export interface CaptureSource {
  captureJsonl(): string;
  captureText(): string;
}

export interface CaptureDownload {
  filename: string;
  text: string;
  mime: string;
}

export function captureDownload(
  format: CaptureFormat,
  source: CaptureSource,
  now = new Date(),
): CaptureDownload {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  if (format === 'jsonl') {
    return {
      filename: `datecs-wp25-capture-${stamp}.jsonl`,
      text: source.captureJsonl(),
      mime: 'application/x-ndjson',
    };
  }
  return {
    filename: `datecs-wp25-capture-${stamp}.txt`,
    text: source.captureText(),
    mime: 'text/plain',
  };
}

export function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text || '\n'], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
