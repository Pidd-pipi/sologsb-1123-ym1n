import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Input, Row, Select, Space, Statistic, Tag, Typography } from 'antd';
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore, nextImageDrafts } from '../stores/assetStore';
import { useBatchStore } from '../stores/batchStore';
import { useSelectedBatch } from '../hooks/useSelectedBatch';
import AssetGrid from '../components/common/AssetGrid';
import AmapRouteView from '../components/common/AmapRouteView';
import { BatchSwitcher, DraftBanner } from '../components/common/BatchControls';
import { IMAGE_QUALITIES, type ImageAsset, type ImageQuality } from '../types/imageasset';
import { calcGsd, distanceMeters } from '../utils/geoCalc';

/** /missions/:id/assets 成果影像编目：按拍摄时批次查看 / 提交，多选标记、定位到图、冲突合并 */
export default function AssetCatalog() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  const thumbs = useAssetStore((s) => s.thumbs);
  const markMany = useAssetStore((s) => s.markMany);
  const removeMany = useAssetStore((s) => s.removeMany);
  const missionBatches = useBatchStore((s) => s.items).filter((b) => b.missionId === id).sort((a, b) => a.batchNo - b.batchNo);
  const commitAssets = useBatchStore((s) => s.commitAssets);
  const { batchId, setBatchId } = useSelectedBatch(id);

  const mission = missions.find((m) => m.id === id);
  const active = missionBatches.find((b) => b.active);
  const selected = missionBatches.find((b) => b.id === batchId) ?? active;

  const batchAssets = useMemo(
    () =>
      assets
        .filter((a) => a.batchId === selected?.id)
        .sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true })),
    [assets, selected?.id],
  );
  const batchWaypoints = useMemo(
    () => waypoints.filter((w) => w.batchId === selected?.id).sort((a, b) => a.seq - b.seq),
    [waypoints, selected?.id],
  );

  const [selectedIds, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [qualityFilter, setQualityFilter] = useState<ImageQuality | 'all'>('all');
  const [locateSeq, setLocateSeq] = useState<number | undefined>(undefined);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setSelected([]);
    setLocateSeq(undefined);
  }, [selected?.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = batchAssets.filter((a) => {
    if (qualityFilter !== 'all' && a.quality !== qualityFilter) return false;
    if (keyword && !a.imageNo.toLowerCase().includes(keyword.trim().toLowerCase())) return false;
    return true;
  });

  const stats = IMAGE_QUALITIES.map((quality) => ({
    quality,
    count: batchAssets.filter((a) => a.quality === quality).length,
  }));

  /** 批量编目：按「拍摄时批次」的航点与冻结相机参数生成影像条目并提交（带乐观锁） */
  const catalogFromWaypoints = async () => {
    if (!mission || !selected) return;
    if (batchWaypoints.length === 0) {
      setError(`${selected.label} 暂无航点，请先到「航点明细」录入或点击网格新增`);
      return;
    }
    const gsd = calcGsd(selected.camera.pixelSize, selected.altitude, selected.camera.focalLength);
    const drafts = nextImageDrafts({
      missionNo: mission.missionNo,
      missionId: mission.id,
      batchId: selected.id,
      baseTime: Date.now(),
      waypoints: batchWaypoints,
      pixelSize: selected.camera.pixelSize,
      focalLength: selected.camera.focalLength,
      existingNos: batchAssets.map((a) => a.imageNo),
      gsd,
    });
    const res = await commitAssets({ missionId: mission.id, batchId: selected.id, baseRevision: selected.revision, drafts });
    if (res.kind === 'ok') {
      const added = res.merge?.added.length ?? 0;
      const skipped = res.merge?.skipped ?? [];
      setError('');
      setToast(
        `已把 ${added} 张成果提交到 ${selected.label}（GSD ${gsd} cm/px）` +
          (skipped.length > 0 ? `；片号已存在保留原数据：${skipped.join('、')}` : ''),
      );
    } else if (res.kind === 'conflict') {
      setError('本标签页已过期：冲突稿已保留（见顶部），可按片号合并，不会覆盖先提交内容');
    } else {
      setError(res.error ?? '提交失败：成果已保留为失败草稿（见顶部），可恢复重试');
    }
  };

  const locate = (asset: ImageAsset) => {
    if (batchWaypoints.length === 0) return;
    let best = batchWaypoints[0];
    let bestDist = Number.POSITIVE_INFINITY;
    batchWaypoints.forEach((w) => {
      const d = distanceMeters([asset.lng, asset.lat], [w.lng, w.lat]);
      if (d < bestDist) {
        bestDist = d;
        best = w;
      }
    });
    setLocateSeq(best.seq);
    setToast(`已在 ${selected?.label} 定位到航点 #${best.seq}（距离 ${bestDist.toFixed(1)} m）`);
  };

  const exportList = () => {
    const header = '批次,片号,经度,纬度,航高m,GSDcm/px,重叠%,倾角°,质量,归档目录';
    const lines = batchAssets.map((a) =>
      [selected?.label ?? '', a.imageNo, a.lng, a.lat, a.altitude, a.gsd, a.overlap, a.tiltAngle, a.quality, a.folder].join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `成果影像清单_${mission?.missionNo ?? 'mission'}_${selected?.label ?? 'batch'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(`已导出 ${selected?.label} 的 ${lines.length} 条影像清单`);
  };

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
          成果影像编目 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>{selected?.label} 条目 {batchAssets.length} 张</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
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
      {selected && !selected.active ? (
        <Alert type="info" showIcon message={`正在查看已冻结的 ${selected.label} 成果（拍摄时批次）；新拍成果请切到当前批次后提交。`} />
      ) : null}

      <Row gutter={12}>
        {stats.map((s) => (
          <Col span={6} key={s.quality}>
            <Card size="small">
              <Statistic title={`${s.quality}影像`} value={s.count} suffix="张" />
            </Card>
          </Col>
        ))}
        <Col span={6}>
          <Card size="small">
            <Statistic title="本批次航点" value={batchWaypoints.length} suffix="个" />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Space wrap size={10}>
          <Input
            allowClear
            style={{ width: 200 }}
            placeholder="按片号筛选"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            style={{ width: 140 }}
            value={qualityFilter}
            onChange={(v) => setQualityFilter(v as ImageQuality | 'all')}
            options={[{ value: 'all', label: '全部质量' }, ...IMAGE_QUALITIES.map((q) => ({ value: q, label: q }))]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={catalogFromWaypoints}>
            按本批次航点编目并提交
          </Button>
          <Button
            disabled={selectedIds.length === 0}
            onClick={async () => {
              await markMany(selectedIds, '合格');
              setToast(`已把 ${selectedIds.length} 张标记为「合格」`);
            }}
          >
            标记合格
          </Button>
          <Button
            disabled={selectedIds.length === 0}
            onClick={async () => {
              await markMany(selectedIds, '模糊');
              setToast(`已把 ${selectedIds.length} 张标记为「模糊」`);
            }}
          >
            标记模糊
          </Button>
          <Button
            disabled={selectedIds.length === 0}
            onClick={async () => {
              await markMany(selectedIds, '过曝');
              setToast(`已把 ${selectedIds.length} 张标记为「过曝」`);
            }}
          >
            标记过曝
          </Button>
          <Button
            danger
            disabled={selectedIds.length === 0}
            onClick={async () => {
              await removeMany(selectedIds);
              setToast(`已删除 ${selectedIds.length} 条影像条目`);
              setSelected([]);
            }}
          >
            删除选中
          </Button>
          <Button icon={<DownloadOutlined />} onClick={exportList} disabled={batchAssets.length === 0}>
            导出本批次清单
          </Button>
        </Space>
      </Card>

      <Row gutter={14}>
        <Col span={16}>
          <Card size="small" title={`${selected?.label ?? ''} 影像格子（筛选后 ${filtered.length} 张）`}>
            <AssetGrid
              assets={filtered}
              thumbs={thumbs}
              selectedIds={selectedIds}
              onToggle={(assetId) =>
                setSelected((prev) => (prev.includes(assetId) ? prev.filter((x) => x !== assetId) : [...prev, assetId]))
              }
              onToggleAll={(ids) => setSelected(ids)}
              onLocate={locate}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title={`定位到图（${selected?.label ?? ''}）`}>
            <AmapRouteView
              mission={mission}
              camera={selected?.camera}
              tint={selected?.active ? '#e07a2f' : '#7a8794'}
              waypoints={batchWaypoints}
              altitude={selected?.altitude ?? 120}
              height={340}
              highlightSeq={locateSeq}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
