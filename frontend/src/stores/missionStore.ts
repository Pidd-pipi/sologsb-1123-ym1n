import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { bumpTick } from '../utils/tick';
import { buildInitialBatch, useBatchStore } from './batchStore';
import type { CameraSnapshot, RouteBatch } from '../types/batch';
import type { CameraPreset, Mission, MissionDraft, MissionStatus } from '../types/mission';

interface MissionState {
  items: Mission[];
  presets: CameraPreset[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: MissionDraft) => Promise<Mission>;
  update: (id: string, patch: Partial<Mission>) => Promise<void>;
  setStatus: (id: string, status: MissionStatus) => Promise<void>;
  /** 带入相机预设：任务相机字段更新并立即开新航线批次 */
  applyPreset: (missionId: string, presetId: string) => Promise<{ ok: boolean; error?: string; noop?: boolean }>;
  addPreset: (draft: Omit<CameraPreset, 'id'>) => Promise<CameraPreset>;
  removePreset: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useMissionStore = create<MissionState>((set, get) => ({
  items: [],
  presets: [],
  loaded: false,
  async load() {
    const rows = await db.missions.orderBy('createdAt').reverse().toArray();
    const presets = await db.presets.toArray();
    set({ items: rows, presets, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const record: Mission = { ...draft, id: newId('mission'), createdAt: now };
    // 新任务与初始批次同事务写入，避免只写一半
    const initialBatch: RouteBatch = buildInitialBatch(record, now);
    await db.transaction('rw', [db.missions, db.batches], async () => {
      await db.missions.put(record);
      await db.batches.put(initialBatch);
    });
    set({ items: [record, ...get().items] });
    useBatchStore.setState({ items: [...useBatchStore.getState().items, initialBatch] });
    bumpTick(record.id);
    return record;
  },
  async update(id, patch) {
    await db.missions.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async setStatus(id, status) {
    await get().update(id, { status });
    bumpTick(id);
  },
  async applyPreset(missionId, presetId) {
    const preset = get().presets.find((p) => p.id === presetId);
    if (!preset) return { ok: false, error: '相机预设不存在' };
    const camera: CameraSnapshot = {
      cameraModel: preset.cameraModel,
      sensorWidth: preset.sensorWidth,
      sensorHeight: preset.sensorHeight,
      focalLength: preset.focalLength,
      pixelSize: preset.pixelSize,
    };
    const res = await useBatchStore.getState().applyCameraChange(missionId, camera);
    if (res.kind === 'ok' || res.kind === 'noop') {
      set({ items: get().items.map((it) => (it.id === missionId ? { ...it, ...camera } : it)) });
    }
    return { ok: res.kind === 'ok', noop: res.kind === 'noop', error: res.error };
  },
  async addPreset(draft) {
    const record: CameraPreset = { ...draft, id: newId('preset') };
    await db.presets.put(record);
    set({ presets: [...get().presets, record] });
    return record;
  },
  async removePreset(id) {
    await db.presets.delete(id);
    set({ presets: get().presets.filter((p) => p.id !== id) });
  },
  async remove(id) {
    // 级联删除任务下的全部批次、航点、成果、缩略图与挂起稿（单事务，不会残留半套数据）
    await db.transaction(
      'rw',
      [db.missions, db.batches, db.waypoints, db.assets, db.thumbs, db.drafts],
      async () => {
        await db.drafts.where('missionId').equals(id).delete();
        await db.waypoints.where('missionId').equals(id).delete();
        await db.assets.where('missionId').equals(id).delete();
        await db.thumbs.where('missionId').equals(id).delete();
        await db.batches.where('missionId').equals(id).delete();
        await db.missions.delete(id);
      },
    );
    set({ items: get().items.filter((it) => it.id !== id) });
    const batchState = useBatchStore.getState();
    useBatchStore.setState({
      items: batchState.items.filter((b) => b.missionId !== id),
      drafts: batchState.drafts.filter((d) => d.missionId !== id),
    });
    bumpTick(id);
  },
}));
