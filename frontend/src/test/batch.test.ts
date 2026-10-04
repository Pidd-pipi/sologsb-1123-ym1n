import { describe, expect, it } from 'vitest';
import {
  cameraSnapshotOf,
  computeBatchMetrics,
  DEFAULT_BATCH_PARAMS,
  describeChange,
  isSamePayload,
  mergeAssetsByImageNo,
  payloadOf,
  routeParamsOf,
  splitSorties,
} from '../utils/batch';
import type { RouteBatch } from '../types/batch';
import type { ImageAssetDraft } from '../types/imageasset';
import type { Mission } from '../types/mission';

const mission: Mission = {
  id: 'm1',
  missionNo: 'DM-1',
  name: 'n',
  areaName: 'a',
  areaPolygon: [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ],
  purpose: '正射',
  droneModel: 'x',
  cameraModel: 'c',
  sensorWidth: 17.3,
  sensorHeight: 13,
  focalLength: 12.29,
  pixelSize: 3.3,
  flightDate: '2024-09-12',
  pilot: 'p',
  status: '规划中',
  createdAt: 1,
};

function batch(overrides: Partial<RouteBatch> = {}): RouteBatch {
  const cam = cameraSnapshotOf(mission);
  const params = { ...DEFAULT_BATCH_PARAMS };
  return {
    id: 'b1',
    missionId: 'm1',
    batchNo: 1,
    label: '批次 1',
    note: '',
    ...params,
    areaPolygon: mission.areaPolygon,
    camera: cam,
    metrics: computeBatchMetrics(cam, mission.areaPolygon, [], params),
    active: true,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('批次参数', () => {
  it('参数改动立即影响预计张数（更高重叠率 → 更多张）', () => {
    const cam = cameraSnapshotOf(mission);
    const wps = [
      { lng: 116.3912, lat: 39.9075, altitude: 120, action: '拍照' as const, hoverSec: 0 },
      { lng: 116.3978, lat: 39.9075, altitude: 120, action: '拍照' as const, hoverSec: 0 },
    ];
    const low = computeBatchMetrics(cam, mission.areaPolygon, wps, {
      altitude: 120,
      speed: 8,
      overlapForward: 70,
      overlapSide: 70,
    });
    const high = computeBatchMetrics(cam, mission.areaPolygon, wps, {
      altitude: 120,
      speed: 8,
      overlapForward: 85,
      overlapSide: 85,
    });
    expect(high.estPhotos).toBeGreaterThan(low.estPhotos);
    expect(high.spacing).toBeLessThan(low.spacing);
  });

  it('相同载荷判定为等价', () => {
    const b = batch();
    const p1 = payloadOf(mission.areaPolygon, routeParamsOf(b), b.camera);
    const p2 = payloadOf(mission.areaPolygon, { ...routeParamsOf(b) }, { ...b.camera });
    expect(isSamePayload(p1, p2)).toBe(true);
  });

  it('变更说明能描述航高 / 重叠率 / 相机变化', () => {
    const b = batch();
    const prev = payloadOf(mission.areaPolygon, routeParamsOf(b), b.camera);
    const next = payloadOf(mission.areaPolygon, { ...routeParamsOf(b), altitude: 150, overlapForward: 80 }, b.camera);
    const note = describeChange(prev, next);
    expect(note).toContain('航高 120→150 m');
    expect(note).toContain('航向重叠率 75→80 %');
  });

  it('架次拆分按 20 min 向上取整', () => {
    const sorties = splitSorties(40, 42);
    expect(sorties).toHaveLength(3);
    expect(sorties.reduce((s, x) => s + x.photos, 0)).toBeGreaterThanOrEqual(40);
  });
});

describe('按片号合并', () => {
  const incoming = (nos: string[]): ImageAssetDraft[] =>
    nos.map((imageNo) => ({
      missionId: 'm1',
      batchId: 'b1',
      imageNo,
      lng: 1,
      lat: 1,
      altitude: 120,
      gsd: 3,
      overlap: 75,
      tiltAngle: 0,
      shotAt: 1,
      quality: '合格',
      folder: '/x',
    }));

  it('已有片号保留先提交内容，新片号加入，不覆盖任何字段', () => {
    const merge = mergeAssetsByImageNo([{ imageNo: 'IMG_1' }, { imageNo: 'IMG_2' }], incoming(['IMG_2', 'IMG_3', 'IMG_4']));
    expect(merge.skipped).toEqual(['IMG_2']);
    expect(merge.added.map((a) => a.imageNo)).toEqual(['IMG_3', 'IMG_4']);
  });

  it('同一批提交内部也按片号去重', () => {
    const merge = mergeAssetsByImageNo([], incoming(['IMG_1', 'IMG_1', 'IMG_2']));
    expect(merge.added.map((a) => a.imageNo)).toEqual(['IMG_1', 'IMG_2']);
    expect(merge.skipped).toHaveLength(1);
  });
});
