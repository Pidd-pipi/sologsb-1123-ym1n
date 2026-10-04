import { Alert, Button, Segmented, Space, Tag, Typography } from 'antd';
import { CloudSyncOutlined, ExclamationCircleOutlined, RetweetOutlined } from '@ant-design/icons';
import { useBatchStore } from '../../stores/batchStore';
import { useWaypointStore } from '../../stores/waypointStore';
import { useAssetStore } from '../../stores/assetStore';
import { useMissionStore } from '../../stores/missionStore';
import type { RouteBatch } from '../../types/batch';

export interface BatchSwitcherProps {
  missionId: string;
  /** 当前选中的批次 id */
  value: string | undefined;
  onChange: (batchId: string) => void;
}

/** 批次切换：地图、航点表、成果编目三处使用同一组件，保证看到同一组批次数据 */
export function BatchSwitcher({ missionId, value, onChange }: BatchSwitcherProps) {
  const batches = useBatchStore((s) => s.items).filter((b) => b.missionId === missionId);
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);

  if (batches.length === 0) return null;
  const selected = batches.find((b) => b.id === value) ?? batches.find((b) => b.active) ?? batches[batches.length - 1];

  return (
    <Space wrap size={8} data-testid="batch-switcher">
      <Segmented
        value={selected.id}
        onChange={(v) => onChange(String(v))}
        options={batches.map((b) => ({
          value: b.id,
          label: (
            <Space size={4}>
              {b.label}
              {b.active ? <Tag color="green" style={{ marginInlineEnd: 0 }}>当前</Tag> : <Tag style={{ marginInlineEnd: 0 }}>已冻结</Tag>}
            </Space>
          ),
        }))}
      />
      <Tag color="blue">航点 {waypoints.filter((w) => w.batchId === selected.id).length} 个</Tag>
      <Tag color="orange">预计张数 {selected.metrics.estPhotos}</Tag>
      <Tag>成果 {assets.filter((a) => a.batchId === selected.id).length} 张</Tag>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        修订号 r{selected.revision}
      </Typography.Text>
    </Space>
  );
}

/** 冻结 / 当前批次徽标 */
export function BatchTag({ batch }: { batch: RouteBatch | undefined }) {
  if (!batch) return <Tag>无批次</Tag>;
  return batch.active ? <Tag color="green">{batch.label} · 当前</Tag> : <Tag color="default">{batch.label} · 已冻结</Tag>;
}

export interface DraftBannerProps {
  missionId: string;
  onNoticed?: (message: string, kind: 'success' | 'error' | 'info') => void;
}

/**
 * 保存失败草稿与过期标签页冲突稿的恢复条：
 * - failed：恢复失败草稿并重试；
 * - conflict：冲突稿保留在此，参数稿追加为最新批次，成果稿按片号合并且不覆盖先提交内容。
 */
export function DraftBanner({ missionId, onNoticed }: DraftBannerProps) {
  const drafts = useBatchStore((s) => s.drafts).filter((d) => d.missionId === missionId);
  const retry = useBatchStore((s) => s.retryDraft);
  const discard = useBatchStore((s) => s.discardDraft);

  const reloadAll = async () => {
    await Promise.all([
      useBatchStore.getState().load(),
      useWaypointStore.getState().load(),
      useAssetStore.getState().load(),
      useMissionStore.getState().load(),
    ]);
  };

  if (drafts.length === 0) return null;

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }} data-testid="draft-banner">
      {drafts.map((d) => {
        const isConflict = d.status === 'conflict';
        const label = d.kind === 'params' ? '航线参数' : '成果影像';
        return (
          <Alert
            key={d.id}
            type={isConflict ? 'warning' : 'error'}
            showIcon
            icon={isConflict ? <CloudSyncOutlined /> : <ExclamationCircleOutlined />}
            message={
              <Space wrap size={6}>
                <strong>
                  {isConflict ? '过期标签页冲突稿' : '保存失败草稿'}（{label}）
                </strong>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(d.createdAt).toLocaleString('zh-CN')}
                </Typography.Text>
              </Space>
            }
            description={
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Typography.Text>{d.error}</Typography.Text>
                <Space wrap>
                  <Button
                    size="small"
                    type="primary"
                    icon={<RetweetOutlined />}
                    onClick={async () => {
                      const res = await retry(d.id);
                      await reloadAll();
                      if (res.kind === 'ok') {
                        if (res.skippedImageNos && res.skippedImageNos.length > 0) {
                          onNoticed?.(`已按片号合并，保留先提交内容，跳过片号：${res.skippedImageNos.join('、')}`, 'info');
                        } else if (res.merge) {
                          onNoticed?.(`已提交成功，新增 ${res.merge.added.length} 张成果`, 'success');
                        } else {
                          onNoticed?.('草稿重试成功', 'success');
                        }
                      } else if (res.kind === 'noop') {
                        onNoticed?.('内容与当前批次一致，无需保存（草稿已清理）', 'info');
                      } else {
                        onNoticed?.(res.error ?? '重试仍失败，草稿已保留', 'error');
                      }
                    }}
                  >
                    {isConflict
                      ? d.kind === 'assets'
                        ? '按片号合并进拍摄批次'
                        : '追加为最新批次（不覆盖）'
                      : '恢复并重试'}
                  </Button>
                  <Button size="small" danger onClick={() => discard(d.id)}>
                    放弃草稿
                  </Button>
                </Space>
              </Space>
            }
          />
        );
      })}
    </Space>
  );
}
