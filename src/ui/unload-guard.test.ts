import { describe, expect, it, vi } from 'vitest';
import { installUnloadGuard } from './unload-guard';

type Listener = (event: BeforeUnloadEvent) => void;

function fakeTarget(): {
  target: {
    addEventListener: (type: 'beforeunload', listener: Listener) => void;
    removeEventListener: (type: 'beforeunload', listener: Listener) => void;
  };
  listeners: Listener[];
} {
  const listeners: Listener[] = [];
  return {
    listeners,
    target: {
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
      removeEventListener: (_type, listener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
  };
}

describe('unload guard', () => {
  it('registers a beforeunload listener that asks the browser to confirm', () => {
    const { target, listeners } = fakeTarget();
    const event = { preventDefault: vi.fn(), returnValue: 'keep' } as unknown as BeforeUnloadEvent;

    const cleanup = installUnloadGuard(target);

    expect(listeners).toHaveLength(1);
    listeners[0]?.(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe('');

    cleanup();
    expect(listeners).toHaveLength(0);
  });
});
