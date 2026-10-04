import Dexie, { type Table } from 'dexie';
import type { CameraPreset, Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { FlightLine } from '../types/flightline';
import type { RouteBatch } from '../types/routeBatch';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset } from '../types/imageasset';
import { newId } from './id';

export const DB_NAME = 'gbdronemap';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbdronemap:db-version';

class DroneMapDB extends Dexie {
  missions!: Table<Mission, string>;
  waypoints!: Table<Waypoint, string>;
  lines!: Table<FlightLine, string>;
  batches!: Table<RouteBatch, string>;
  assets!: Table<ImageAsset, string>;
  thumbs!: Table<AssetThumb, string>;
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
    this.version(3)
      .stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
        waypoints: 'id, missionId, batchId, seq, action, altitude',
        lines: 'id, missionId, lineNo, updatedAt',
        batches: 'id, missionId, batchNo, status, createdAt',
        assets: 'id, missionId, batchId, imageNo, quality, shotAt',
        thumbs: 'id, missionId',
        presets: 'id, name, cameraModel',
      })
      .upgrade(async (tx) => {
        // 回填：为没有批次的任务创建「初始批」，并把既有航点 / 成果归入该批
        const missions = await tx.table('missions').toArray();
        for (const mission of missions) {
          const exists = await tx.table('batches').where('missionId').equals(mission.id).count();
          if (exists > 0) continue;
          const line = await tx.table('lines').where('missionId').equals(mission.id).first();
          const wps = await tx.table('waypoints').where('missionId').equals(mission.id).toArray();
          const batch = buildInitialBatch(mission, line, wps);
          await tx.table('batches').add(batch);
          await tx.table('waypoints').where('missionId').equals(mission.id).modify({ batchId: batch.id });
          await tx.table('assets').where('missionId').equals(mission.id).modify({ batchId: batch.id });
        }
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

/** 由任务 + 既有航线参数 + 航点构造「初始批」（旧数据回填 / 新任务首次建批共用） */
export function buildInitialBatch(
  mission: Mission,
  line?: FlightLine,
  waypoints: Waypoint[] = [],
): RouteBatch {
  const now = Date.now();
  const first = waypoints[0];
  return {
    id: newId('batch'),
    missionId: mission.id,
    batchNo: 1,
    label: '初始批',
    status: 'active',
    altitude: first?.altitude ?? 120,
    speed: first?.speed ?? 8,
    overlapForward: line?.overlapForward ?? 75,
    overlapSide: line?.overlapSide ?? 70,
    heading: line?.heading ?? 90,
    cameraModel: mission.cameraModel,
    sensorWidth: mission.sensorWidth,
    sensorHeight: mission.sensorHeight,
    focalLength: mission.focalLength,
    pixelSize: mission.pixelSize,
    areaPolygon: mission.areaPolygon,
    estPhotos: line?.estPhotos ?? 0,
    estDuration: line?.estDuration ?? 0,
    gsd: line?.gsd ?? 0,
    spacing: line?.spacing ?? 0,
    photoInterval: line?.photoInterval ?? 0,
    batteryCount: line?.batteryCount ?? 1,
    createdAt: now,
    frozenAt: null,
    stale: false,
  };
}

/**
 * 回填批次（幂等）：为没有批次的任务创建「初始批」，并把缺 batchId 的航点 / 成果归入该批。
 * v3 升级时已在事务内执行过；此处用于首次灌入示范数据后的补齐。
 */
export async function backfillBatches(): Promise<void> {
  const missions = await db.missions.toArray();
  for (const mission of missions) {
    const exists = await db.batches.where('missionId').equals(mission.id).count();
    if (exists > 0) continue;
    const line = await db.lines.where('missionId').equals(mission.id).first();
    const wps = await db.waypoints.where('missionId').equals(mission.id).toArray();
    const batch = buildInitialBatch(mission, line, wps);
    await db.batches.add(batch);
    await db.waypoints.where('missionId').equals(mission.id).modify({ batchId: batch.id });
    await db.assets.where('missionId').equals(mission.id).modify({ batchId: batch.id });
  }
}

/** 按航线参数把任务拆分为多架次（每架次按电池组数分组） */
export function splitSorties(metrics: { estPhotos: number; estDuration: number }): {
  sortie: number;
  photos: number;
  durationMin: number;
}[] {
  const perSortie = 20; // 每组电池有效续航 20 min
  const count = Math.max(1, Math.ceil(metrics.estDuration / perSortie));
  const photosPer = Math.ceil(metrics.estPhotos / count);
  const durationPer = Math.round((metrics.estDuration / count) * 10) / 10;
  return Array.from({ length: count }, (_, i) => ({
    sortie: i + 1,
    photos: photosPer,
    durationMin: durationPer,
  }));
}

/** 首次进入灌入示范任务、航点与成果影像条目（批次由 backfillBatches 补齐） */
export async function ensureSeedData(): Promise<void> {
  const count = await db.missions.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;

  const missionA = newId('mission');
  const missionB = newId('mission');

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
  // 示范任务 A：4 个航点形成一条覆盖测区的折线
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
      batchId: '', // 由 backfillBatches 回填
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
  waypoints.push({
    id: newId('wp'),
    missionId: missionB,
    batchId: '',
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
      batchId: '', // 由 backfillBatches 回填
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
    thumbs.push({ id, missionId: missionA, dataUrl: makeThumbDataUrl(`IMG_${1001 + index}`, quality, lng, lat) });
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

  // 五张表超过 Dexie 位置参数上限，改用数组形式声明事务范围
  await db.transaction('rw', [db.missions, db.waypoints, db.assets, db.thumbs, db.presets], async () => {
    await db.missions.bulkPut(missions);
    await db.waypoints.bulkPut(waypoints);
    await db.assets.bulkPut(assets);
    await db.thumbs.bulkPut(thumbs);
    await db.presets.bulkPut(presets);
  });

  // 补齐初始批（为示范任务创建「初始批」并回填 batchId）
  await backfillBatches();
}
