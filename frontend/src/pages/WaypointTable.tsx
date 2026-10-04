import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import { ImportOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { FrozenBatchError, useWaypointStore } from '../stores/waypointStore';
import { useBatchStore } from '../stores/batchStore';
import { useRouteMetrics } from '../hooks/useRouteMetrics';
import { useSelectedBatch } from '../hooks/useSelectedBatch';
import AmapRouteView from '../components/common/AmapRouteView';
import { BatchSwitcher, DraftBanner } from '../components/common/BatchControls';
import { WAYPOINT_ACTIONS, parseWaypointText, type Waypoint, type WaypointAction } from '../types/waypoint';
import { groundCoverage } from '../utils/geoCalc';

type Columns = NonNullable<TableProps<Waypoint>['columns']>;

/** /missions/:id/waypoints 航点明细：按批次查看 / 编辑、粘贴导入、批量改高度、顺序拖拽、单点视场预览 */
export default function WaypointTable() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const addMany = useWaypointStore((s) => s.addMany);
  const update = useWaypointStore((s) => s.update);
  const move = useWaypointStore((s) => s.move);
  const reorder = useWaypointStore((s) => s.reorder);
  const remove = useWaypointStore((s) => s.remove);
  const clearBatch = useWaypointStore((s) => s.removeByBatch);
  const missionBatches = useBatchStore((s) => s.items).filter((b) => b.missionId === id).sort((a, b) => a.batchNo - b.batchNo);
  const { batchId, setBatchId } = useSelectedBatch(id);

  const mission = missions.find((m) => m.id === id);
  const active = missionBatches.find((b) => b.active);
  const selected = missionBatches.find((b) => b.id === batchId) ?? active;
  const isActiveView = !!active && !!selected && selected.id === active.id;

  const rows = useMemo(
    () => waypoints.filter((w) => w.batchId === selected?.id).sort((a, b) => a.seq - b.seq),
    [waypoints, selected?.id],
  );

  const [pasteText, setPasteText] = useState('');
  const [batchAltitude, setBatchAltitude] = useState(selected?.altitude ?? 120);
  const [previewId, setPreviewId] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    setBatchAltitude(selected?.altitude ?? 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 冻结指标来自批次快照；当前批次随编辑实时回算
  const liveMetrics = useRouteMetrics(selected);
  const metrics = isActiveView ? liveMetrics : selected?.metrics ?? liveMetrics;
  const preview = rows.find((w) => w.id === previewId) ?? rows[0];

  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
      setError('');
    } catch (e) {
      if (e instanceof FrozenBatchError) setError(e.message);
      else setError((e as Error).message);
    }
  };

  const importPaste = () =>
    guard(async () => {
      if (!selected || !isActiveView) {
        setError('只有当前批次可以导入航点；冻结批次的航点已随批次锁定');
        return;
      }
      const parsed = parseWaypointText(pasteText);
      if (parsed.length === 0) {
        setError('未解析到有效经纬度：每行应为「经度,纬度[,航高]」');
        return;
      }
      const startSeq = rows.length === 0 ? 1 : Math.max(...rows.map((w) => w.seq)) + 1;
      await addMany(
        parsed.map((p, index) => ({
          missionId: id,
          batchId: selected.id,
          seq: startSeq + index,
          lng: Number(p.lng.toFixed(6)),
          lat: Number(p.lat.toFixed(6)),
          altitude: p.altitude ?? batchAltitude,
          speed: selected.speed,
          heading: selected.heading,
          gimbalPitch: -90,
          action: '拍照' as WaypointAction,
          hoverSec: 0,
        })),
      );
      setToast(`已向 ${selected.label} 导入 ${parsed.length} 个航点（序号 ${startSeq} 起），预计张数已重算`);
      setPasteText('');
    });

  const applyBatchAltitude = () =>
    guard(async () => {
      if (!isActiveView) {
        setError('冻结批次不能批量改高度；改高度请保存为新批次');
        return;
      }
      for (const w of rows) {
        await update(w.id, { altitude: batchAltitude });
      }
      setToast(`已把 ${rows.length} 个航点的高度统一改为 ${batchAltitude} m（${selected?.label ?? ''} 指标已重算）`);
    });

  const columns: Columns = [
    { title: '批次', dataIndex: 'batchId', width: 90, render: () => <Tag>{selected?.label}</Tag> },
    { title: '序号', dataIndex: 'seq', width: 70, render: (v: number) => `#${v}` },
    { title: '经度', dataIndex: 'lng', width: 120, render: (v: number) => v.toFixed(6) },
    { title: '纬度', dataIndex: 'lat', width: 120, render: (v: number) => v.toFixed(6) },
    {
      title: '相对航高 m',
      width: 140,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber
          size="small"
          disabled={!isActiveView}
          min={20}
          max={600}
          value={row.altitude}
          onChange={(v) => void guard(async () => update(row.id, { altitude: Number(v ?? 0) }))}
        />
      ),
    },
    {
      title: '航速 m/s',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber
          size="small"
          disabled={!isActiveView}
          min={1}
          max={25}
          step={0.5}
          value={row.speed}
          onChange={(v) => void guard(async () => update(row.id, { speed: Number(v ?? 0) }))}
        />
      ),
    },
    {
      title: '航向 °',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber
          size="small"
          disabled={!isActiveView}
          min={0}
          max={360}
          value={row.heading}
          onChange={(v) => void guard(async () => update(row.id, { heading: Number(v ?? 0) }))}
        />
      ),
    },
    {
      title: '云台俯仰 °',
      width: 130,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber
          size="small"
          disabled={!isActiveView}
          min={-90}
          max={30}
          value={row.gimbalPitch}
          onChange={(v) => void guard(async () => update(row.id, { gimbalPitch: Number(v ?? 0) }))}
        />
      ),
    },
    {
      title: '动作',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <Select
          size="small"
          disabled={!isActiveView}
          style={{ width: 100 }}
          value={row.action}
          onChange={(v) => void guard(async () => update(row.id, { action: v as WaypointAction }))}
          options={WAYPOINT_ACTIONS.map((a) => ({ value: a, label: a }))}
        />
      ),
    },
    {
      title: '悬停 s',
      width: 110,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber
          size="small"
          disabled={!isActiveView}
          min={0}
          max={300}
          value={row.hoverSec}
          onChange={(v) => void guard(async () => update(row.id, { hoverSec: Number(v ?? 0) }))}
        />
      ),
    },
    {
      title: '视场（宽×航向）m',
      width: 170,
      render: (_: unknown, row: Waypoint) =>
        selected
          ? `${groundCoverage(selected.camera.sensorWidth, row.altitude, selected.camera.focalLength)} × ${groundCoverage(
              selected.camera.sensorHeight,
              row.altitude,
              selected.camera.focalLength,
            )}`
          : '—',
    },
    {
      title: '单点 GSD cm/px',
      width: 140,
      render: (_: unknown, row: Waypoint) => {
        if (!selected) return '—';
        const gsd = (selected.camera.pixelSize * row.altitude) / (selected.camera.focalLength * 10);
        return Math.round(gsd * 100) / 100;
      },
    },
    {
      title: '顺序',
      width: 210,
      render: (_: unknown, row: Waypoint, index: number) => (
        <Space size={4}>
          <Button size="small" disabled={!isActiveView || index === 0} onClick={() => void guard(async () => move(row.id, 'up'))}>
            上移
          </Button>
          <Button size="small" disabled={!isActiveView || index === rows.length - 1} onClick={() => void guard(async () => move(row.id, 'down'))}>
            下移
          </Button>
          <span
            draggable={isActiveView}
            title={isActiveView ? '拖拽到目标行可交换顺序' : '冻结批次不可换序'}
            style={{ cursor: isActiveView ? 'grab' : 'not-allowed', color: '#97a0ad' }}
            onDragStart={() => setPreviewId(row.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => void guard(async () => reorder(row.id, previewId))}
          >
            ⣿
          </span>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 150,
      render: (_: unknown, row: Waypoint) => (
        <Space size={4}>
          <Button size="small" onClick={() => setPreviewId(row.id)}>
            预览视场
          </Button>
          <Button size="small" danger disabled={!isActiveView} onClick={() => void guard(async () => remove(row.id))}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          航点明细 · {mission.missionNo}
        </Typography.Title>
        <Tag color="green">{selected?.label} 航点 {rows.length} 个</Tag>
        {selected ? <Tag color={selected.active ? 'green' : 'default'}>{selected.active ? '当前批次' : '已冻结'}</Tag> : null}
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目</Link>
        </Button>
        {selected && isActiveView ? (
          <Button danger size="small" onClick={() => void clearBatch(selected.id)}>
            清空本批次航点
          </Button>
        ) : null}
      </Space>

      <Card size="small">
        {selected ? <BatchSwitcher missionId={mission.id} value={selected.id} onChange={setBatchId} /> : null}
      </Card>

      <DraftBanner missionId={mission.id} onNoticed={(m) => setToast(m)} />
      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={14}>
        <Col span={10}>
          <Card size="small" title={`向${selected?.label ?? ''}粘贴导入（仅当前批次）`}>
            <Input.TextArea
              rows={6}
              disabled={!isActiveView}
              placeholder={'每行一个点，例如：\n116.391200,39.907500\n116.393000,39.906800,150'}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <Space style={{ marginTop: 8 }}>
              <Button type="primary" icon={<ImportOutlined />} onClick={importPaste} disabled={!isActiveView}>
                导入航点
              </Button>
              <Button onClick={() => setPasteText('')} disabled={!isActiveView}>
                清空文本
              </Button>
            </Space>
          </Card>
          <Card size="small" title="批量修改高度（仅当前批次）" style={{ marginTop: 12 }}>
            <Space>
              <InputNumber min={20} max={600} step={5} value={batchAltitude} onChange={(v) => setBatchAltitude(Number(v ?? 0))} />
              <span>m</span>
              <Button icon={<ThunderboltOutlined />} onClick={applyBatchAltitude} disabled={!isActiveView || rows.length === 0}>
                应用到本批次航点
              </Button>
            </Space>
          </Card>
          <Card size="small" title={`单点视场预览（${selected?.label ?? ''}）`} style={{ marginTop: 12 }}>
            {preview && selected ? (
              <>
                <Descriptions size="small" column={1} colon={false}>
                  <Descriptions.Item label="航点">
                    {selected.label} #{preview.seq}（{preview.lng.toFixed(5)}, {preview.lat.toFixed(5)}）
                  </Descriptions.Item>
                  <Descriptions.Item label="航高 / 航速 / 云台">
                    {preview.altitude} m / {preview.speed} m/s / {preview.gimbalPitch}°
                  </Descriptions.Item>
                  <Descriptions.Item label="视场覆盖（批次相机）">
                    旁向 {groundCoverage(selected.camera.sensorWidth, preview.altitude, selected.camera.focalLength)} m × 航向{' '}
                    {groundCoverage(selected.camera.sensorHeight, preview.altitude, selected.camera.focalLength)} m
                  </Descriptions.Item>
                  <Descriptions.Item label="单点 GSD">
                    {Math.round((selected.camera.pixelSize * preview.altitude) / (selected.camera.focalLength * 10) * 100) / 100} cm/px
                  </Descriptions.Item>
                </Descriptions>
                <Row gutter={8} style={{ marginTop: 8 }}>
                  <Col span={8}>
                    <Statistic title="本批次航程" value={metrics.pathLength} precision={1} suffix="m" />
                  </Col>
                  <Col span={8}>
                    <Statistic title="预计张数" value={metrics.estPhotos} suffix="张" />
                  </Col>
                  <Col span={8}>
                    <Statistic title="预计耗时" value={metrics.estDuration} precision={1} suffix="min" />
                  </Col>
                </Row>
              </>
            ) : (
              <Empty description="该批次暂无航点可预览" imageStyle={{ height: 40 }} />
            )}
          </Card>
        </Col>
        <Col span={14}>
          <Card size="small" title={`航点位置（${selected?.label ?? ''}${preview ? '，预览航点高亮' : ''}）`}>
            <AmapRouteView
              mission={mission}
              camera={selected?.camera}
              tint={selected?.active ? '#e07a2f' : '#7a8794'}
              waypoints={rows}
              altitude={preview?.altitude ?? selected?.altitude ?? 120}
              height={360}
              highlightSeq={preview?.seq}
            />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={
          isActiveView
            ? `${selected?.label ?? ''} 航点表格（可改高度/航速/航向/云台/动作，支持上下移与拖拽换序）`
            : `${selected?.label ?? ''} 航点表格（已冻结，只读）`
        }
      >
        <Table<Waypoint>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1700 }}
          locale={{ emptyText: '该批次暂无航点，切到当前批次后可粘贴导入' }}
        />
      </Card>
    </Space>
  );
}
