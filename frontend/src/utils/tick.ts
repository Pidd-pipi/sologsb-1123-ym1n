const TICK_KEY = 'gbdronemap:tick';

export interface TickPayload {
  missionId: string;
  t: number;
}

/**
 * 批次数据在本标签页落库后戳一下 localStorage；
 * 其它标签页通过 storage 事件感知后重新加载 IndexedDB，
 * 以便提交时携带的 revision 尽量是最新的（漏刷新仍由乐观锁兜底为冲突稿）。
 */
export function bumpTick(missionId: string): void {
  try {
    const payload: TickPayload = { missionId, t: Date.now() };
    window.localStorage.setItem(TICK_KEY, JSON.stringify(payload));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 监听其它标签页的批次数据变更；返回取消监听函数 */
export function onTick(cb: (missionId: string) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key !== TICK_KEY || !e.newValue) return;
    try {
      const payload = JSON.parse(e.newValue) as TickPayload;
      cb(payload.missionId);
    } catch {
      /* 忽略无法解析的标记 */
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
