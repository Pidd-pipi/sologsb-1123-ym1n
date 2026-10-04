import { Alert, Button, Space, Typography, message } from 'antd';
import { useRouteBatchStore } from '../../stores/routeBatchStore';

/**
 * 批次相关的全局提示条：
 * - 保存失败：恢复失败草稿并重试（事务回滚，不会只写一半）；
 * - 过期标签页冲突：保留冲突稿，可按片号合并（只增不覆），不覆盖先提交内容。
 */
export default function BatchBanners({ missionId }: { missionId: string }) {
  const conflictDraft = useRouteBatchStore((s) => s.conflictDraft);
  const pendingSave = useRouteBatchStore((s) => s.pendingSave);
  const mergeConflictDraft = useRouteBatchStore((s) => s.mergeConflictDraft);
  const setConflictDraft = useRouteBatchStore((s) => s.setConflictDraft);
  const retrySave = useRouteBatchStore((s) => s.retrySave);
  const setPendingSave = useRouteBatchStore((s) => s.setPendingSave);
  const [messageApi, contextHolder] = message.useMessage();

  const hasConflict = conflictDraft?.missionId === missionId;
  const hasPending = pendingSave?.missionId === missionId;

  if (!hasConflict && !hasPending) return null;

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {contextHolder}
      {hasPending ? (
        <Alert
          type="error"
          showIcon
          message="保存失败，未写入任何内容"
          description={
            <Space wrap size={8}>
              <Typography.Text type="secondary">
                保存过程中发生错误，已在事务内回滚（不会只写一半）。失败草稿已保留，可重试。
              </Typography.Text>
              <Button
                size="small"
                type="primary"
                onClick={async () => {
                  const r = await retrySave();
                  if (r?.ok) messageApi.success('已重新保存航线批次');
                  else if (r && !r.ok && r.reason === 'conflict')
                    messageApi.warning('重试时发现更新的批次，请处理冲突稿');
                  else messageApi.error('重试仍失败，请稍后再试');
                }}
              >
                重试保存
              </Button>
              <Button size="small" onClick={() => setPendingSave(null)}>
                放弃草稿
              </Button>
            </Space>
          }
        />
      ) : null}
      {hasConflict && conflictDraft ? (
        <Alert
          type="warning"
          showIcon
          message="检测到其他标签页已保存更新的批次"
          description={
            <Space wrap size={8}>
              <Typography.Text type="secondary">
                您提交的是过期草稿，未覆盖先提交内容。冲突稿已保留（{conflictDraft.assets.length} 条成果、
                {conflictDraft.waypoints.length} 个航点），可按片号合并成果（只增不覆）。
              </Typography.Text>
              <Button
                size="small"
                type="primary"
                onClick={async () => {
                  try {
                    const r = await mergeConflictDraft(missionId, conflictDraft);
                    messageApi.success(
                      `已合并：新增成果 ${r.addedAssets} 张（跳过同片号 ${r.skippedAssets} 张）、新增航点 ${r.addedWaypoints} 个`,
                    );
                  } catch {
                    messageApi.error('合并失败，请重试');
                  }
                }}
              >
                按片号合并
              </Button>
              <Button size="small" onClick={() => setConflictDraft(null)}>
                放弃冲突稿
              </Button>
            </Space>
          }
        />
      ) : null}
    </Space>
  );
}
