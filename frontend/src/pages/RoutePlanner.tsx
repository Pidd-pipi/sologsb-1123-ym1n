import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Space, Table, Tag, Typography, type TableProps } from 'antd';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useRouteBatchStore } from '../stores/routeBatchStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS, type RouteParams } from '../hooks/useRouteMetrics';
import { useMissionBatches } from '../hooks/useMissionBatches';
import AmapRouteView from '../components/common/AmapRouteView';
import OverlapCalcPanel from '../components/common/OverlapCalcPanel';
import BatchSwitcher from '../components/common/BatchSwitcher';
import BatchBanners from '../components/common/BatchBanners';
import { splitSorties } from '../utils/db';
import { clearLiveParams, readLiveParams, writeLiveParams } from '../utils/liveParams';
import type { Waypoint } from '../types/waypoint';

type LineRow = { key: string; label: string; value: string };

const lineColumns: NonNullable<TableProps<LineRow>['columns']> = [
  { title: '项', dataIndex: 'label', width: 160 },
  { title: '值', dataIndex: 'value' },
];

/** /missions/:id/route 航线规划主视图：地图 + 参数面板实时回算，参数改动进新批次，航点冻结在旧批次，已拍成果跟随拍摄时批次 */
export default function RoutePlanner() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  const addWaypoint = useWaypointStore((s) => s.add);
  const markStale = useRouteBatchStore((s) => s.markStale);
  const saveBatch = useRouteBatchStore((s) => s.saveBatch);
  const mission = missions.find((m) => m.id === id);

  const { batches, activeBatch, selectedBatch, isSelectedActive } = useMissionBatches(id);

  const [params, setParams] = useState<RouteParams>({ ...DEFAULT_ROUTE_PARAMS });
  const [savedText, setSavedText] = useState('');
  const [error, setError] = useState('');
  const metrics = useRouteMetrics(id, selectedBatch?.id, params);

  // 切换批次时同步参数（活动批优先载入未保存的实时草稿）
  useEffect(() => {
    if (!id || !selectedBatch) return;
    const live = isSelectedActive ? readLiveParams(id) : null;
    if (live) {
      setParams(live);
    } else {
      setParams({
        altitude: selectedBatch.altitude,
        speed: selectedBatch.speed,
        overlapForward: selectedBatch.overlapForward,
        overlapSide: selectedBatch.overlapSide,
        heading: selectedBatch.heading,
      });
    }
  }, [id, selectedBatch?.id, isSelectedActive]);

  const selectedWaypoints = useMemo(
    () =>
      selectedBatch
        ? waypoints
            .filter((w) => w.missionId === id && w.batchId === selectedBatch.id)
            .sort((a, b) => a.seq - b.seq)
        : [],
    [waypoints, id, selectedBatch?.id],
  );

  const onParamsChange = (patch: Partial<RouteParams>) => {
    setParams((prev) => {
      const next = { ...prev, ...patch };
      if (isSelectedActive) {
        writeLiveParams(id, next);
        void markStale(id);
      }
      return next;
    });
  };

  const onSave = async () => {
    if (!mission || !activeBatch) return;
    const result = await saveBatch(
      mission.id,
      {
        altitude: params.altitude,
        speed: params.speed,
        overlapForward: params.overlapForward,
        overlapSide: params.overlapSide,
        heading: params.heading,
        areaPolygon: mission.areaPolygon,
      },
      {
        estPhotos: metrics.estPhotos,
        estDuration: metrics.estDuration,
        gsd: metrics.gsd,
        spacing: metrics.spacing,
        photoInterval: metrics.photoInterval,
        batteryCount: metrics.batteryCount,
      },
      activeBatch.id,
    );
    if (result.ok) {
      clearLiveParams(mission.id);
      setSavedText(
        result.created
          ? `已保存为新批次（旧批次已冻结）${new Date().toLocaleString('zh-CN')}`
          : `已保存 ${new Date().toLocaleString('zh-CN')}`,
      );
    } else if (result.reason === 'conflict') {
      // 保留冲突稿：把当前参数 + 航点 + 成果（片号）存入冲突稿，供按片号合并
      useRouteBatchStore.getState().setConflictDraft({
        missionId: mission.id,
        expectedActiveBatchId: activeBatch.id,
        createdAt: Date.now(),
        params: {
          altitude: params.altitude,
          speed: params.speed,
          overlapForward: params.overlapForward,
          overlapSide: params.overlapSide,
          heading: params.heading,
        },
        waypoints: selectedWaypoints.map((w) => ({
          seq: w.seq,
          lng: w.lng,
          lat: w.lat,
          altitude: w.altitude,
          speed: w.speed,
          heading: w.heading,
          gimbalPitch: w.gimbalPitch,
          action: w.action,
          hoverSec: w.hoverSec,
        })),
        assets: assets
          .filter((a) => a.missionId === mission.id && a.batchId === selectedBatch?.id)
          .map((a) => ({
            imageNo: a.imageNo,
            lng: a.lng,
            lat: a.lat,
            altitude: a.altitude,
            gsd: a.gsd,
            overlap: a.overlap,
            tiltAngle: a.tiltAngle,
            shotAt: a.shotAt,
            quality: a.quality,
            folder: a.folder,
          })),
      });
      setError('该任务已在其他标签页保存更新的批次，您的修改已保留为冲突稿');
    }
  };

  const pickPoint = async (lng: number, lat: number) => {
    if (!mission || !activeBatch || !isSelectedActive) return;
    if (selectedWaypoints.length >= 60) {
      setError('单任务航点上限为 60 个，请拆分架次');
      return;
    }
    const seq = selectedWaypoints.length === 0 ? 1 : Math.max(...selectedWaypoints.map((w) => w.seq)) + 1;
    await addWaypoint({
      missionId: mission.id,
      batchId: activeBatch.id,
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

  const lineRows: LineRow[] = [
    { key: 'gsd', label: '地面分辨率 GSD', value: `${metrics.gsd} cm/px` },
    { key: 'spacing', label: '航线间距', value: `${metrics.spacing} m` },
    { key: 'interval', label: '拍照间隔', value: `${metrics.photoInterval} m` },
    { key: 'photos', label: '预计张数', value: `${metrics.estPhotos} 张` },
    { key: 'duration', label: '预计耗时', value: `${metrics.estDuration} min` },
    { key: 'battery', label: '预计电池组数', value: `${metrics.batteryCount} 组` },
    { key: 'area', label: '测区面积', value: `${metrics.area.toFixed(0)} m²` },
    { key: 'length', label: '航带路径长度', value: `${metrics.pathLength.toFixed(1)} m` },
    { key: 'lines', label: '预计航带数', value: `${metrics.lineCount} 条` },
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
        <Tag color={selectedWaypoints.length > 0 ? 'green' : 'default'}>航点 {selectedWaypoints.length} 个</Tag>
        <BatchSwitcher missionId={mission.id} />
        {selectedBatch?.stale ? <Tag color="orange">预计张数已失效，保存后重算</Tag> : null}
        {!isSelectedActive ? <Tag color="default">只读快照（已冻结）</Tag> : null}
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

      <BatchBanners missionId={mission.id} />
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={14}>
        <Col span={15}>
          <Card size="small" title="测区与航线">
            <AmapRouteView
              mission={mission}
              waypoints={selectedWaypoints}
              altitude={params.altitude}
              height={440}
              onPickPoint={isSelectedActive ? pickPoint : undefined}
            />
          </Card>
          <Card size="small" title="航线参数明细" style={{ marginTop: 14 }}>
            <Table<LineRow>
              rowKey="key"
              size="small"
              columns={lineColumns}
              dataSource={lineRows}
              pagination={false}
            />
          </Card>
          <Card size="small" title="多架次拆分" style={{ marginTop: 14 }}>
            <Space wrap size={6}>
              {splitSorties({ estPhotos: metrics.estPhotos, estDuration: metrics.estDuration }).map((s) => (
                <Tag key={s.sortie} color="blue">
                  第 {s.sortie} 架次 · {s.photos} 张 · {s.durationMin} min
                </Tag>
              ))}
            </Space>
          </Card>
        </Col>
        <Col span={9}>
          <OverlapCalcPanel
            params={params}
            onChange={onParamsChange}
            metrics={metrics}
            onSave={onSave}
            savedText={savedText}
            disabled={!isSelectedActive}
          />
        </Col>
      </Row>

      <Card size="small" title="当前批次航点">
        {selectedWaypoints.length === 0 ? (
          <Typography.Text type="secondary">
            暂无航点：在地图/网格上单击即可按当前航高新增航点，或到「航点明细」页批量粘贴导入。
          </Typography.Text>
        ) : (
          <Space wrap size={6}>
            {selectedWaypoints.map((w: Waypoint) => (
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
