import { create } from 'zustand';
import { db } from '../utils/db';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset, type ImageAssetDraft, type ImageQuality } from '../types/imageasset';

interface AssetState {
  items: ImageAsset[];
  thumbs: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * 成果入库须按拍摄时批次提交（带乐观锁 revision），
   * 保存失败 / 过期标签页的草稿由 batchStore.commitAssets 统一保留。
   */
  update: (id: string, patch: Partial<ImageAsset>) => Promise<void>;
  markMany: (ids: string[], quality: ImageQuality) => Promise<void>;
  removeMany: (ids: string[]) => Promise<void>;
  byBatch: (batchId: string) => ImageAsset[];
  byMission: (missionId: string) => ImageAsset[];
  qualityStats: (batchIds: string[]) => { quality: ImageQuality; count: number }[];
}

export const useAssetStore = create<AssetState>((set, get) => ({
  items: [],
  thumbs: {},
  loaded: false,
  async load() {
    const rows = await db.assets.toArray();
    rows.sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true }));
    const thumbRows = await db.thumbs.toArray();
    const thumbs: Record<string, string> = {};
    thumbRows.forEach((t) => {
      thumbs[t.id] = t.dataUrl;
    });
    set({ items: rows, thumbs, loaded: true });
  },
  async update(id, patch) {
    await db.assets.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async markMany(ids, quality) {
    // 质量标记为提交后的编辑操作：单事务批量更新，失败不留半成品
    await db.transaction('rw', db.assets, async () => {
      for (const id of ids) {
        await db.assets.update(id, { quality });
      }
    });
    set({ items: get().items.map((it) => (ids.includes(it.id) ? { ...it, quality } : it)) });
  },
  async removeMany(ids) {
    await db.transaction('rw', [db.assets, db.thumbs], async () => {
      await db.assets.bulkDelete(ids);
      await db.thumbs.bulkDelete(ids);
    });
    const nextThumbs = { ...get().thumbs };
    ids.forEach((id) => {
      delete nextThumbs[id];
    });
    set({ items: get().items.filter((it) => !ids.includes(it.id)), thumbs: nextThumbs });
  },
  byBatch(batchId) {
    return get().items.filter((it) => it.batchId === batchId);
  },
  byMission(missionId) {
    return get().items.filter((it) => it.missionId === missionId);
  },
  qualityStats(batchIds) {
    const scope = new Set(batchIds);
    const list = get().items.filter((it) => scope.has(it.batchId));
    return (['合格', '模糊', '过曝'] as ImageQuality[]).map((quality) => ({
      quality,
      count: list.filter((it) => it.quality === quality).length,
    }));
  },
}));

/** 批量编目时构造影像草稿（片号在批次内递增，batchId 为拍摄时批次） */
export function nextImageDrafts(args: {
  missionNo: string;
  missionId: string;
  batchId: string;
  baseTime: number;
  waypoints: Array<{ lng: number; lat: number; altitude: number; gimbalPitch: number }>;
  pixelSize: number;
  focalLength: number;
  existingNos: string[];
  gsd: number;
}): ImageAssetDraft[] {
  const { missionNo, missionId, batchId, baseTime, waypoints, pixelSize, focalLength, existingNos, gsd } = args;
  const nums = existingNos
    .map((no) => Number(no.replace(/^IMG_/, '')))
    .filter((n) => Number.isFinite(n));
  const start = (nums.length > 0 ? Math.max(...nums) : 1999) + 1;
  return waypoints.map((w, index) => ({
    missionId,
    batchId,
    imageNo: `IMG_${String(start + index)}`,
    lng: w.lng,
    lat: w.lat,
    altitude: w.altitude,
    gsd: Math.round(((pixelSize * w.altitude) / (focalLength * 10)) * 100) / 100 || gsd,
    overlap: 75,
    tiltAngle: Math.abs(w.gimbalPitch + 90),
    shotAt: baseTime + index * 1000,
    quality: '合格',
    folder: `/${missionNo}/${String(batchId).slice(-3).toUpperCase()}MEDIA`,
  }));
}

/** 重新生成单条缩略图（提交后缩略图缺失时使用） */
export function thumbOf(record: ImageAsset): AssetThumb {
  return {
    id: record.id,
    missionId: record.missionId,
    batchId: record.batchId,
    dataUrl: makeThumbDataUrl(record.imageNo, record.quality, record.lng, record.lat),
  };
}
