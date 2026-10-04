import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { db, ensureSeedData } from '../utils/db';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useBatchStore } from '../stores/batchStore';
import RoutePlanner from '../pages/RoutePlanner';
import WaypointTable from '../pages/WaypointTable';
import AssetCatalog from '../pages/AssetCatalog';
import MissionList from '../pages/MissionList';

async function prepare() {
  window.localStorage.clear();
  db.close();
  await db.delete();
  await db.open();
  await ensureSeedData();
  await Promise.all([
    useMissionStore.getState().load(),
    useWaypointStore.getState().load(),
    useAssetStore.getState().load(),
    useBatchStore.getState().load(),
  ]);
}

async function renderAt(path: string): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/missions" element={<MissionList />} />
          <Route path="/missions/:id/route" element={<RoutePlanner />} />
          <Route path="/missions/:id/waypoints" element={<WaypointTable />} />
          <Route path="/missions/:id/assets" element={<AssetCatalog />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  const text = container.textContent ?? '';
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return text;
}

describe('页面渲染冒烟（批次数据贯通台账/地图/航点表/成果编目）', () => {
  beforeEach(async () => {
    await prepare();
  });

  it('任务台账显示任务与批次字段', async () => {
    const text = await renderAt('/missions');
    expect(text).toContain('DM-2024-018');
    expect(text).toContain('批次');
  });

  it('航线规划页显示批次切换器、当前/冻结批次标签', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-018')!;
    const text = await renderAt(`/missions/${mission.id}/route`);
    expect(text).toContain('批次 1');
    expect(text).toContain('批次 2');
    expect(text).toContain('保存为新批次');
  });

  it('航点明细页按批次展示且冻结批次只读', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-018')!;
    const text = await renderAt(`/missions/${mission.id}/waypoints`);
    expect(text).toContain('航点明细');
    expect(text).toContain('已冻结');
  });

  it('成果编目页展示拍摄批次与提交按钮', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-018')!;
    const text = await renderAt(`/missions/${mission.id}/assets`);
    expect(text).toContain('成果影像编目');
    expect(text).toContain('按本批次航点编目并提交');
    // 默认选中当前批次（批次 2，无成果），但批次 1 的 6 张成果仍在库
    expect(useAssetStore.getState().items).toHaveLength(6);
  });

  it('同一批次下 store 的航点/成果与批次指标完全一致', async () => {
    const mission = useMissionStore.getState().items.find((m) => m.missionNo === 'DM-2024-018')!;
    for (const batch of useBatchStore.getState().byMission(mission.id)) {
      const wp = useWaypointStore.getState().byBatch(batch.id);
      const assets = useAssetStore.getState().byBatch(batch.id);
      wp.forEach((w) => expect(w.missionId).toBe(mission.id));
      assets.forEach((a) => expect(a.batchId).toBe(batch.id));
      expect(batch.metrics.waypointCount).toBe(wp.length);
    }
  });
});
