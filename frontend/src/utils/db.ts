import Dexie, { type Table } from 'dexie';
import type { CameraPreset, Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { ImageAsset, AssetThumb } from '../types/imageasset';
import type { PendingDraft, RouteBatch } from '../types/batch';
import { makeThumbDataUrl } from '../types/imageasset';
import { newId } from './id';
import { cameraSnapshotOf, computeBatchMetrics, DEFAULT_BATCH_PARAMS } from './batch';

export const DB_NAME = 'gbdronemap';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbdronemap:db-version';

class DroneMapDB extends Dexie {
  missions!: Table<Mission, string>;
  waypoints!: Table<Waypoint, string>;
  batches!: Table<RouteBatch, string>;
  assets!: Table<ImageAsset, string>;
  thumbs!: Table<AssetThumb, string>;
  drafts!: Table<PendingDraft, string>;
  presets!: Table<CameraPreset, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      missions: 'id, missionNo, areaName, droneModel, flightDate, status, createdAt',
      waypoints: 'id, missionId, seq, action',
      lines: 'id, missionId, lineNo',
      assets: 'id, missionId, imageNo, quality',
      thumbs: 'id, missionId',
      presets: 'id, name, cameraModel',
    });
    this.version(2)
      .stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
        waypoints: 'id, missionId, seq, action, altitude',
        lines: 'id, missionId, lineNo, updatedAt',
        assets: 'id, missionId, imageNo, quality, shotAt',
        thumbs: 'id, missionId',
        presets: 'id, name, cameraModel',
      })
      .upgrade(async (tx) => {
        await tx
          .table('missions')
          .toCollection()
          .modify((row: any) => {
            if (!row.areaPolygon) row.areaPolygon = [];
            if (row.sensorWidth === undefined) row.sensorWidth = 13.2;
            if (row.sensorHeight === undefined) row.sensorHeight = 8.8;
            if (row.focalLength === undefined) row.focalLength = 8.8;
            if (row.pixelSize === undefined) row.pixelSize = 2.4;
          });
        await tx
          .table('lines')
          .toCollection()
          .modify((row: any) => {
            if (row.updatedAt === undefined) row.updatedAt = Date.now();
            if (row.batteryCount === undefined) row.batteryCount = 1;
          });
      });
    // v3：航线批次。旧数据无批次 → 回填「初始批次（批次 1）」；旧 lines 表删除。
    this.version(3)
      .stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
        waypoints: 'id, missionId, batchId, seq, action, altitude',
        batches: 'id, missionId, batchNo, active, updatedAt',
        assets: 'id, missionId, batchId, imageNo, quality, shotAt',
        thumbs: 'id, missionId, batchId',
        drafts: 'id, kind, status, missionId, batchId, createdAt',
        presets: 'id, name, cameraModel',
        lines: null,
      })
      .upgrade(async (tx) => {
        const missions = await tx.table<Mission, string>('missions').toArray();
        const waypointRows = await tx.table<Waypoint, string>('waypoints').toArray();
        const assetRows = await tx.table<ImageAsset, string>('assets').toArray();

        const batches: RouteBatch[] = [];
        const batchIdByMission = new Map<string, string>();
        const now = Date.now();
        missions.forEach((mission) => {
          const batchId = newId('batch');
          batchIdByMission.set(mission.id, batchId);
          const camera = cameraSnapshotOf(mission);
          const wps = waypointRows.filter((w) => w.missionId === mission.id).sort((a, b) => a.seq - b.seq);
          const params = {
            altitude: wps[0]?.altitude ?? DEFAULT_BATCH_PARAMS.altitude,
            speed: DEFAULT_BATCH_PARAMS.speed,
            overlapForward: DEFAULT_BATCH_PARAMS.overlapForward,
            overlapSide: DEFAULT_BATCH_PARAMS.overlapSide,
          };
          batches.push({
            id: batchId,
            missionId: mission.id,
            batchNo: 1,
            label: '批次 1',
            note: '旧数据回填的初始批次',
            ...params,
            heading: DEFAULT_BATCH_PARAMS.heading,
            areaPolygon: mission.areaPolygon.map((p) => [...p] as [number, number]),
            camera,
            metrics: computeBatchMetrics(camera, mission.areaPolygon, wps, params),
            active: true,
            revision: 1,
            createdAt: mission.createdAt ?? now,
            updatedAt: now,
          });
        });
        await tx.table('batches').bulkPut(batches);

        await tx
          .table('waypoints')
          .toCollection()
          .modify((row: any) => {
            row.batchId = batchIdByMission.get(row.missionId) ?? '';
          });
        await tx
          .table('assets')
          .toCollection()
          .modify((row: any) => {
            row.batchId = batchIdByMission.get(row.missionId) ?? '';
          });
        await tx
          .table('thumbs')
          .toCollection()
          .modify((row: any) => {
            row.batchId = batchIdByMission.get(row.missionId) ?? '';
          });
      });
  }
}

export const db = new DroneMapDB();

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 首次进入灌入示范任务、批次、航点与成果影像条目 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.missions.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;

  const missionA = newId('mission');
  const missionB = newId('mission');
  const batchA1 = newId('batch');
  const batchA2 = newId('batch');
  const batchB1 = newId('batch');

  const polygonA: [number, number][] = [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ];
  const polygonB: [number, number][] = [
    [121.4726, 31.2321],
    [121.4789, 31.2334],
    [121.4796, 31.2288],
  ];

  const missions: Mission[] = [
    {
      id: missionA,
      missionNo: 'DM-2024-018',
      name: '中心城区正射影像采集',
      areaName: '北京东城测区',
      areaPolygon: polygonA,
      purpose: '正射',
      droneModel: 'Mavic 3E',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
      flightDate: '2024-09-12',
      pilot: '穆清和',
      status: '已飞行',
      createdAt: now - 30 * day,
    },
    {
      id: missionB,
      missionNo: 'DM-2024-021',
      name: '滨江带状倾斜摄影',
      areaName: '上海浦东滨江带',
      areaPolygon: polygonB,
      purpose: '带状',
      droneModel: 'M300 RTK',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
      flightDate: '2024-09-20',
      pilot: '纪长风',
      status: '待飞行',
      createdAt: now - 8 * day,
    },
  ];

  const waypoints: Waypoint[] = [];
  // 示范任务 A 初始批次：4 个航点
  const wpsA: [number, number][] = [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ];
  wpsA.forEach(([lng, lat], index) => {
    waypoints.push({
      id: newId('wp'),
      missionId: missionA,
      batchId: batchA1,
      seq: index + 1,
      lng,
      lat,
      altitude: 120,
      speed: 8,
      heading: 90,
      gimbalPitch: -90,
      action: index === wpsA.length - 1 ? '悬停' : '拍照',
      hoverSec: index === wpsA.length - 1 ? 5 : 0,
    });
  });
  // 示范任务 A 当前批次（航高 120→150 m）：3 个新航点，旧批次航点保持冻结
  const wpsA2: [number, number][] = [
    [116.3914, 39.9072],
    [116.3955, 39.9056],
    [116.3972, 39.9038],
  ];
  wpsA2.forEach(([lng, lat], index) => {
    waypoints.push({
      id: newId('wp'),
      missionId: missionA,
      batchId: batchA2,
      seq: index + 1,
      lng,
      lat,
      altitude: 150,
      speed: 8,
      heading: 90,
      gimbalPitch: -90,
      action: '拍照',
      hoverSec: 0,
    });
  });
  waypoints.push({
    id: newId('wp'),
    missionId: missionB,
    batchId: batchB1,
    seq: 1,
    lng: 121.4726,
    lat: 31.2321,
    altitude: 150,
    speed: 10,
    heading: 45,
    gimbalPitch: -60,
    action: '拍照',
    hoverSec: 0,
  });

  const cameraA = cameraSnapshotOf(missions[0]);
  const cameraB = cameraSnapshotOf(missions[1]);

  const batches: RouteBatch[] = [
    {
      id: batchA1,
      missionId: missionA,
      batchNo: 1,
      label: '批次 1',
      note: '初始批次（已飞行，已冻结）',
      altitude: 120,
      speed: 8,
      overlapForward: 75,
      overlapSide: 70,
      heading: 90,
      areaPolygon: polygonA,
      camera: cameraA,
      metrics: computeBatchMetrics(
        cameraA,
        polygonA,
        waypoints.filter((w) => w.batchId === batchA1),
        { altitude: 120, speed: 8, overlapForward: 75, overlapSide: 70 },
      ),
      active: false,
      revision: 2,
      createdAt: now - 30 * day,
      updatedAt: now - 12 * day,
    },
    {
      id: batchA2,
      missionId: missionA,
      batchNo: 2,
      label: '批次 2',
      note: '航高 120→150 m',
      altitude: 150,
      speed: 8,
      overlapForward: 75,
      overlapSide: 70,
      heading: 90,
      areaPolygon: polygonA,
      camera: cameraA,
      metrics: computeBatchMetrics(
        cameraA,
        polygonA,
        waypoints.filter((w) => w.batchId === batchA2),
        { altitude: 150, speed: 8, overlapForward: 75, overlapSide: 70 },
      ),
      active: true,
      revision: 2,
      createdAt: now - 12 * day,
      updatedAt: now - 12 * day,
    },
    {
      id: batchB1,
      missionId: missionB,
      batchNo: 1,
      label: '批次 1',
      note: '初始批次',
      altitude: 150,
      speed: 10,
      overlapForward: 70,
      overlapSide: 65,
      heading: 45,
      areaPolygon: polygonB,
      camera: cameraB,
      metrics: computeBatchMetrics(
        cameraB,
        polygonB,
        waypoints.filter((w) => w.batchId === batchB1),
        { altitude: 150, speed: 10, overlapForward: 70, overlapSide: 65 },
      ),
      active: true,
      revision: 1,
      createdAt: now - 8 * day,
      updatedAt: now - 8 * day,
    },
  ];

  // 6 条示范成果全部在任务 A 的批次 1 拍摄，批次 2 尚无成果
  const assets: ImageAsset[] = [];
  const thumbs: AssetThumb[] = [];
  const qualities: ImageAsset['quality'][] = ['合格', '合格', '模糊', '合格', '过曝', '合格'];
  qualities.forEach((quality, index) => {
    const id = newId('asset');
    const lng = 116.3916 + index * 0.0012;
    const lat = 39.9071 - (index % 2) * 0.0009;
    assets.push({
      id,
      missionId: missionA,
      batchId: batchA1,
      imageNo: `IMG_${String(1001 + index)}`,
      lng,
      lat,
      altitude: 120,
      gsd: 3.22,
      overlap: 76 - index,
      tiltAngle: 2 + index,
      shotAt: now - 30 * day + index * 12000,
      quality,
      folder: `/DM-2024-018/100MEDIA`,
    });
    thumbs.push({ id, missionId: missionA, batchId: batchA1, dataUrl: makeThumbDataUrl(`IMG_${1001 + index}`, quality, lng, lat) });
  });

  const presets: CameraPreset[] = [
    {
      id: newId('preset'),
      name: 'Mavic 3E 广角',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
    },
    {
      id: newId('preset'),
      name: 'Zenmuse P1 35mm',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
    },
    {
      id: newId('preset'),
      name: 'Phantom 4 RTK',
      cameraModel: 'FC6310R',
      sensorWidth: 13.2,
      sensorHeight: 8.8,
      focalLength: 8.8,
      pixelSize: 2.4,
    },
  ];

  // 超过 Dexie 位置参数上限时用数组形式声明事务范围
  await db.transaction(
    'rw',
    [db.missions, db.waypoints, db.batches, db.assets, db.thumbs, db.presets],
    async () => {
      await db.missions.bulkPut(missions);
      await db.waypoints.bulkPut(waypoints);
      await db.batches.bulkPut(batches);
      await db.assets.bulkPut(assets);
      await db.thumbs.bulkPut(thumbs);
      await db.presets.bulkPut(presets);
    },
  );
}
