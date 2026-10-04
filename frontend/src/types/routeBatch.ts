import type { LngLat } from './mission';

/** 批次状态：active=当前可编辑批；frozen=已冻结的历史批次（只读快照） */
export type BatchStatus = 'active' | 'frozen';

/**
 * 航线批次。
 *
 * 一次参数调整（测区 / 航高 / 重叠率 / 相机参数）对应一个批次：
 * - 参数改动后预计张数立即失效（{@link RouteBatch.stale}）并按当前参数重算；
 * - 保存时在一个事务里冻结当前批（航点随之冻结为历史快照，不再迁移）并新建 active 批；
 * - 已拍成果（ImageAsset）跟随拍摄时的批次（batchId），不随新批迁移。
 *
 * 冻结批为只读快照：地图 / 航点表 / 成果编目切到该批后展示同一组数据。
 */
export interface RouteBatch {
  id: string;
  missionId: string;
  /** 批次号，同一任务内从 1 递增 */
  batchNo: number;
  /** 批次名称，如「初始批」「批次 2」 */
  label: string;
  status: BatchStatus;
  /** 航线参数快照 */
  altitude: number;
  speed: number;
  overlapForward: number;
  overlapSide: number;
  heading: number;
  /** 相机参数快照 */
  cameraModel: string;
  sensorWidth: number;
  sensorHeight: number;
  focalLength: number;
  pixelSize: number;
  /** 测区边界快照 */
  areaPolygon: LngLat[];
  /** 保存时固化的预计张数（参数改动后 stale=true，需重算保存） */
  estPhotos: number;
  estDuration: number;
  gsd: number;
  spacing: number;
  photoInterval: number;
  batteryCount: number;
  createdAt: number;
  frozenAt: number | null;
  /** 失效标记：参数改动后为 true，重算保存（冻结旧批 + 建新批）后清除 */
  stale: boolean;
}

export type RouteBatchDraft = Omit<RouteBatch, 'id' | 'createdAt' | 'frozenAt' | 'stale'>;

/** 过期标签页提交时保留的冲突稿（按片号合并，只增不覆） */
export interface ConflictDraft {
  missionId: string;
  /** 提交时预期的 active 批 id（用于判定过期） */
  expectedActiveBatchId: string;
  createdAt: number;
  /** 冲突稿中的航线参数 */
  params: {
    altitude: number;
    speed: number;
    overlapForward: number;
    overlapSide: number;
    heading: number;
  };
  /** 冲突稿中的航点（草稿，未写库） */
  waypoints: {
    seq: number;
    lng: number;
    lat: number;
    altitude: number;
    speed: number;
    heading: number;
    gimbalPitch: number;
    action: string;
    hoverSec: number;
  }[];
  /** 冲突稿中的成果条目（草稿，未写库） */
  assets: {
    imageNo: string;
    lng: number;
    lat: number;
    altitude: number;
    gsd: number;
    overlap: number;
    tiltAngle: number;
    shotAt: number;
    quality: string;
    folder: string;
  }[];
}
