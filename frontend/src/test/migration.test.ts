import { describe, expect, it, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db } from '../utils/db';
import { useBatchStore } from '../stores/batchStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';

describe('旧数据 v2 → v3 回填', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    // 先清掉主单例可能已创建的 v3 库，再写 v2 旧数据
    db.close();
    await db.delete();
  });

  it('无批次的旧航点 / 成果回填到初始批次，批次指标按旧数据重算，旧 lines 表删除', async () => {
    // 用只声明到 v2 的一次性 Dexie 在当前（fake）indexedDB 后端写旧数据
    const old = new Dexie('gbdronemap');
    old.version(2).stores({
      missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
      waypoints: 'id, missionId, seq, action, altitude',
      lines: 'id, missionId, lineNo, updatedAt',
      assets: 'id, missionId, imageNo, quality, shotAt',
      thumbs: 'id, missionId',
      presets: 'id, name, cameraModel',
    });
    await old.open();
    await (old as unknown as { missions: Dexie.Table }).missions.put({
      id: 'old-m',
      missionNo: 'DM-OLD',
      name: '旧',
      areaName: '旧测区',
      areaPolygon: [
        [116.3912, 39.9075],
        [116.3978, 39.9075],
        [116.3978, 39.9032],
      ],
      purpose: '正射',
      droneModel: 'x',
      cameraModel: 'c',
      sensorWidth: 13.2,
      sensorHeight: 8.8,
      focalLength: 8.8,
      pixelSize: 2.4,
      flightDate: '2023-01-01',
      pilot: 'p',
      status: '待飞行',
      createdAt: 123,
    });
    await (old as unknown as { waypoints: Dexie.Table }).waypoints.bulkPut([
      { id: 'w1', missionId: 'old-m', seq: 1, lng: 116.392, lat: 39.907, altitude: 100, speed: 8, heading: 90, gimbalPitch: -90, action: '拍照', hoverSec: 0 },
      { id: 'w2', missionId: 'old-m', seq: 2, lng: 116.396, lat: 39.904, altitude: 100, speed: 8, heading: 90, gimbalPitch: -90, action: '拍照', hoverSec: 0 },
    ]);
    await (old as unknown as { assets: Dexie.Table }).assets.put({
      id: 'a1',
      missionId: 'old-m',
      imageNo: 'IMG_1',
      lng: 116.392,
      lat: 39.907,
      altitude: 100,
      gsd: 2.7,
      overlap: 75,
      tiltAngle: 0,
      shotAt: 123,
      quality: '合格',
      folder: '/x',
    });
    await (old as unknown as { thumbs: Dexie.Table }).thumbs.put({ id: 'a1', missionId: 'old-m', dataUrl: 'x' });
    old.close();

    // 主 db 单例首次打开该库：执行 v1→v2→v3 升级链，其中 v3 做回填
    db.close();
    await db.open();
    await Promise.all([useBatchStore.getState().load(), useWaypointStore.getState().load(), useAssetStore.getState().load()]);

    const batches = useBatchStore.getState().byMission('old-m');
    expect(batches).toHaveLength(1);
    expect(batches[0].batchNo).toBe(1);
    expect(batches[0].label).toBe('批次 1');
    expect(batches[0].note).toContain('回填');
    expect(batches[0].active).toBe(true);
    const wps = useWaypointStore.getState().byBatch(batches[0].id);
    expect(wps).toHaveLength(2);
    expect(wps.every((w) => w.batchId === batches[0].id)).toBe(true);
    const assets = useAssetStore.getState().byBatch(batches[0].id);
    expect(assets).toHaveLength(1);
    expect(assets[0].batchId).toBe(batches[0].id);
    expect(batches[0].metrics.waypointCount).toBe(2);
    expect(useBatchStore.getState().drafts).toHaveLength(0);
    // 旧 lines 表在 v3 已删除
    expect((db as unknown as { tables: { name: string }[] }).tables.some((t) => t.name === 'lines')).toBe(false);
  });
});
