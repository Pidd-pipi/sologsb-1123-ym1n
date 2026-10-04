import { Alert, Button, Card, Col, Descriptions, Divider, InputNumber, Row, Slider, Space, Statistic, Table, Tag, Typography, type TableProps } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import type { RouteMetrics, RouteParams } from '../../hooks/useRouteMetrics';
import type { BatchMetrics } from '../../types/batch';

export interface OverlapCalcPanelProps {
  params: RouteParams;
  onChange: (patch: Partial<RouteParams>) => void;
  /** 实时回算指标（含未保存改动） */
  metrics: RouteMetrics;
  /** 冻结批次时传入保存时指标，面板以只读方式展示 */
  frozenMetrics?: BatchMetrics;
  onSave?: () => void;
  /** 参数相对当前批次有未保存改动：预计张数等按新值即时重算，保存后才冻结 */
  dirty?: boolean;
  saving?: boolean;
  /** 查看冻结批次时禁用编辑 */
  readOnly?: boolean;
}

type SortieRow = { sortie: number; photos: number; durationMin: number };

const columns: NonNullable<TableProps<SortieRow>['columns']> = [
  { title: '架次', dataIndex: 'sortie', width: 70, render: (v: number) => `第 ${v} 架次` },
  { title: '预计张数', dataIndex: 'photos', width: 100 },
  { title: '预计耗时 min', dataIndex: 'durationMin', width: 120 },
];

/**
 * 重叠率 / 航高 / 航速表单与 GSD、航线间距、预计张数的实时回算面板。
 * 被航线规划页（/missions/:id/route）与相机预设页（/settings/camera）消费。
 */
export default function OverlapCalcPanel({
  params,
  onChange,
  metrics,
  frozenMetrics,
  onSave,
  dirty = false,
  saving = false,
  readOnly = false,
}: OverlapCalcPanelProps) {
  const shown: RouteMetrics = frozenMetrics
    ? {
        ...metrics,
        ...frozenMetrics,
      }
    : metrics;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }} data-testid="overlap-calc-panel">
      {readOnly ? (
        <Alert type="info" showIcon message="当前查看的是已冻结批次，参数只读；改动请切回「当前」批次后保存（会开新批次）。" />
      ) : null}
      {!readOnly && dirty ? (
        <Alert
          type="warning"
          showIcon
          message="参数已改动：预计张数等指标已按新值失效重算；保存后进入新批次并冻结，旧批次航点不变。"
        />
      ) : null}

      <Card size="small" title="航线参数">
        <Row gutter={[12, 8]}>
          <Col span={12}>
            <Typography.Text type="secondary">相对航高（m）</Typography.Text>
            <InputNumber
              style={{ width: '100%' }}
              disabled={readOnly}
              min={20}
              max={600}
              step={5}
              value={params.altitude}
              onChange={(v) => onChange({ altitude: Number(v ?? 0) })}
            />
          </Col>
          <Col span={12}>
            <Typography.Text type="secondary">航速（m/s）</Typography.Text>
            <InputNumber
              style={{ width: '100%' }}
              disabled={readOnly}
              min={1}
              max={25}
              step={0.5}
              value={params.speed}
              onChange={(v) => onChange({ speed: Number(v ?? 0) })}
            />
          </Col>
          <Col span={24}>
            <Typography.Text type="secondary">航向重叠率 {params.overlapForward} %</Typography.Text>
            <Slider min={50} max={90} disabled={readOnly} value={params.overlapForward} onChange={(v) => onChange({ overlapForward: v })} />
          </Col>
          <Col span={24}>
            <Typography.Text type="secondary">旁向重叠率 {params.overlapSide} %</Typography.Text>
            <Slider min={40} max={90} disabled={readOnly} value={params.overlapSide} onChange={(v) => onChange({ overlapSide: v })} />
          </Col>
          <Col span={24}>
            <Typography.Text type="secondary">航带方向（°）</Typography.Text>
            <Slider min={0} max={180} disabled={readOnly} value={params.heading} onChange={(v) => onChange({ heading: v })} />
          </Col>
        </Row>
        {onSave ? (
          <>
            <Divider style={{ margin: '10px 0' }} />
            <Space wrap>
              <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving} disabled={readOnly || !dirty}>
                保存为新批次
              </Button>
              {!dirty ? <Typography.Text type="secondary">参数与当前批次一致</Typography.Text> : null}
            </Space>
          </>
        ) : null}
      </Card>

      <Card size="small" title={frozenMetrics ? '批次冻结指标（保存时快照）' : dirty ? '实时回算结果（未保存，待冻结）' : '实时回算结果'}>
        <Row gutter={[12, 12]}>
          <Col span={8}>
            <Statistic title="地面分辨率 GSD" value={shown.gsd} precision={2} suffix="cm/px" />
          </Col>
          <Col span={8}>
            <Statistic title="航线间距" value={shown.spacing} precision={2} suffix="m" />
          </Col>
          <Col span={8}>
            <Statistic title="拍照间隔" value={shown.photoInterval} precision={2} suffix="m" />
          </Col>
          <Col span={8}>
            <Statistic
              title="预计张数"
              value={shown.estPhotos}
              suffix="张"
              prefix={dirty && !frozenMetrics ? <Tag color="orange">待冻结</Tag> : null}
            />
          </Col>
          <Col span={8}>
            <Statistic title="预计耗时" value={shown.estDuration} precision={1} suffix="min" />
          </Col>
          <Col span={8}>
            <Statistic title="预计电池组数" value={shown.batteryCount} suffix="组" />
          </Col>
        </Row>
        <Divider style={{ margin: '10px 0' }} />
        <Descriptions size="small" column={2} colon={false}>
          <Descriptions.Item label="测区面积">{shown.area.toFixed(0)} m²</Descriptions.Item>
          <Descriptions.Item label="航带路径长度">{shown.pathLength.toFixed(1)} m</Descriptions.Item>
          <Descriptions.Item label="预计航带数">{shown.lineCount} 条</Descriptions.Item>
          <Descriptions.Item label="航点数量">{shown.waypointCount} 个</Descriptions.Item>
          <Descriptions.Item label="航向幅宽">{shown.coverageForward ?? '—'} m</Descriptions.Item>
          <Descriptions.Item label="旁向幅宽">{shown.coverageSide ?? '—'} m</Descriptions.Item>
        </Descriptions>
        {shown.sorties ? (
          <div style={{ marginTop: 6 }}>
            {shown.sorties.map((s) => (
              <Tag key={s.sortie} color="blue">
                第 {s.sortie} 架次 · {s.photos} 张 · {s.durationMin} min
              </Tag>
            ))}
          </div>
        ) : null}
      </Card>

      {shown.sorties ? (
        <Card size="small" title="多架次拆分">
          <Table<SortieRow>
            rowKey="sortie"
            size="small"
            columns={columns}
            dataSource={shown.sorties}
            pagination={false}
            locale={{ emptyText: '暂无架次拆分' }}
          />
        </Card>
      ) : null}
    </Space>
  );
}
