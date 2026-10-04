import { useMemo } from 'react';
import { useWaypointStore } from '../stores/waypointStore';
import { useBatchStore } from '../stores/batchStore';
import {
  calcGsd,
  estimateBatteries,
  estimateDuration,
  estimatePhotos,
  lineSpacing,
  pathLengthMeters,
  photoInterval,
  polygonAreaM2,
} from '../utils/geoCalc';
import { routeParamsOf, splitSorties } from '../utils/batch';
import type { LngLat } from '../types/mission';
import type { RouteBatch } from '../types/batch';

export type RouteParams = ReturnType<typeof routeParamsOf>;

export interface RouteMetrics {
  gsd: number;
  spacing: number;
  photoInterval: number;
  estPhotos: number;
  estDuration: number;
  batteryCount: number;
  /** 测区面积 m² */
  area: number;
  /** 航带路径长度 m */
  pathLength: number;
  /** 航点数量 */
  waypointCount: number;
  /** 预计航带数 */
  lineCount: number;
  coverageForward: number;
  coverageSide: number;
  sorties: { sortie: number; photos: number; durationMin: number }[];
}

/**
 * 以某批次冻结的测区 / 相机快照 + 该批次航点，结合传入的（可能尚未保存的）参数实时回算。
 * 被航线规划页（/missions/:id/route）、航点明细页与相机预设页消费。
 * 切批次后调用方传入不同的 batch，得到的是同一组批次数据。
 */
export function useRouteMetrics(batch: RouteBatch | undefined, paramsOverride?: Partial<RouteParams>): RouteMetrics {
  const allWaypoints = useWaypointStore((s) => s.items);
  const params: RouteParams = batch ? { ...routeParamsOf(batch), ...paramsOverride } : { ...routeParamsOf({ altitude: 120, speed: 8, overlapForward: 75, overlapSide: 70, heading: 90 }), ...paramsOverride };

  return useMemo<RouteMetrics>(() => {
    const polygon: LngLat[] = batch?.areaPolygon ?? [];
    const camera = batch?.camera ?? { cameraModel: '', sensorWidth: 13.2, sensorHeight: 8.8, focalLength: 8.8, pixelSize: 2.4 };
    const points: LngLat[] = allWaypoints
      .filter((w) => w.batchId === batch?.id)
      .sort((a, b) => a.seq - b.seq)
      .map((w) => [w.lng, w.lat] as LngLat);

    const gsd = calcGsd(camera.pixelSize, params.altitude, camera.focalLength);
    const spacing = lineSpacing(camera.sensorWidth, params.altitude, camera.focalLength, params.overlapSide);
    const interval = photoInterval(camera.sensorHeight, params.altitude, camera.focalLength, params.overlapForward);
    const area = polygonAreaM2(polygon);
    const pathLength = pathLengthMeters(points);
    // 按测区面积与航线间距估算航带数
    const side = area > 0 ? Math.sqrt(area) : 0;
    const lineCount = spacing > 0 && side > 0 ? Math.max(1, Math.ceil(side / spacing)) : 0;
    const effLineLength = lineCount > 0 ? (area > 0 ? (area / (lineCount * Math.max(spacing, 1))) * spacing : 0) : 0;
    const estPhotos = estimatePhotos(effLineLength || side, interval, lineCount);
    const hoverSecTotal = allWaypoints
      .filter((w) => w.batchId === batch?.id && w.action === '悬停')
      .reduce((s, w) => s + w.hoverSec, 0);
    const estDuration = estimateDuration(pathLength, params.speed, points.length, hoverSecTotal);
    const batteryCount = estimateBatteries(estDuration);

    return {
      gsd,
      spacing,
      photoInterval: interval,
      estPhotos,
      estDuration,
      batteryCount,
      area,
      pathLength,
      waypointCount: points.length,
      lineCount,
      coverageForward: Math.round(((camera.sensorHeight * params.altitude) / (camera.focalLength || 1)) * 100) / 100,
      coverageSide: Math.round(((camera.sensorWidth * params.altitude) / (camera.focalLength || 1)) * 100) / 100,
      sorties: splitSorties(estPhotos, estDuration),
    };
  }, [batch, allWaypoints, params.altitude, params.speed, params.overlapForward, params.overlapSide, params.heading]);
}
