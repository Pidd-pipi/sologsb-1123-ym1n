import type { PendingDraftKind } from '../types/batch';

const FAULT_KEY = 'gbdronemap:fault';

/**
 * 故障注入（调试 / 演示用）：
 * 在控制台执行 localStorage.setItem('gbdronemap:fault', 'params') 或 'assets'，
 * 下一次对应保存会在写入前失败，以验证「失败草稿落盘、不写一半、可重试」。
 * 故障一次性消费，重试前无需清理。
 */
export function armFault(kind: PendingDraftKind): void {
  try {
    window.localStorage.setItem(FAULT_KEY, kind);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 读取并消费一次故障标记 */
export function consumeFault(kind: PendingDraftKind): boolean {
  try {
    if (window.localStorage.getItem(FAULT_KEY) === kind) {
      window.localStorage.removeItem(FAULT_KEY);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
