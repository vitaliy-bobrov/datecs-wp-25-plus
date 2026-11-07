export interface DeviceLock {
  readonly supported: boolean;
  isHeld(): boolean;
  acquire(): Promise<boolean>;
}

const LOCK_NAME = 'datecs-wp25-device';

export class BrowserDeviceLock implements DeviceLock {
  readonly supported =
    typeof navigator !== 'undefined' && typeof navigator.locks !== 'undefined';

  private held = false;

  isHeld(): boolean {
    return this.held;
  }

  async acquire(): Promise<boolean> {
    if (!this.supported) return false;
    if (this.held) return true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      navigator.locks
        ?.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (!lock) {
            finish(false);
            return;
          }

          this.held = true;
          finish(true);

          // The tab keeps the Web Lock for its lifetime. Releasing the page releases it.
          await new Promise<void>(() => {});
        })
        .catch(() => finish(false));
    });
  }
}
