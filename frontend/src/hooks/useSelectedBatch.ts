import { useCallback, useSyncExternalStore } from 'react';

const SEL_KEY = 'gbdronemap:selected-batch';

function readMap(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(SEL_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  try {
    window.localStorage.setItem(SEL_KEY, JSON.stringify(map));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SEL_KEY) listeners.forEach((l) => l());
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 各任务当前查看的批次（地图 / 航点表 / 成果编目共享同一份选择，
 * localStorage 持久化且跨标签页同步）。
 */
export function useSelectedBatch(missionId: string): { batchId: string | undefined; setBatchId: (id: string) => void } {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(SEL_KEY) ?? '{}',
    () => '{}',
  );
  const map: Record<string, string> = JSON.parse(snapshot || '{}') as Record<string, string>;
  const setBatchId = useCallback(
    (id: string) => {
      const next = readMap();
      next[missionId] = id;
      writeMap(next);
      listeners.forEach((l) => l());
    },
    [missionId],
  );
  return { batchId: map[missionId], setBatchId };
}
