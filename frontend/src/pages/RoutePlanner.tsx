import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Space, Table, Tag, Typography, type TableProps } from 'antd';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useBatchStore, type CommitResult } from '../stores/batchStore';
import { useRouteMetrics, type RouteParams } from '../hooks/useRouteMetrics';
import { useSelectedBatch } from '../hooks/useSelectedBatch';
import { isSamePayload, payloadOf, routeParamsOf, splitSorties } from '../utils/batch';
import AmapRouteView from '../components/common/AmapRouteView';
import OverlapCalcPanel from '../components/common/OverlapCalcPanel';
import { BatchSwitcher, DraftBanner } from '../components/common/BatchControls';

type LineRow = { key: string; label: string; value: string };

const lineColumns: NonNullable<TableProps<LineRow>['columns']> = [
  { title: '项', dataIndex: 'label', width: 160 },
  { title: '值', dataIndex: 'value' },
];

/** /missions/:id/route 航线规划主视图：批次切换 + 参数改动实时回算 + 保存开新批次 */
export default function RoutePlanner() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const addWaypoint = useWaypointStore((s) => s.add);
  const missionBatches = useBatchStore((s) => s.items).filter((b) => b.missionId === id).sort((a, b) => a.batchNo - b.batchNo);
  const commitParams = useBatchStore((s) => s.commitParams);
  const { batchId, setBatchId } = useSelectedBatch(id);
  const mission = missions.find((m) => m.id === id);

  const active = missionBatches.find((b) => b.active);
  const selected = missionBatches.find((b) => b.id === batchId) ?? active;

  const [params, setParams] = useState<RouteParams>({
    altitude: 120,
    speed: 8,
    overlapForward: 75,
    overlapSide: 70,
    heading: 90,
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  // 切到当前批次时，把编辑区参数同步为该批次冻结值
  useEffect(() => {
    if (active) setParams(routeParamsOf(active));
    // 仅在选中批次变化或当前批次 id 变化时同步；编辑中的临时改动不被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // 保存成功后自动切到新批次
  useEffect(() => {
    if (active && (!batchId || !missionBatches.some((b) => b.id === batchId))) {
      setBatchId(active.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  const isActiveView = !!active && !!selected && selected.id === active.id;
  const liveMetrics = useRouteMetrics(isActiveView ? active : selected, params);
  // 冻结批次展示保存时冻结的指标；当前批次在有未保存改动时预计张数标记为「待冻结」
  const displayMetrics = isActiveView ? liveMetrics : selected ? selected.metrics : liveMetrics;

  const dirty = useMemo(() => {
    if (!mission || !active) return false;
    const editing = payloadOf(mission.areaPolygon, params, active.camera);
    const frozen = payloadOf(active.areaPolygon, routeParamsOf(active), active.camera);
    return !isSamePayload(frozen, editing);
  }, [mission, active, params]);

  const onSave = async () => {
    if (!mission || !active) return;
    setSaving(true);
    setError('');
    try {
      const res: CommitResult = await commitParams({
        missionId: mission.id,
        baseBatchId: active.id,
        baseRevision: active.revision,
        params: payloadOf(mission.areaPolygon, params, active.camera),
      });
      if (res.kind === 'ok' && res.batch) {
        setBatchId(res.batch.id);
        setToast(`改动已进入 ${res.batch.label}（${res.batch.note}），原批次航点已冻结`);
      } else if (res.kind === 'noop') {
        setToast('参数与当前批次一致，无需新开批次');
      } else if (res.kind === 'conflict') {
        setError('本标签页参数已过期，冲突稿已保留（见顶部），不会覆盖先提交内容');
      } else {
        setError(res.error ?? '保存失败，改动已保留为失败草稿（见顶部），可重试');
      }
    } finally {
      setSaving(false);
    }
  };

  const pickPoint = async (lng: number, lat: number) => {
    if (!mission || !active || !isActiveView) {
      setError('只有当前批次可以新增航点：切到最新的「当前」批次，或先保存参数改动');
      return;
    }
    const batchWaypoints = waypoints.filter((w) => w.batchId === active.id);
    if (batchWaypoints.length >= 60) {
      setError('单批次航点上限为 60 个，请拆分架次');
      return;
    }
    const seq = batchWaypoints.length === 0 ? 1 : Math.max(...batchWaypoints.map((w) => w.seq)) + 1;
    await addWaypoint({
      missionId: mission.id,
      batchId: active.id,
      seq,
      lng: Number(lng.toFixed(6)),
      lat: Number(lat.toFixed(6)),
      altitude: params.altitude,
      speed: params.speed,
      heading: params.heading,
      gimbalPitch: -90,
      action: '拍照',
      hoverSec: 0,
    });
    setError('');
  };

  const viewWaypoints = useMemo(
    () => waypoints.filter((w) => w.batchId === selected?.id).sort((a, b) => a.seq - b.seq),
    [waypoints, selected?.id],
  );

  const lineRows: LineRow[] = [
    { key: 'batch', label: '数据批次', value: selected ? `${selected.label}（${selected.note}）` : '—' },
    { key: 'gsd', label: '地面分辨率 GSD', value: `${displayMetrics.gsd} cm/px` },
    { key: 'spacing', label: '航线间距', value: `${displayMetrics.spacing} m` },
    { key: 'interval', label: '拍照间隔', value: `${displayMetrics.photoInterval} m` },
    {
      key: 'photos',
      label: '预计张数',
      value: `${displayMetrics.estPhotos} 张${isActiveView && dirty ? '（未保存，按当前改动实时重算，保存后冻结到新批次）' : '（批次冻结值）'}`,
    },
    { key: 'duration', label: '预计耗时', value: `${displayMetrics.estDuration} min` },
    { key: 'battery', label: '预计电池组数', value: `${displayMetrics.batteryCount} 组` },
    { key: 'area', label: '测区面积', value: `${displayMetrics.area.toFixed(0)} m²` },
    { key: 'length', label: '航带路径长度', value: `${displayMetrics.pathLength.toFixed(1)} m` },
    { key: 'lines', label: '预计航带数', value: `${displayMetrics.lineCount} 条` },
  ];

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务（可能已被删除）" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          航线规划 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>{mission.areaName}</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目</Link>
        </Button>
        <Button type="link">
          <Link to="/settings/camera">相机预设</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      <Card size="small">
        {selected ? <BatchSwitcher missionId={mission.id} value={selected.id} onChange={setBatchId} /> : null}
      </Card>

      <DraftBanner
        missionId={mission.id}
        onNoticed={(message, kind) => {
          if (kind === 'error') setError(message);
          else setToast(message);
        }}
      />

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {!isActiveView && selected ? (
        <Alert
          type="info"
          showIcon
          message={`正在查看已冻结的 ${selected.label}：航点与预计张数为保存时快照；改参数并保存会创建新批次，不影响本批次。`}
        />
      ) : null}

      <Row gutter={14}>
        <Col span={15}>
          <Card size="small" title={isActiveView && dirty ? '测区与航线 · 参数有未保存改动（预计张数已失效，按新参数重算）' : '测区与航线'}>
            <AmapRouteView
              mission={mission}
              waypoints={viewWaypoints}
              altitude={isActiveView ? params.altitude : selected?.altitude ?? 120}
              height={440}
              onPickPoint={isActiveView ? pickPoint : undefined}
            />
          </Card>
          <Card size="small" title="航线参数明细" style={{ marginTop: 14 }}>
            <Table<LineRow> rowKey="key" size="small" columns={lineColumns} dataSource={lineRows} pagination={false} />
          </Card>
          <Card size="small" title="多架次拆分" style={{ marginTop: 14 }}>
            <Space wrap size={6}>
              {splitSorties(displayMetrics.estPhotos, displayMetrics.estDuration).map((s) => (
                <Tag key={s.sortie} color="blue">
                  第 {s.sortie} 架次 · {s.photos} 张 · {s.durationMin} min
                </Tag>
              ))}
            </Space>
          </Card>
        </Col>
        <Col span={9}>
          <OverlapCalcPanel
            params={isActiveView ? params : selected ? routeParamsOf(selected) : params}
            readOnly={!isActiveView}
            dirty={isActiveView && dirty}
            saving={saving}
            onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
            metrics={liveMetrics}
            frozenMetrics={isActiveView ? undefined : selected?.metrics}
            onSave={onSave}
          />
        </Col>
      </Row>

      <Card size="small" title={`本批次航点（${viewWaypoints.length} 个）`}>
        {viewWaypoints.length === 0 ? (
          <Typography.Text type="secondary">
            {isActiveView
              ? '当前批次暂无航点：在地图/网格上单击即可按当前航高新增航点，或到「航点明细」页批量粘贴导入。'
              : '该冻结批次没有航点（新批次从空航点集开始，旧航点保留在旧批次）。'}
          </Typography.Text>
        ) : (
          <Space wrap size={6}>
            {viewWaypoints.map((w) => (
              <Tag key={w.id} color={w.action === '悬停' ? 'gold' : 'blue'}>
                #{w.seq} {w.lng.toFixed(5)}, {w.lat.toFixed(5)} · {w.altitude} m · {w.action}
              </Tag>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}
