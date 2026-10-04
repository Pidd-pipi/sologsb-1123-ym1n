import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db, ensureSeedData } from '../utils/db';
import { useBatchStore } from '../stores/batchStore';
import { useWaypointStore, FrozenBatchError } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useMissionStore } from '../stores/missionStore';
import { armFault } from '../utils/faults';
import { payloadOf, routeParamsOf } from '../utils/batch';
import type { ImageAssetDraft } from '../types/imageasset';

async function resetAll() {
  window.localStorage.clear();
  // Dexie 单例在首次打开时绑定 indexedDB 后端：用 db.delete() 删当前后端上的库
  db.close();
  await db.delete();
  await db.open();
  await useBatchStore.getState().load();
  await useWaypointStore.getState().load();
  await useAssetStore.getState().load();
  await useMissionStore.getState().load();
}

async function seed() {
  await resetAll();
  await ensureSeedData();
  await Promise.all([
    useBatchStore.getState().load(),
    useWaypointStore.getState().load(),
    useAssetStore.getState().load(),
    useMissionStore.getState().load(),
  ]);
}

function assetDrafts(batchId: string, nos: string[]): ImageAssetDraft[] {
  return nos.map((imageNo, i) => ({
    missionId: 'm-x',
    batchId,
    imageNo,
    lng: 116.39 + i,
    lat: 39.9,
    altitude: 120,
    gsd: 3.2,
    overlap: 75,
    tiltAngle: 0,
    shotAt: Date.now() + i * 1000,
    quality: '合格',
    folder: '/x',
  }));
}

describe('批次工作流（IndexedDB 集成）', () => {
  beforeEach(async () => {
    await seed();
  });

  it('示范数据：任务 A 有两个批次，批次 1 冻结且保留 4 航点 6 成果，批次 2 为当前批次', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-018')!;
    const batches = useBatchStore.getState().byMission(mission.id);
    expect(batches).toHaveLength(2);
    expect(batches[0].active).toBe(false);
    expect(batches[1].active).toBe(true);
    expect(useWaypointStore.getState().byBatch(batches[0].id)).toHaveLength(4);
    expect(useWaypointStore.getState().byBatch(batches[1].id)).toHaveLength(3);
    expect(useAssetStore.getState().byBatch(batches[0].id)).toHaveLength(6);
    expect(useAssetStore.getState().byBatch(batches[1].id)).toHaveLength(0);
  });

  it('保存参数改动 → 开新批次，旧批次冻结且航点不动，预计张数冻结在新批次', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-021')!;
    const activeBefore = useBatchStore.getState().activeBatch(mission.id)!;
    const payload = payloadOf(activeBefore.areaPolygon, { ...routeParamsOf(activeBefore), altitude: 200 }, activeBefore.camera);

    const res = await useBatchStore.getState().commitParams({
      missionId: mission.id,
      baseBatchId: activeBefore.id,
      baseRevision: activeBefore.revision,
      params: payload,
    });
    expect(res.kind).toBe('ok');
    const batches = useBatchStore.getState().byMission(mission.id);
    expect(batches).toHaveLength(2);
    expect(batches[0].active).toBe(false);
    expect(batches[1].active).toBe(true);
    expect(batches[1].note).toContain('航高 150→200 m');
    // 旧批次航点仍挂在旧批次
    expect(useWaypointStore.getState().byBatch(batches[0].id)).toHaveLength(1);
    expect(useWaypointStore.getState().byBatch(batches[1].id)).toHaveLength(0);
    // 预计张数是新批次快照值，且与旧批次不同（航高变化）
    expect(batches[1].metrics.gsd).not.toBe(batches[0].metrics.gsd);
  });

  it('参数无变化 → noop，不产生批次也不产生草稿', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-021')!;
    const active = useBatchStore.getState().activeBatch(mission.id)!;
    const countBefore = useBatchStore.getState().byMission(mission.id).length;
    const res = await useBatchStore
      .getState()
      .commitParams({ missionId: mission.id, baseBatchId: active.id, baseRevision: active.revision, params: payloadOf(active.areaPolygon, routeParamsOf(active), active.camera) });
    expect(res.kind).toBe('noop');
    expect(useBatchStore.getState().byMission(mission.id)).toHaveLength(countBefore);
    expect(useBatchStore.getState().drafts).toHaveLength(0);
  });

  it('保存失败：正式表零写入，失败草稿落盘，重试后成功且草稿清除', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-021')!;
    const active = useBatchStore.getState().activeBatch(mission.id)!;
    const batchCountBefore = useBatchStore.getState().byMission(mission.id).length;
    armFault('params');

    const failed = await useBatchStore.getState().commitParams({
      missionId: mission.id,
      baseBatchId: active.id,
      baseRevision: active.revision,
      params: payloadOf(active.areaPolygon, { ...routeParamsOf(active), overlapForward: 80 }, active.camera),
    });
    expect(failed.kind).toBe('failed');
    expect(failed.draft?.status).toBe('failed');
    // 正式数据没有半套写入
    expect(useBatchStore.getState().byMission(mission.id)).toHaveLength(batchCountBefore);
    expect(await db.batches.where('missionId').equals(mission.id).count()).toBe(batchCountBefore);

    const retried = await useBatchStore.getState().retryDraft(failed.draft!.id);
    expect(retried.kind).toBe('ok');
    expect(useBatchStore.getState().drafts.filter((d) => d.missionId === mission.id)).toHaveLength(0);
    expect(useBatchStore.getState().byMission(mission.id)).toHaveLength(batchCountBefore + 1);
  });

  it('过期标签页提交参数 → 冲突稿保留；重试把改动追加为最新批次，不覆盖先提交内容', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-021')!;
    const active = useBatchStore.getState().activeBatch(mission.id)!;

    // 标签页 A 先提交：航高 180
    const a = await useBatchStore.getState().commitParams({
      missionId: mission.id,
      baseBatchId: active.id,
      baseRevision: active.revision,
      params: payloadOf(active.areaPolygon, { ...routeParamsOf(active), altitude: 180 }, active.camera),
    });
    expect(a.kind).toBe('ok');

    // 标签页 B 基于旧批次的修订号提交：航高 200（载荷基于 B 页所见的旧测区/相机快照）
    const b = await useBatchStore.getState().commitParams({
      missionId: mission.id,
      baseBatchId: active.id,
      baseRevision: active.revision,
      params: payloadOf(active.areaPolygon, { ...routeParamsOf(active), altitude: 200 }, active.camera),
    });
    expect(b.kind).toBe('conflict');
    expect(b.draft?.status).toBe('conflict');

    // 先提交内容完好（当前批次航高 180）
    const afterConflict = useBatchStore.getState().activeBatch(mission.id)!;
    expect(afterConflict.altitude).toBe(180);

    // 重试冲突稿：追加为最新批次，两版数据都保留
    const retried = await useBatchStore.getState().retryDraft(b.draft!.id);
    expect(retried.kind).toBe('ok');
    const batches = useBatchStore.getState().byMission(mission.id);
    expect(batches.map((x) => x.altitude)).toEqual([150, 180, 200]);
    expect(batches[2].active).toBe(true);
    expect(useBatchStore.getState().drafts).toHaveLength(0);
  });

  it('过期标签页提交成果 → 冲突稿保留；重试按片号合并，已有片号不覆盖', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-021')!;
    const active = useBatchStore.getState().activeBatch(mission.id)!;
    const d1 = assetDrafts(active.id, ['IMG_1', 'IMG_2']).map((d) => ({ ...d, missionId: mission.id }));
    const d2 = assetDrafts(active.id, ['IMG_2', 'IMG_3']).map((d) => ({ ...d, missionId: mission.id }));

    const first = await useBatchStore.getState().commitAssets({
      missionId: mission.id,
      batchId: active.id,
      baseRevision: active.revision,
      drafts: d1,
    });
    expect(first.kind).toBe('ok');
    const bumped = useBatchStore.getState().get(active.id)!;
    expect(bumped.revision).toBe(active.revision + 1);

    // 过期 revision 提交重叠片号
    const stale = await useBatchStore.getState().commitAssets({
      missionId: mission.id,
      batchId: active.id,
      baseRevision: active.revision,
      drafts: d2,
    });
    expect(stale.kind).toBe('conflict');
    // 冲突期间正式成果仍是 2 条
    expect(useAssetStore.getState().byBatch(active.id)).toHaveLength(2);

    const merged = await useBatchStore.getState().retryDraft(stale.draft!.id);
    expect(merged.kind).toBe('ok');
    expect(merged.skippedImageNos).toEqual(['IMG_2']);
    const nos = useAssetStore.getState().byBatch(active.id).map((a) => a.imageNo).sort();
    expect(nos).toEqual(['IMG_1', 'IMG_2', 'IMG_3']);
  });

  it('成果保存失败：assets/thumbs 不写一半，失败草稿重试后两表一致', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-021')!;
    const active = useBatchStore.getState().activeBatch(mission.id)!;
    armFault('assets');
    const drafts = assetDrafts(active.id, ['IMG_9']).map((d) => ({ ...d, missionId: mission.id }));

    const failed = await useBatchStore.getState().commitAssets({
      missionId: mission.id,
      batchId: active.id,
      baseRevision: active.revision,
      drafts,
    });
    expect(failed.kind).toBe('failed');
    expect(await db.assets.where('batchId').equals(active.id).count()).toBe(0);
    expect(await db.thumbs.where('batchId').equals(active.id).count()).toBe(0);

    const retried = await useBatchStore.getState().retryDraft(failed.draft!.id);
    expect(retried.kind).toBe('ok');
    expect(await db.assets.where('batchId').equals(active.id).count()).toBe(1);
    expect(await db.thumbs.where('batchId').equals(active.id).count()).toBe(1);
  });

  it('冻结批次航点禁止编辑，编辑当前批次航点后预计张数指标立即重算', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-018')!;
    const batches = useBatchStore.getState().byMission(mission.id);
    const frozen = batches[0];
    const frozenWp = useWaypointStore.getState().byBatch(frozen.id)[0];
    await expect(useWaypointStore.getState().update(frozenWp.id, { altitude: 200 })).rejects.toBeInstanceOf(FrozenBatchError);

    const current = batches[1];
    const before = current.metrics.waypointCount;
    await useWaypointStore.getState().add({
      missionId: mission.id,
      batchId: current.id,
      seq: 99,
      lng: 116.392,
      lat: 39.905,
      altitude: current.altitude,
      speed: current.speed,
      heading: current.heading,
      gimbalPitch: -90,
      action: '拍照',
      hoverSec: 0,
    });
    const refreshed = useBatchStore.getState().get(current.id)!;
    expect(refreshed.metrics.waypointCount).toBe(before + 1);
    // 航点编辑不推进修订号（修订号只在开新批次 / 成果提交时变化）
    expect(refreshed.revision).toBe(current.revision);
  });
});

describe('新任务初始批次', () => {
  it('建任务即带批次 1，删除任务级联清空批次/航点/草稿', async () => {
    await resetAll();
    const created = await useMissionStore.getState().add({
      missionNo: 'DM-NEW',
      name: '新',
      areaName: '区',
      areaPolygon: [
        [120, 30],
        [120.01, 30],
        [120.01, 30.01],
      ],
      purpose: '正射',
      droneModel: 'x',
      cameraModel: 'c',
      sensorWidth: 13.2,
      sensorHeight: 8.8,
      focalLength: 8.8,
      pixelSize: 2.4,
      flightDate: '2026-10-01',
      pilot: 'p',
      status: '规划中',
    });
    expect(useBatchStore.getState().byMission(created.id)).toHaveLength(1);
    await useMissionStore.getState().remove(created.id);
    expect(useBatchStore.getState().byMission(created.id)).toHaveLength(0);
  });
});
