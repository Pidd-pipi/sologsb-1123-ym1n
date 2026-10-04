import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Button, Layout, Menu, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { RocketOutlined, CloudSyncOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useBatchStore } from '../stores/batchStore';
import { ensureSeedData, markDbVersion, readDbVersion } from '../utils/db';
import { onTick } from '../utils/tick';
import { hasAmapKey } from '../utils/amapLoader';
import MissionList from '../pages/MissionList';
import RoutePlanner from '../pages/RoutePlanner';
import WaypointTable from '../pages/WaypointTable';
import AssetCatalog from '../pages/AssetCatalog';
import CameraPreset from '../pages/CameraPreset';

const { Header, Content } = Layout;

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const missions = useMissionStore((s) => s.items);
  const drafts = useBatchStore((s) => s.drafts);
  const version = readDbVersion();
  const firstMissionId = missions[0]?.id;

  const items = useMemo(
    () => [
      { key: '/missions', label: '任务台账' },
      { key: firstMissionId ? `/missions/${firstMissionId}/route` : '/missions', label: '航线规划' },
      { key: firstMissionId ? `/missions/${firstMissionId}/waypoints` : '/missions', label: '航点明细' },
      { key: firstMissionId ? `/missions/${firstMissionId}/assets` : '/missions', label: '成果编目' },
      { key: '/settings/camera', label: '相机预设' },
    ],
    [firstMissionId],
  );

  const selected = useMemo(() => {
    const path = location.pathname;
    if (path.startsWith('/settings')) return '/settings/camera';
    if (path.endsWith('/route')) return items[1].key;
    if (path.endsWith('/waypoints')) return items[2].key;
    if (path.endsWith('/assets')) return items[3].key;
    return '/missions';
  }, [location.pathname, items]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 16, background: '#1d3557', paddingInline: 20 }}>
        <Space align="center">
          <RocketOutlined style={{ color: '#8ecae6', fontSize: 20 }} />
          <Typography.Title level={5} style={{ color: '#f4f8fb', margin: 0, whiteSpace: 'nowrap' }}>
            无人机航拍航线与成果编目台
          </Typography.Title>
        </Space>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          onClick={({ key }) => navigate(key)}
          items={items}
          style={{ flex: 1, minWidth: 0, background: 'transparent' }}
        />
        <Space size={8}>
          {drafts.length > 0 ? (
            <Tooltip title={`有 ${drafts.length} 份保存失败 / 过期冲突草稿待处理，点击前往`}>
              <Badge count={drafts.length} size="small">
                <Button
                  size="small"
                  danger
                  icon={<CloudSyncOutlined />}
                  onClick={() => navigate(`/missions/${drafts[0].missionId}/route`)}
                >
                  {drafts.some((d) => d.status === 'conflict') ? '冲突草稿' : '失败草稿'}
                </Button>
              </Badge>
            </Tooltip>
          ) : null}
          <Tag color={hasAmapKey() ? 'green' : 'gold'}>
            {hasAmapKey() ? '高德 JS API' : '本地 SVG 网格视图'}
          </Tag>
          <Badge color="#8ecae6" text={<span style={{ color: '#cfe3f2' }}>本地结构版本 v{version}</span>} />
        </Space>
      </Header>
      <Content className="app-content">
        <Routes>
          <Route path="/" element={<Navigate to="/missions" replace />} />
          <Route path="/missions" element={<MissionList />} />
          <Route path="/missions/:id/route" element={<RoutePlanner />} />
          <Route path="/missions/:id/waypoints" element={<WaypointTable />} />
          <Route path="/missions/:id/assets" element={<AssetCatalog />} />
          <Route path="/settings/camera" element={<CameraPreset />} />
          <Route path="*" element={<Navigate to="/missions" replace />} />
        </Routes>
      </Content>
    </Layout>
  );
}

/** 应用路由 + 本地数据引导（IndexedDB 迁移 + 示范数据 + 跨标签页批次同步） */
export default function AppRouter() {
  const [ready, setReady] = useState(false);
  const loadMissions = useMissionStore((s) => s.load);
  const loadWaypoints = useWaypointStore((s) => s.load);
  const loadAssets = useAssetStore((s) => s.load);
  const loadBatches = useBatchStore((s) => s.load);

  useEffect(() => {
    let alive = true;
    (async () => {
      await ensureSeedData();
      markDbVersion();
      await Promise.all([loadMissions(), loadWaypoints(), loadAssets(), loadBatches()]);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [loadMissions, loadWaypoints, loadAssets, loadBatches]);

  // 其它标签页提交批次数据后，本标签页重新从 IndexedDB 拉取（乐观锁仍兜底冲突）
  useEffect(() => {
    if (!ready) return;
    const off = onTick(() => {
      void Promise.all([loadBatches(), loadWaypoints(), loadAssets(), loadMissions()]);
    });
    return off;
  }, [ready, loadBatches, loadWaypoints, loadAssets, loadMissions]);

  if (!ready) {
    return (
      <Space direction="vertical" align="center" style={{ width: '100%', paddingTop: 160 }}>
        <Spin size="large" />
        <Typography.Text type="secondary">正在打开本地航线与成果档案库（IndexedDB）…</Typography.Text>
      </Space>
    );
  }

  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
