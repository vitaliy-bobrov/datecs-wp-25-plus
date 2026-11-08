export interface UnloadGuardTarget {
  addEventListener: (type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void) => void;
  removeEventListener: (type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void) => void;
}

export function installUnloadGuard(target: UnloadGuardTarget): () => void {
  const listener = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    event.returnValue = '';
  };
  target.addEventListener('beforeunload', listener);
  return () => target.removeEventListener('beforeunload', listener);
}
