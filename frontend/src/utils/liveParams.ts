import type { RouteParams } from '../hooks/useRouteMetrics';

const KEY_PREFIX = 'gbdronemap:live-params:';

/** 读取某任务未保存的实时航线参数（切换批次时不丢失草稿） */
export function readLiveParams(missionId: string): RouteParams | null {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + missionId);
    return raw ? (JSON.parse(raw) as RouteParams) : null;
  } catch {
    return null;
  }
}

/** 写入某任务未保存的实时航线参数 */
export function writeLiveParams(missionId: string, params: RouteParams): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + missionId, JSON.stringify(params));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 保存后清除某任务的实时参数草稿 */
export function clearLiveParams(missionId: string): void {
  try {
    window.localStorage.removeItem(KEY_PREFIX + missionId);
  } catch {
    /* ignore */
  }
}
