import type { LngLat, Mission } from '../types/mission';
import type { CameraSnapshot, BatchMetrics, BatchParamsPayload, RouteBatch } from '../types/batch';
import type { ImageAsset, ImageAssetDraft } from '../types/imageasset';
import {
  calcGsd,
  estimateBatteries,
  estimateDuration,
  estimatePhotos,
  lineSpacing,
  pathLengthMeters,
  photoInterval,
  polygonAreaM2,
} from './geoCalc';

/** 初始批次默认航线参数 */
export const DEFAULT_BATCH_PARAMS = {
  altitude: 120,
  speed: 8,
  overlapForward: 75,
  overlapSide: 70,
  heading: 90,
} as const;

/** 从任务相机字段取快照 */
export function cameraSnapshotOf(mission: Pick<Mission, 'cameraModel' | 'sensorWidth' | 'sensorHeight' | 'focalLength' | 'pixelSize'>): CameraSnapshot {
  return {
    cameraModel: mission.cameraModel,
    sensorWidth: mission.sensorWidth,
    sensorHeight: mission.sensorHeight,
    focalLength: mission.focalLength,
    pixelSize: mission.pixelSize,
  };
}

/** 批次保存时冻结一组计算指标（预计张数、GSD、耗时……） */
export function computeBatchMetrics(
  camera: CameraSnapshot,
  polygon: LngLat[],
  waypoints: Array<Pick<import('../types/waypoint').Waypoint, 'lng' | 'lat' | 'altitude' | 'action' | 'hoverSec'>>,
  params: { altitude: number; speed: number; overlapForward: number; overlapSide: number },
): BatchMetrics {
  const gsd = calcGsd(camera.pixelSize, params.altitude, camera.focalLength);
  const spacing = lineSpacing(camera.sensorWidth, params.altitude, camera.focalLength, params.overlapSide);
  const interval = photoInterval(camera.sensorHeight, params.altitude, camera.focalLength, params.overlapForward);
  const area = polygonAreaM2(polygon);
  const points = waypoints.map((w) => [w.lng, w.lat] as LngLat);
  const pathLength = pathLengthMeters(points);
  const side = area > 0 ? Math.sqrt(area) : 0;
  const lineCount = spacing > 0 && side > 0 ? Math.max(1, Math.ceil(side / spacing)) : 0;
  const effLineLength = lineCount > 0 ? (area / (lineCount * Math.max(spacing, 1))) * spacing : 0;
  const estPhotos = estimatePhotos(effLineLength || side, interval, lineCount);
  const hoverSecTotal = waypoints.reduce((s, w) => s + (w.action === '悬停' ? w.hoverSec : 0), 0);
  const estDuration = estimateDuration(pathLength, params.speed, waypoints.length, hoverSecTotal);
  return {
    gsd,
    spacing,
    photoInterval: interval,
    estPhotos,
    estDuration,
    batteryCount: estimateBatteries(estDuration),
    area,
    pathLength,
    waypointCount: waypoints.length,
    lineCount,
  };
}

/** 批次的实时作业参数 */
export function routeParamsOf(batch: Pick<RouteBatch, 'altitude' | 'speed' | 'overlapForward' | 'overlapSide' | 'heading'>) {
  return {
    altitude: batch.altitude,
    speed: batch.speed,
    overlapForward: batch.overlapForward,
    overlapSide: batch.overlapSide,
    heading: batch.heading,
  };
}

/** 由测区（相机快照）与当前编辑参数组装开新批次的载荷 */
export function payloadOf(polygon: LngLat[], params: ReturnType<typeof routeParamsOf>, camera: CameraSnapshot): BatchParamsPayload {
  return {
    altitude: params.altitude,
    speed: params.speed,
    overlapForward: params.overlapForward,
    overlapSide: params.overlapSide,
    heading: params.heading,
    areaPolygon: polygon.map((p) => [...p] as LngLat),
    camera,
  };
}

/** 两份参数载荷是否等价（数字参数 + 相机快照 + 测区顶点） */
export function isSamePayload(a: BatchParamsPayload, b: BatchParamsPayload): boolean {
  const keys: (keyof BatchParamsPayload)[] = ['altitude', 'speed', 'overlapForward', 'overlapSide', 'heading'];
  if (keys.some((k) => Number(a[k]) !== Number(b[k]))) return false;
  const camKeys: (keyof CameraSnapshot)[] = ['cameraModel', 'sensorWidth', 'sensorHeight', 'focalLength', 'pixelSize'];
  if (camKeys.some((k) => String(a.camera[k]) !== String(b.camera[k]))) return false;
  if (a.areaPolygon.length !== b.areaPolygon.length) return false;
  return a.areaPolygon.every((p, i) => p[0] === b.areaPolygon[i][0] && p[1] === b.areaPolygon[i][1]);
}

function arrow(label: string, from: unknown, to: unknown, unit = ''): string {
  return `${label} ${from}→${to}${unit}`;
}

/** 生成「本批次相对上一批次改了什么」的说明 */
export function describeChange(prev: BatchParamsPayload, next: BatchParamsPayload): string {
  const parts: string[] = [];
  if (prev.altitude !== next.altitude) parts.push(arrow('航高', prev.altitude, next.altitude, ' m'));
  if (prev.speed !== next.speed) parts.push(arrow('航速', prev.speed, next.speed, ' m/s'));
  if (prev.overlapForward !== next.overlapForward) parts.push(arrow('航向重叠率', prev.overlapForward, next.overlapForward, ' %'));
  if (prev.overlapSide !== next.overlapSide) parts.push(arrow('旁向重叠率', prev.overlapSide, next.overlapSide, ' %'));
  if (prev.heading !== next.heading) parts.push(arrow('航带方向', prev.heading, next.heading, ' °'));
  if (prev.camera.cameraModel !== next.camera.cameraModel) parts.push(arrow('相机', prev.camera.cameraModel, next.camera.cameraModel));
  if (prev.camera.focalLength !== next.camera.focalLength) parts.push(arrow('焦距', prev.camera.focalLength, next.camera.focalLength, ' mm'));
  if (prev.camera.pixelSize !== next.camera.pixelSize) parts.push(arrow('像元尺寸', prev.camera.pixelSize, next.camera.pixelSize, ' μm'));
  if (
    prev.camera.sensorWidth !== next.camera.sensorWidth ||
    prev.camera.sensorHeight !== next.camera.sensorHeight
  ) {
    parts.push(
      `传感器 ${prev.camera.sensorWidth}×${prev.camera.sensorHeight}→${next.camera.sensorWidth}×${next.camera.sensorHeight} mm`,
    );
  }
  if (
    prev.areaPolygon.length !== next.areaPolygon.length ||
    prev.areaPolygon.some((p, i) => p[0] !== next.areaPolygon[i]?.[0] || p[1] !== next.areaPolygon[i]?.[1])
  ) {
    parts.push(`测区边界 ${prev.areaPolygon.length}→${next.areaPolygon.length} 个顶点`);
  }
  return parts.length > 0 ? parts.join('；') : '参数未变化';
}

export interface AssetMergeResult {
  /** 可新增的条目（片号在目标批次中尚不存在） */
  added: ImageAssetDraft[];
  /** 目标批次已存在、先提交内容保留不覆盖的片号 */
  skipped: string[];
}

/**
 * 按片号合并成果：已有片号一律保留先提交内容（不覆盖），新片号进入批次。
 * 用于正常提交（幂等）与过期标签页冲突稿合并。
 */
export function mergeAssetsByImageNo(existing: Pick<ImageAsset, 'imageNo'>[], incoming: ImageAssetDraft[]): AssetMergeResult {
  const taken = new Set(existing.map((a) => a.imageNo));
  const added: ImageAssetDraft[] = [];
  const skipped: string[] = [];
  incoming.forEach((item) => {
    if (taken.has(item.imageNo)) {
      skipped.push(item.imageNo);
    } else {
      taken.add(item.imageNo);
      added.push(item);
    }
  });
  return { added, skipped };
}

/** 按电池 20 min 有效续航拆分架次 */
export function splitSorties(estPhotos: number, estDuration: number): { sortie: number; photos: number; durationMin: number }[] {
  const count = Math.max(1, Math.ceil(estDuration / 20));
  const photosPer = Math.ceil(estPhotos / count);
  const durationPer = Math.round((estDuration / count) * 10) / 10;
  return Array.from({ length: count }, (_, i) => ({ sortie: i + 1, photos: photosPer, durationMin: durationPer }));
}
