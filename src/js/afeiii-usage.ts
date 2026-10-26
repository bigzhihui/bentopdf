/** Explicit operation hooks. Never accept content, file names, URLs or errors. */
export function usageEvent(phase: 'entry' | 'download', tool?: string) {
  if (typeof document === 'undefined' || typeof crypto === 'undefined' || !crypto.randomUUID) {
    return;
  }
  document.dispatchEvent(new CustomEvent('afeiii:usage', { detail: { id: crypto.randomUUID(), phase, tool } }));
}

export function usageOperation(tool?: string) {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '';
  let finished = false;
  const emit = (phase: string) => {
    if (!id || typeof document === 'undefined') {
      return;
    }
    document.dispatchEvent(new CustomEvent('afeiii:usage', { detail: { id, phase, tool } }));
  };
  emit('start');
  return {
    success() {
      if (!finished) {
        finished = true;
        emit('success');
      }
    },
    failure() {
      if (!finished) {
        finished = true;
        emit('failure');
      }
    },
    download() {
      emit('download');
    },
  };
}
