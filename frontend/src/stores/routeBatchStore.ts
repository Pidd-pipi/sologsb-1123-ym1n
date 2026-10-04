import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeThumbDataUrl, type ImageQuality } from '../types/imageasset';
import type { LngLat } from '../types/mission';
import type { ConflictDraft, RouteBatch } from '../types/routeBatch';
import type { WaypointAction } from '../types/waypoint';
import { useAssetStore } from './assetStore';
import { useWaypointStore } from './waypointStore';

const SELECTED_KEY = 'gbdronemap:selected-batch';
const CONFLICT_KEY = 'gbdronemap:conflict-draft';
/** 跨标签页同步信号：保存批次后自增，其他标签页监听后重载批次 */
export const BATCHES_SYNC_KEY = 'gbdronemap:batches-sync';

export interface BatchParams {
  altitude: number;
  speed: number;
  overlapForward: number;
  overlapSide: number;
  heading: number;
  areaPolygon: LngLat[];
}

export interface BatchMetrics {
  estPhotos: number;
  estDuration: number;
  gsd: number;
  spacing: number;
  photoInterval: number;
  batteryCount: number;
}

export type SaveBatchResult =
  | { ok: true; batch: RouteBatch; created: boolean }
  | { ok: false; reason: 'conflict'; conflictBatch: RouteBatch }
  | { ok: false; reason: 'error'; error: unknown };

interface PendingSave {
  missionId: string;
  params: BatchParams;
  metrics: BatchMetrics;
  expectedActiveBatchId: string;
}

interface RouteBatchState {
  batches: RouteBatch[];
  loaded: boolean;
  /** 每个任务当前选中的批次（UI 状态，持久化） */
  selectedBatchIdByMission: Record<string, string>;
  /** 过期标签页提交时保留的冲突稿 */
  conflictDraft: ConflictDraft | null;
  /** 保存失败后待重试的草稿 */
  pendingSave: PendingSave | null;
  load: () => Promise<void>;
  getActive: (missionId: string) => RouteBatch | undefined;
  getByMission: (missionId: string) => RouteBatch[];
  getSelected: (missionId: string) => RouteBatch | undefined;
  setSelectedBatch: (missionId: string, batchId: string) => void;
  /** 参数改动后标记当前批失效（预计张数需重算保存） */
  markStale: (missionId: string) => Promise<void>;
  /** 保存：冲突检测 + 事务内冻结旧批 / 建新批（或仅刷新指标），失败可重试 */
  saveBatch: (
    missionId: string,
    params: BatchParams,
    metrics: BatchMetrics,
    expectedActiveBatchId: string,
  ) => Promise<SaveBatchResult>;
  /** 合并冲突稿：按片号合并成果（只增不覆），按序号合并航点（只增不覆） */
  mergeConflictDraft: (missionId: string, draft: ConflictDraft) => Promise<{
    addedAssets: number;
    skippedAssets: number;
    addedWaypoints: number;
    skippedWaypoints: number;
  }>;
  setConflictDraft: (draft: ConflictDraft | null) => void;
  setPendingSave: (pending: PendingSave | null) => void;
  retrySave: () => Promise<SaveBatchResult | null>;
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 保存批次后通知其他标签页重载（跨标签页同步） */
export function bumpBatchesSync(): void {
  try {
    window.localStorage.setItem(BATCHES_SYNC_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

function buildBatch(
  mission: { cameraModel: string; sensorWidth: number; sensorHeight: number; focalLength: number; pixelSize: number },
  params: BatchParams,
  metrics: BatchMetrics,
  id: string,
  missionId: string,
  batchNo: number,
  now: number,
): RouteBatch {
  return {
    id,
    missionId,
    batchNo,
    label: batchNo === 1 ? '初始批' : `批次 ${batchNo}`,
    status: 'active',
    altitude: params.altitude,
    speed: params.speed,
    overlapForward: params.overlapForward,
    overlapSide: params.overlapSide,
    heading: params.heading,
    cameraModel: mission.cameraModel,
    sensorWidth: mission.sensorWidth,
    sensorHeight: mission.sensorHeight,
    focalLength: mission.focalLength,
    pixelSize: mission.pixelSize,
    areaPolygon: params.areaPolygon,
    estPhotos: metrics.estPhotos,
    estDuration: metrics.estDuration,
    gsd: metrics.gsd,
    spacing: metrics.spacing,
    photoInterval: metrics.photoInterval,
    batteryCount: metrics.batteryCount,
    createdAt: now,
    frozenAt: null,
    stale: false,
  };
}

export const useRouteBatchStore = create<RouteBatchState>((set, get) => ({
  batches: [],
  loaded: false,
  selectedBatchIdByMission: readStorage<Record<string, string>>(SELECTED_KEY) ?? {},
  conflictDraft: readStorage<ConflictDraft>(CONFLICT_KEY),
  pendingSave: null,

  async load() {
    const rows = await db.batches.toArray();
    rows.sort((a, b) => a.batchNo - b.batchNo);
    set({ batches: rows, loaded: true });
  },

  getActive(missionId) {
    return get().batches.find((b) => b.missionId === missionId && b.status === 'active');
  },

  getByMission(missionId) {
    return get()
      .batches.filter((b) => b.missionId === missionId)
      .sort((a, b) => a.batchNo - b.batchNo);
  },

  getSelected(missionId) {
    const list = get().getByMission(missionId);
    const selectedId = get().selectedBatchIdByMission[missionId];
    return list.find((b) => b.id === selectedId) || get().getActive(missionId) || list[0];
  },

  setSelectedBatch(missionId, batchId) {
    const next = { ...get().selectedBatchIdByMission, [missionId]: batchId };
    set({ selectedBatchIdByMission: next });
    writeStorage(SELECTED_KEY, next);
  },

  async markStale(missionId) {
    const active = get().getActive(missionId);
    if (!active || active.stale) return;
    await db.batches.update(active.id, { stale: true });
    set({ batches: get().batches.map((b) => (b.id === active.id ? { ...b, stale: true } : b)) });
  },

  async saveBatch(missionId, params, metrics, expectedActiveBatchId) {
    const newBatchId = newId('batch');
    try {
      const result = await db.transaction('rw', [db.batches, db.waypoints, db.missions], async () => {
        const mission = await db.missions.get(missionId);
        if (!mission) throw new Error('任务不存在');
        // 冲突检测在事务内进行，与写入原子化：其他标签页已建新批则中止
        const currentActive = await db.batches
          .where('missionId')
          .equals(missionId)
          .filter((b) => b.status === 'active')
          .first();
        if (currentActive && currentActive.id !== expectedActiveBatchId) {
          const err = new Error('conflict') as Error & { conflictBatch: RouteBatch };
          err.conflictBatch = currentActive;
          throw err;
        }
        const now = Date.now();
        if (currentActive && currentActive.stale) {
          // 参数已改动：冻结当前批（航点随之冻结），复制航点到新批
          await db.batches.update(currentActive.id, { status: 'frozen', frozenAt: now, stale: false });
          const wps = await db.waypoints.where('batchId').equals(currentActive.id).toArray();
          const copies = wps.map((w) => ({ ...w, id: newId('wp'), batchId: newBatchId }));
          await db.waypoints.bulkPut(copies);
          const batchNo = currentActive.batchNo + 1;
          const newBatch = buildBatch(mission, params, metrics, newBatchId, missionId, batchNo, now);
          await db.batches.add(newBatch);
          return { batch: newBatch, created: true };
        } else if (currentActive) {
          // 无参数改动：仅刷新当前批指标
          await db.batches.update(currentActive.id, {
            estPhotos: metrics.estPhotos,
            estDuration: metrics.estDuration,
            gsd: metrics.gsd,
            spacing: metrics.spacing,
            photoInterval: metrics.photoInterval,
            batteryCount: metrics.batteryCount,
            stale: false,
          });
          return {
            batch: { ...currentActive, ...metrics, stale: false },
            created: false,
          };
        } else {
          // 尚无批次：创建初始批
          const newBatch = buildBatch(mission, params, metrics, newBatchId, missionId, 1, now);
          await db.batches.add(newBatch);
          return { batch: newBatch, created: true };
        }
      });
      await get().load();
      if (result.created) get().setSelectedBatch(missionId, result.batch.id);
      set({ pendingSave: null });
      bumpBatchesSync();
      return { ok: true, ...result };
    } catch (e) {
      const err = e as (Error & { conflictBatch?: RouteBatch }) | undefined;
      if (err?.conflictBatch) {
        return { ok: false, reason: 'conflict', conflictBatch: err.conflictBatch };
      }
      // 保存失败：保留草稿以便重试，不能只写一半（事务已回滚）
      const pending: PendingSave = { missionId, params, metrics, expectedActiveBatchId };
      set({ pendingSave: pending });
      return { ok: false, reason: 'error', error: e };
    }
  },

  async mergeConflictDraft(missionId, draft) {
    const active = await db.batches
      .where('missionId')
      .equals(missionId)
      .filter((b) => b.status === 'active')
      .first();
    if (!active) throw new Error('当前没有可合并的活动批次');
    let addedAssets = 0;
    let skippedAssets = 0;
    let addedWaypoints = 0;
    let skippedWaypoints = 0;
    await db.transaction('rw', [db.batches, db.waypoints, db.assets, db.thumbs], async () => {
      // 按片号合并成果：已存在同片号则跳过（先提交内容不被覆盖）
      const existingImageNos = new Set(
        (await db.assets.where('missionId').equals(missionId).toArray()).map((a) => a.imageNo),
      );
      const newAssets = draft.assets.filter((a) => !existingImageNos.has(a.imageNo));
      skippedAssets = draft.assets.length - newAssets.length;
      const assetRecords = newAssets.map((d) => ({
        ...d,
        id: newId('asset'),
        missionId,
        batchId: active.id,
        quality: d.quality as ImageQuality,
      }));
      if (assetRecords.length) await db.assets.bulkPut(assetRecords);
      addedAssets = assetRecords.length;
      const thumbRecords = assetRecords.map((r) => ({
        id: r.id,
        missionId,
        dataUrl: makeThumbDataUrl(r.imageNo, r.quality, r.lng, r.lat),
      }));
      if (thumbRecords.length) await db.thumbs.bulkPut(thumbRecords);
      // 按序号合并航点：已存在同序号则跳过
      const existingSeqs = new Set(
        (await db.waypoints.where('missionId').equals(missionId).toArray()).map((w) => w.seq),
      );
      const newWaypoints = draft.waypoints.filter((w) => !existingSeqs.has(w.seq));
      skippedWaypoints = draft.waypoints.length - newWaypoints.length;
      const wpRecords = newWaypoints.map((d) => ({
        ...d,
        id: newId('wp'),
        missionId,
        batchId: active.id,
        action: d.action as WaypointAction,
      }));
      if (wpRecords.length) await db.waypoints.bulkPut(wpRecords);
      addedWaypoints = wpRecords.length;
    });
    await Promise.all([useAssetStore.getState().load(), useWaypointStore.getState().load()]);
    get().setConflictDraft(null);
    return { addedAssets, skippedAssets, addedWaypoints, skippedWaypoints };
  },

  setConflictDraft(draft) {
    set({ conflictDraft: draft });
    if (draft) writeStorage(CONFLICT_KEY, draft);
    else {
      try {
        window.localStorage.removeItem(CONFLICT_KEY);
      } catch {
        /* ignore */
      }
    }
  },

  setPendingSave(pending) {
    set({ pendingSave: pending });
  },

  async retrySave() {
    const pending = get().pendingSave;
    if (!pending) return null;
    return get().saveBatch(pending.missionId, pending.params, pending.metrics, pending.expectedActiveBatchId);
  },
}));
