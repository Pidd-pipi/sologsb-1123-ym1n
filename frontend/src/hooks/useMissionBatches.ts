import { useMemo } from 'react';
import { useRouteBatchStore } from '../stores/routeBatchStore';
import type { RouteBatch } from '../types/routeBatch';

/**
 * 读取某任务的批次列表、活动批与当前选中批，并提供切换。
 * 地图 / 航点表 / 成果编目共用同一选中批，切批次后展示同一组数据。
 */
export function useMissionBatches(missionId: string | undefined) {
  const batches = useRouteBatchStore((s) => s.batches);
  const selectedBatchIdByMission = useRouteBatchStore((s) => s.selectedBatchIdByMission);
  const setSelectedBatch = useRouteBatchStore((s) => s.setSelectedBatch);

  return useMemo(() => {
    if (!missionId) {
      return {
        batches: [] as RouteBatch[],
        activeBatch: undefined,
        selectedBatch: undefined,
        isSelectedActive: false,
        selectBatch: (_batchId: string) => {},
      };
    }
    const list = batches
      .filter((b) => b.missionId === missionId)
      .sort((a, b) => a.batchNo - b.batchNo);
    const activeBatch = list.find((b) => b.status === 'active');
    const selectedId = selectedBatchIdByMission[missionId];
    const selectedBatch = list.find((b) => b.id === selectedId) || activeBatch || list[0];
    return {
      batches: list,
      activeBatch,
      selectedBatch,
      isSelectedActive: selectedBatch?.id === activeBatch?.id,
      selectBatch: (batchId: string) => setSelectedBatch(missionId, batchId),
    };
  }, [batches, selectedBatchIdByMission, missionId, setSelectedBatch]);
}
