import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { bumpTick } from '../utils/tick';
import { computeBatchMetrics } from '../utils/batch';
import { useBatchStore } from './batchStore';
import type { Waypoint, WaypointDraft } from '../types/waypoint';

export class FrozenBatchError extends Error {
  constructor(batchLabel: string) {
    super(`该航点属于已冻结的${batchLabel}，航点改动只能进入新批次`);
    this.name = 'FrozenBatchError';
  }
}

interface WaypointState {
  items: Waypoint[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: WaypointDraft) => Promise<Waypoint>;
  addMany: (drafts: WaypointDraft[]) => Promise<Waypoint[]>;
  update: (id: string, patch: Partial<Waypoint>) => Promise<void>;
  move: (id: string, direction: 'up' | 'down') => Promise<void>;
  reorder: (fromId: string, toId: string) => Promise<void>;
  removeByBatch: (batchId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byBatch: (batchId: string) => Waypoint[];
  byMission: (missionId: string) => Waypoint[];
}

/**
 * 改动落库后，重算并冻结当前批次的预计张数等指标。
 * 航点编辑不推进 revision：参数稿的乐观锁只针对「开新批次」这一事件，
 * 与另一标签页的航点编辑互不判为冲突（成果提交仍由其提交时刻的批次承载）。
 */
async function refreshActiveBatch(missionId: string): Promise<void> {
  await db.transaction('rw', [db.batches, db.waypoints], async () => {
    const active = (await db.batches.where('missionId').equals(missionId).toArray()).find((b) => b.active);
    if (!active) return;
    const wps = (await db.waypoints.where('batchId').equals(active.id).toArray()).sort((a, b) => a.seq - b.seq);
    active.metrics = computeBatchMetrics(active.camera, active.areaPolygon, wps, active);
    active.updatedAt = Date.now();
    await db.batches.put(active);
  });
  await useBatchStore.getState().load();
  bumpTick(missionId);
}

export const useWaypointStore = create<WaypointState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.waypoints.toArray();
    rows.sort((a, b) => a.seq - b.seq);
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const record: Waypoint = { ...draft, id: newId('wp') };
    await db.transaction('rw', [db.waypoints, db.batches], async () => {
      await db.waypoints.put(record);
    });
    set({ items: [...get().items, record] });
    await refreshActiveBatch(record.missionId);
    return record;
  },
  async addMany(drafts) {
    const records: Waypoint[] = drafts.map((d) => ({ ...d, id: newId('wp') }));
    await db.waypoints.bulkPut(records);
    set({ items: [...get().items, ...records] });
    const missionId = records[0]?.missionId;
    if (missionId) await refreshActiveBatch(missionId);
    return records;
  },
  async update(id, patch) {
    const target = get().items.find((it) => it.id === id);
    if (target) {
      const batch = useBatchStore.getState().get(target.batchId);
      if (batch && !batch.active) throw new FrozenBatchError(batch.label);
    }
    await db.transaction('rw', db.waypoints, async () => {
      await db.waypoints.update(id, patch);
    });
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    if (target) await refreshActiveBatch(target.missionId);
  },
  /** 与相邻航点交换序号（限同一批次内） */
  async move(id, direction) {
    const list = get().byBatch(get().items.find((it) => it.id === id)?.batchId ?? '');
    const index = list.findIndex((it) => it.id === id);
    const target = direction === 'up' ? list[index - 1] : list[index + 1];
    if (!target) return;
    await get().reorder(id, target.id);
  },
  async reorder(fromId, toId) {
    const from = get().items.find((it) => it.id === fromId);
    const to = get().items.find((it) => it.id === toId);
    if (!from || !to || from.batchId !== to.batchId) return;
    const batch = useBatchStore.getState().get(from.batchId);
    if (batch && !batch.active) throw new FrozenBatchError(batch.label);
    const fromSeq = from.seq;
    await db.transaction('rw', db.waypoints, async () => {
      await db.waypoints.update(from.id, { seq: to.seq });
      await db.waypoints.update(to.id, { seq: fromSeq });
    });
    set({
      items: get().items.map((it) => {
        if (it.id === from.id) return { ...it, seq: to.seq };
        if (it.id === to.id) return { ...it, seq: fromSeq };
        return it;
      }),
    });
    await refreshActiveBatch(from.missionId);
  },
  async removeByBatch(batchId) {
    const missionId = get().items.find((it) => it.batchId === batchId)?.missionId;
    await db.waypoints.where('batchId').equals(batchId).delete();
    set({ items: get().items.filter((it) => it.batchId !== batchId) });
    if (missionId) await refreshActiveBatch(missionId);
  },
  async remove(id) {
    const target = get().items.find((it) => it.id === id);
    await db.waypoints.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
    if (target) await refreshActiveBatch(target.missionId);
  },
  byBatch(batchId) {
    return get()
      .items.filter((it) => it.batchId === batchId)
      .sort((a, b) => a.seq - b.seq);
  },
  byMission(missionId) {
    return get()
      .items.filter((it) => it.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
