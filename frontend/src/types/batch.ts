import type { LngLat } from './mission';

/**
 * 航线批次。
 * 测区、航高、重叠率或相机参数一旦改动并保存，就产生一个新批次；
 * 旧批次保持冻结（航点与预计张数不再变化），已拍成果按拍摄时批次归档。
 */
export interface RouteBatch {
  id: string;
  missionId: string;
  /** 批次序号，从 1（初始批次）开始 */
  batchNo: number;
  /** 展示名，如「批次 3」 */
  label: string;
  /** 本批次相对上一批次的变更说明，如「航高 120→150 m；航向重叠率 75→80 %」 */
  note: string;
  /** 相对航高 m */
  altitude: number;
  /** 航速 m/s */
  speed: number;
  /** 航向重叠率 % */
  overlapForward: number;
  /** 旁向重叠率 % */
  overlapSide: number;
  /** 航带方向 ° */
  heading: number;
  /** 批次保存时刻的测区边界快照 */
  areaPolygon: LngLat[];
  /** 批次保存时刻的相机 / 传感器参数快照 */
  camera: CameraSnapshot;
  /** 保存时冻结的计算指标（预计张数、GSD、耗时……） */
  metrics: BatchMetrics;
  /** 是否为当前作业批次；每个任务同时只有一个 active 批次，其余为冻结旧批次 */
  active: boolean;
  /** 乐观锁版本：参数开新批次或成果提交后 +1，用于识别过期标签页 */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** 批次冻结的相机 / 传感器参数 */
export interface CameraSnapshot {
  cameraModel: string;
  sensorWidth: number;
  sensorHeight: number;
  focalLength: number;
  pixelSize: number;
}

/** 批次保存时冻结的一组计算指标 */
export interface BatchMetrics {
  /** 地面分辨率 cm/px */
  gsd: number;
  /** 航线间距 m */
  spacing: number;
  /** 拍照间隔 m */
  photoInterval: number;
  /** 预计张数 */
  estPhotos: number;
  /** 预计耗时 min */
  estDuration: number;
  /** 预计电池组数 */
  batteryCount: number;
  /** 测区面积 m² */
  area: number;
  /** 航带路径长度 m */
  pathLength: number;
  /** 冻结航点数量 */
  waypointCount: number;
  /** 预计航带数 */
  lineCount: number;
}

/** 开新批次时提交的参数载荷（编辑中的新改动） */
export interface BatchParamsPayload {
  altitude: number;
  speed: number;
  overlapForward: number;
  overlapSide: number;
  heading: number;
  areaPolygon: LngLat[];
  camera: CameraSnapshot;
}

export type PendingDraftKind = 'params' | 'assets';
/** failed=保存失败后待重试的草稿；conflict=过期标签页提交后保留的冲突稿 */
export type PendingDraftStatus = 'failed' | 'conflict';

/**
 * 未进入正式数据的挂起稿：
 * - 参数 / 成果保存失败时落盘为 failed，重试成功前不写入任何正式表（不会只写一半）；
 * - 过期标签页提交（revision 对不上）时落盘为 conflict，不覆盖先提交内容，可重试或按片号合并。
 */
export interface PendingDraft {
  id: string;
  kind: PendingDraftKind;
  status: PendingDraftStatus;
  missionId: string;
  /** 参数稿：所基于的父批次；成果稿：拍摄时批次 */
  batchId: string;
  /** 提交时所基于的批次 revision（乐观锁） */
  baseRevision: number;
  createdAt: number;
  /** 失败 / 冲突原因 */
  error: string;
  /** kind=params 时的参数改动 */
  params?: BatchParamsPayload;
  /** kind=assets 时待入库的影像条目（含片号） */
  assets?: import('./imageasset').ImageAssetDraft[];
}
