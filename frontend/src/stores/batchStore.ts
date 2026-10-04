import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { bumpTick } from '../utils/tick';
import { consumeFault } from '../utils/faults';
import {
  computeBatchMetrics,
  describeChange,
  isSamePayload,
  mergeAssetsByImageNo,
  payloadOf,
  routeParamsOf,
  type AssetMergeResult,
} from '../utils/batch';
import type { CameraSnapshot } from '../types/batch';
import type { PendingDraft, BatchParamsPayload, RouteBatch } from '../types/batch';
import type { Mission } from '../types/mission';
import { makeThumbDataUrl, type AssetThumb, type ImageAssetDraft } from '../types/imageasset';
import { useAssetStore } from './assetStore';
import { useWaypointStore } from './waypointStore';

export type CommitKind = 'ok' | 'noop' | 'failed' | 'conflict';

export interface CommitResult {
  kind: CommitKind;
  batch?: RouteBatch;
  draft?: PendingDraft;
  /** 成果提交时：按片号合并结果 */
  merge?: AssetMergeResult;
  error?: string;
}

export interface RetryResult extends CommitResult {
  /** 冲突成果按片号合并时，被跳过（先提交内容保留）的片号 */
  skippedImageNos?: string[];
}

interface BatchState {
  items: RouteBatch[];
  drafts: PendingDraft[];
  loaded: boolean;
  load: () => Promise<void>;
  byMission: (missionId: string) => RouteBatch[];
  activeBatch: (missionId: string) => RouteBatch | undefined;
  get: (batchId: string) => RouteBatch | undefined;
  /** 参数保存：改动进入新批次，旧批次冻结；基线批次已冻结或 revision 不一致 → 保留冲突稿，不覆盖 */
  commitParams: (args: { missionId: string; baseBatchId: string; baseRevision: number; params: BatchParamsPayload }) => Promise<CommitResult>;
  /** 成果提交：写入拍摄时批次；revision 不一致 → 保留冲突稿 */
  commitAssets: (args: { missionId: string; batchId: string; baseRevision: number; drafts: ImageAssetDraft[] }) => Promise<CommitResult>;
  /** 重试失败 / 冲突稿：冲突成果按片号合并，冲突参数作为最新批次追加，均不覆盖先提交内容 */
  retryDraft: (draftId: string) => Promise<RetryResult>;
  discardDraft: (draftId: string) => Promise<void>;
  /** 相机参数变更（预设带入）：更新任务相机字段并以新相机快照开新批次 */
  applyCameraChange: (missionId: string, camera: CameraSnapshot) => Promise<CommitResult>;
}

/** 任务创建时配套的初始批次（由 missionStore 在同一事务内写库） */
export function buildInitialBatch(mission: Mission, now: number): RouteBatch {
  const camera: CameraSnapshot = {
    cameraModel: mission.cameraModel,
    sensorWidth: mission.sensorWidth,
    sensorHeight: mission.sensorHeight,
    focalLength: mission.focalLength,
    pixelSize: mission.pixelSize,
  };
  return {
    id: newId('batch'),
    missionId: mission.id,
    batchNo: 1,
    label: '批次 1',
    note: '初始批次',
    altitude: 120,
    speed: 8,
    overlapForward: 75,
    overlapSide: 70,
    heading: 90,
    areaPolygon: mission.areaPolygon.map((p) => [...p] as [number, number]),
    camera,
    metrics: computeBatchMetrics(camera, mission.areaPolygon, [], { altitude: 120, speed: 8, overlapForward: 75, overlapSide: 70 }),
    active: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function persistDraft(draft: PendingDraft): Promise<void> {
  // 失败 / 冲突稿独立事务落盘：正式表已回滚或未写入，不存在「只写一半」
  await db.transaction('rw', db.drafts, async () => {
    await db.drafts.put(draft);
  });
}

export const useBatchStore = create<BatchState>((set, get) => ({
  items: [],
  drafts: [],
  loaded: false,
  async load() {
    const rows = await db.batches.toArray();
    rows.sort((a, b) => a.batchNo - b.batchNo);
    const drafts = await db.drafts.orderBy('createdAt').toArray();
    set({ items: rows, drafts, loaded: true });
  },
  byMission(missionId) {
    return get()
      .items.filter((b) => b.missionId === missionId)
      .sort((a, b) => a.batchNo - b.batchNo);
  },
  activeBatch(missionId) {
    return get().items.find((b) => b.missionId === missionId && b.active);
  },
  get(batchId) {
    return get().items.find((b) => b.id === batchId);
  },

  async commitParams({ missionId, baseBatchId, baseRevision, params }) {
    // 乐观锁以数据库最新状态为准：标签页可能没收到跨标签页刷新通知
    const base = await db.batches.get(baseBatchId);
    if (!base || base.missionId !== missionId) {
      return { kind: 'failed', error: '基线批次不存在，无法提交参数' };
    }
    if (!base.active || base.revision !== baseRevision) {
      const current = (await db.batches.where('missionId').equals(missionId).toArray()).find((b) => b.active);
      const draft: PendingDraft = {
        id: newId('draft'),
        kind: 'params',
        status: 'conflict',
        missionId,
        batchId: base.id,
        baseRevision,
        createdAt: Date.now(),
        error: current
          ? `参数基于「${base.label}」修订号 ${baseRevision}，该批次已冻结（当前为 ${current.label}）——可能有其它标签页先提交`
          : `参数基于「${base.label}」修订号 ${baseRevision}，当前任务没有活动批次`,
        params,
      };
      await persistDraft(draft);
      set({ drafts: [...get().drafts, draft] });
      return { kind: 'conflict', draft, error: draft.error };
    }
    const active = base;
    const activePayload: BatchParamsPayload = payloadOf(active.areaPolygon, routeParamsOf(active), active.camera);
    if (isSamePayload(activePayload, params)) {
      return { kind: 'noop' };
    }
    // 故障注入在开事务之前抛出：保证测试 / 真实故障下正式表完全不写入
    if (consumeFault('params')) {
      const draft: PendingDraft = {
        id: newId('draft'),
        kind: 'params',
        status: 'failed',
        missionId,
        batchId: active.id,
        baseRevision,
        createdAt: Date.now(),
        error: '保存失败：模拟的航线参数保存失败（写入前中断）。改动已保留为草稿，可重试',
        params,
      };
      await persistDraft(draft);
      set({ drafts: [...get().drafts, draft] });
      return { kind: 'failed', draft, error: draft.error };
    }
    let created: RouteBatch | null = null;
    try {
      await db.transaction('rw', [db.batches, db.waypoints], async () => {
        const fresh = await db.batches.get(active.id);
        if (!fresh || !fresh.active || fresh.revision !== baseRevision) {
          // 事务内二次乐观锁校验，避免与并发写入交错
          const err = new Error('批次已被其它标签页更新');
          (err as Error & { conflict?: boolean }).conflict = true;
          throw err;
        }
        const wps = await db.waypoints.where('batchId').equals(active.id).sortBy('seq');
        const nextNo = Math.max(0, ...(await db.batches.where('missionId').equals(missionId).toArray()).map((b) => b.batchNo)) + 1;
        const now = Date.now();
        const next: RouteBatch = {
          id: newId('batch'),
          missionId,
          batchNo: nextNo,
          label: `批次 ${nextNo}`,
          note: describeChange(activePayload, params),
          altitude: params.altitude,
          speed: params.speed,
          overlapForward: params.overlapForward,
          overlapSide: params.overlapSide,
          heading: params.heading,
          areaPolygon: params.areaPolygon.map((p) => [...p] as [number, number]),
          camera: { ...params.camera },
          metrics: computeBatchMetrics(params.camera, params.areaPolygon, wps, params),
          active: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        // 原航点随旧批次冻结：不迁移、不修改，新批次从自己的航点集开始
        await db.batches.update(fresh.id, { active: false });
        await db.batches.put(next);
        created = next;
      });
    } catch (e) {
      const conflict = (e as Error & { conflict?: boolean }).conflict === true;
      const current = (await db.batches.where('missionId').equals(missionId).toArray()).find((b) => b.active);
      const draft: PendingDraft = {
        id: newId('draft'),
        kind: 'params',
        status: conflict ? 'conflict' : 'failed',
        missionId,
        batchId: active.id,
        baseRevision,
        createdAt: Date.now(),
        error: conflict
          ? `批次已被其它标签页更新（当前为 ${current?.label ?? '?'} 修订号 ${current?.revision ?? '?'}）`
          : `保存失败：${(e as Error).message}。改动已保留为草稿，可重试`,
        params,
      };
      await persistDraft(draft);
      set({ drafts: [...get().drafts, draft] });
      return { kind: conflict ? 'conflict' : 'failed', draft, error: draft.error };
    }
    await get().load();
    bumpTick(missionId);
    return { kind: 'ok', batch: created ?? undefined };
  },

  async commitAssets({ missionId, batchId, baseRevision, drafts }) {
    // 乐观锁以数据库最新状态为准
    const batch = await db.batches.get(batchId);
    if (!batch || batch.missionId !== missionId) {
      return { kind: 'failed', error: '拍摄批次不存在，无法提交成果' };
    }
    if (baseRevision !== batch.revision) {
      const draft: PendingDraft = {
        id: newId('draft'),
        kind: 'assets',
        status: 'conflict',
        missionId,
        batchId,
        baseRevision,
        createdAt: Date.now(),
        error: `成果基于批次「${batch.label}」修订号 ${baseRevision}，当前已为 ${batch.revision}（可能有其它标签页先提交）`,
        assets: drafts,
      };
      await persistDraft(draft);
      set({ drafts: [...get().drafts, draft] });
      return { kind: 'conflict', draft, error: draft.error };
    }
    let merge: AssetMergeResult = { added: [], skipped: [] };
    // 故障注入在开事务之前：assets/thumbs 不会半写
    if (consumeFault('assets')) {
      const draft: PendingDraft = {
        id: newId('draft'),
        kind: 'assets',
        status: 'failed',
        missionId,
        batchId,
        baseRevision,
        createdAt: Date.now(),
        error: '保存失败：模拟的成果保存失败（写入前中断）。成果已保留为草稿，可重试',
        assets: drafts,
      };
      await persistDraft(draft);
      set({ drafts: [...get().drafts, draft] });
      return { kind: 'failed', draft, error: draft.error };
    }
    try {
      await db.transaction('rw', [db.assets, db.thumbs, db.batches], async () => {
        const fresh = await db.batches.get(batchId);
        if (!fresh || fresh.revision !== baseRevision) {
          const err = new Error('批次已被其它标签页更新');
          (err as Error & { conflict?: boolean }).conflict = true;
          throw err;
        }
        const existing = await db.assets.where('batchId').equals(batchId).toArray();
        merge = mergeAssetsByImageNo(existing, drafts);
        const records = merge.added.map((d) => ({ ...d, id: newId('asset') }));
        const thumbs: AssetThumb[] = records.map((r) => ({
          id: r.id,
          missionId: r.missionId,
          batchId: r.batchId,
          dataUrl: makeThumbDataUrl(r.imageNo, r.quality, r.lng, r.lat),
        }));
        await db.assets.bulkPut(records);
        await db.thumbs.bulkPut(thumbs);
        await db.batches.update(batchId, { revision: fresh.revision + 1, updatedAt: Date.now() });
      });
    } catch (e) {
      const conflict = (e as Error & { conflict?: boolean }).conflict === true;
      const latest = await db.batches.get(batchId);
      const draft: PendingDraft = {
        id: newId('draft'),
        kind: 'assets',
        status: conflict ? 'conflict' : 'failed',
        missionId,
        batchId,
        baseRevision,
        createdAt: Date.now(),
        error: conflict
          ? `批次「${batch.label}」已被其它标签页更新（当前修订号 ${latest?.revision ?? '?'}）`
          : `保存失败：${(e as Error).message}。成果已保留为草稿，可重试`,
        assets: drafts,
      };
      await persistDraft(draft);
      set({ drafts: [...get().drafts, draft] });
      return { kind: conflict ? 'conflict' : 'failed', draft, error: draft.error };
    }
    await get().load();
    await useAssetStore.getState().load();
    await useWaypointStore.getState().load();
    bumpTick(missionId);
    return { kind: 'ok', merge };
  },

  async retryDraft(draftId) {
    const draft = get().drafts.find((d) => d.id === draftId);
    if (!draft) return { kind: 'failed' as const, error: '草稿不存在' };

    if (draft.kind === 'params' && draft.params) {
      const mission = await db.missions.get(draft.missionId);
      const active = get().activeBatch(draft.missionId);
      if (!mission || !active) return { kind: 'failed' as const, error: '任务或当前批次不存在' };
      if (draft.status === 'failed') {
        const res = await get().commitParams({
          missionId: draft.missionId,
          baseBatchId: draft.batchId,
          baseRevision: draft.baseRevision,
          params: draft.params,
        });
        if (res.kind === 'ok') await db.drafts.delete(draftId);
        await get().load();
        return res;
      }
      // 冲突参数稿：不覆盖先提交内容，把改动作为最新批次追加（基于最新任务相机/测区落位）
      try {
        let created: RouteBatch | null = null;
        await db.transaction('rw', [db.batches, db.waypoints, db.drafts], async () => {
          const siblings = await db.batches.where('missionId').equals(draft.missionId).toArray();
          const current = siblings.find((b) => b.active) ?? siblings.sort((a, b) => b.batchNo - a.batchNo)[0];
          const nextNo = Math.max(0, ...siblings.map((b) => b.batchNo)) + 1;
          const now = Date.now();
          const currentPayload: BatchParamsPayload = payloadOf(current.areaPolygon, routeParamsOf(current), current.camera);
          const next: RouteBatch = {
            id: newId('batch'),
            missionId: draft.missionId,
            batchNo: nextNo,
            label: `批次 ${nextNo}`,
            note: `冲突稿追加（原基于修订号 ${draft.baseRevision}）：${describeChange(currentPayload, draft.params!)}`,
            altitude: draft.params!.altitude,
            speed: draft.params!.speed,
            overlapForward: draft.params!.overlapForward,
            overlapSide: draft.params!.overlapSide,
            heading: draft.params!.heading,
            areaPolygon: draft.params!.areaPolygon.map((p) => [...p] as [number, number]),
            camera: { ...draft.params!.camera },
            metrics: computeBatchMetrics(draft.params!.camera, draft.params!.areaPolygon, [], draft.params!),
            active: true,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          for (const b of siblings) {
            if (b.active) await db.batches.update(b.id, { active: false });
          }
          await db.batches.put(next);
          await db.drafts.delete(draftId);
          created = next;
        });
        await get().load();
        bumpTick(draft.missionId);
        return { kind: 'ok', batch: created ?? undefined };
      } catch (e) {
        return { kind: 'failed', error: `冲突稿追加失败：${(e as Error).message}` };
      }
    }

    if (draft.kind === 'assets' && draft.assets) {
      if (draft.status === 'failed') {
        const res = await get().commitAssets({
          missionId: draft.missionId,
          batchId: draft.batchId,
          baseRevision: draft.baseRevision,
          drafts: draft.assets,
        });
        if (res.kind === 'ok') await db.drafts.delete(draftId);
        await get().load();
        return res;
      }
      // 冲突成果稿：按片号合并进拍摄时批次，已有片号保留先提交内容
      try {
        let merge: AssetMergeResult = { added: [], skipped: [] };
        await db.transaction('rw', [db.assets, db.thumbs, db.batches, db.drafts], async () => {
          const fresh = await db.batches.get(draft.batchId);
          if (!fresh) throw new Error('拍摄批次已不存在');
          const existing = await db.assets.where('batchId').equals(draft.batchId).toArray();
          merge = mergeAssetsByImageNo(existing, draft.assets!);
          const records = merge.added.map((d) => ({ ...d, id: newId('asset') }));
          const thumbs: AssetThumb[] = records.map((r) => ({
            id: r.id,
            missionId: r.missionId,
            batchId: r.batchId,
            dataUrl: makeThumbDataUrl(r.imageNo, r.quality, r.lng, r.lat),
          }));
          await db.assets.bulkPut(records);
          await db.thumbs.bulkPut(thumbs);
          await db.batches.update(draft.batchId, { revision: fresh.revision + 1, updatedAt: Date.now() });
          await db.drafts.delete(draftId);
        });
        await get().load();
        await useAssetStore.getState().load();
        bumpTick(draft.missionId);
        return { kind: 'ok', merge, skippedImageNos: merge.skipped };
      } catch (e) {
        return { kind: 'failed', error: `冲突稿合并失败：${(e as Error).message}` };
      }
    }

    return { kind: 'failed', error: '草稿内容缺失' };
  },

  async discardDraft(draftId) {
    await db.drafts.delete(draftId);
    set({ drafts: get().drafts.filter((d) => d.id !== draftId) });
  },

  async applyCameraChange(missionId, camera) {
    const mission = await db.missions.get(missionId);
    // 以数据库最新活动批次为准，避免过期标签页用缓存里的旧批次直接写库
    const active = (await db.batches.where('missionId').equals(missionId).toArray()).find((b) => b.active);
    if (!mission || !active) return { kind: 'failed' as const, error: '任务或当前批次不存在' };
    const nextParams: BatchParamsPayload = {
      altitude: active.altitude,
      speed: active.speed,
      overlapForward: active.overlapForward,
      overlapSide: active.overlapSide,
      heading: active.heading,
      areaPolygon: mission.areaPolygon.map((p) => [...p] as [number, number]),
      camera: { ...camera },
    };
    const prevPayload: BatchParamsPayload = payloadOf(active.areaPolygon, routeParamsOf(active), active.camera);
    if (isSamePayload(prevPayload, nextParams)) return { kind: 'noop' as const };
    // 故障注入在开事务之前：任务相机字段与批次不会半写
    if (consumeFault('params')) {
      const draft: PendingDraft = {
        id: newId('draft'),
        kind: 'params',
        status: 'failed',
        missionId,
        batchId: active.id,
        baseRevision: active.revision,
        createdAt: Date.now(),
        error: '相机参数保存失败：模拟的保存失败（写入前中断）。改动已保留为草稿，可重试',
        params: nextParams,
      };
      await persistDraft(draft);
      set({ drafts: [...get().drafts, draft] });
      return { kind: 'failed', draft, error: draft.error };
    }
    try {
      let created: RouteBatch | null = null;
      await db.transaction('rw', [db.missions, db.batches, db.waypoints], async () => {
        const fresh = await db.batches.get(active.id);
        if (!fresh || !fresh.active) throw new Error('当前批次状态已变化');
        const siblings = await db.batches.where('missionId').equals(missionId).toArray();
        const nextNo = Math.max(0, ...siblings.map((b) => b.batchNo)) + 1;
        const now = Date.now();
        await db.missions.update(missionId, {
          cameraModel: camera.cameraModel,
          sensorWidth: camera.sensorWidth,
          sensorHeight: camera.sensorHeight,
          focalLength: camera.focalLength,
          pixelSize: camera.pixelSize,
        });
        const wps = await db.waypoints.where('batchId').equals(active.id).sortBy('seq');
        const next: RouteBatch = {
          id: newId('batch'),
          missionId,
          batchNo: nextNo,
          label: `批次 ${nextNo}`,
          note: describeChange(prevPayload, nextParams),
          altitude: nextParams.altitude,
          speed: nextParams.speed,
          overlapForward: nextParams.overlapForward,
          overlapSide: nextParams.overlapSide,
          heading: nextParams.heading,
          areaPolygon: nextParams.areaPolygon,
          camera: { ...camera },
          metrics: computeBatchMetrics(camera, nextParams.areaPolygon, wps, nextParams),
          active: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        await db.batches.update(fresh.id, { active: false });
        await db.batches.put(next);
        created = next;
      });
      await get().load();
      bumpTick(missionId);
      return { kind: 'ok', batch: created ?? undefined };
    } catch (e) {
      const draft: PendingDraft = {
        id: newId('draft'),
        kind: 'params',
        status: 'failed',
        missionId,
        batchId: active.id,
        baseRevision: active.revision,
        createdAt: Date.now(),
        error: `相机参数保存失败：${(e as Error).message}。改动已保留为草稿，可重试`,
        params: nextParams,
      };
      await persistDraft(draft);
      set({ drafts: [...get().drafts, draft] });
      return { kind: 'failed', draft, error: draft.error };
    }
  },
}));
