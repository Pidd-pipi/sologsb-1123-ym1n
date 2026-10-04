import { Select, Space, Tag, Typography } from 'antd';
import { useMissionBatches } from '../../hooks/useMissionBatches';

export interface BatchSwitcherProps {
  missionId: string;
  /** 尺寸 */
  size?: 'small' | 'middle' | 'large';
}

/**
 * 航线批次切换器：地图 / 航点表 / 成果编目共用同一选中批，切批次后展示同一组数据。
 * 活动批可编辑；冻结批为只读快照。
 */
export default function BatchSwitcher({ missionId, size = 'small' }: BatchSwitcherProps) {
  const { batches, selectedBatch, selectBatch } = useMissionBatches(missionId);

  if (batches.length === 0 || !selectedBatch) return null;

  return (
    <Space size={6} align="center">
      <Typography.Text type="secondary">航线批次</Typography.Text>
      <Select
        size={size}
        style={{ minWidth: 180 }}
        value={selectedBatch.id}
        onChange={(v) => selectBatch(v)}
        options={batches.map((b) => ({
          value: b.id,
          label: (
            <Space size={6}>
              <span>
                批次 {b.batchNo} · {b.label}
              </span>
              {b.status === 'active' ? (
                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                  当前
                </Tag>
              ) : (
                <Tag color="default" style={{ marginInlineEnd: 0 }}>
                  已冻结
                </Tag>
              )}
              {b.stale ? (
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                  预计张数已失效
                </Tag>
              ) : null}
            </Space>
          ),
        }))}
      />
    </Space>
  );
}
