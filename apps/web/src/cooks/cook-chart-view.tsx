import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { unitSymbol, type TemperatureUnit } from '../live/format';
import { CHART_CHANNELS, type ChartChannel, type ChartRow } from './chart-series';

/**
 * Loaded with React.lazy (cook-chart.tsx), so recharts is its own chunk and
 * only the cook detail page downloads it.
 */

/** Categorical slots 1-5 of the dataviz default palette, validated on the white card (adjacent pairs). */
const CHANNEL_COLORS: Record<ChartChannel, string> = {
  grill: '#2a78d6',
  probe1: '#eb6834',
  probe2: '#1baf7a',
  probe3: '#eda100',
  probe4: '#e87ba4',
};

const CHART_HEIGHT_PX = 320;

const LABELS = Object.fromEntries(CHART_CHANNELS.map(c => [c.channel, c.label])) as Record<
  ChartChannel,
  string
>;

function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function CookChartView({
  rows,
  channels,
  unit,
}: {
  rows: ChartRow[];
  channels: ChartChannel[];
  unit: TemperatureUnit;
}) {
  const symbol = unitSymbol(unit);
  // A lone point has no line to draw; show it as a dot.
  const dot = rows.length < 2 ? { r: 4 } : false;
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
      <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#eaeef2" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={formatTime}
          stroke="#59636e"
          fontSize={12}
        />
        <YAxis
          domain={['auto', 'auto']}
          tickFormatter={(value: number) => `${value}${symbol}`}
          stroke="#59636e"
          fontSize={12}
          width={56}
        />
        <Tooltip
          content={props => <ChartTooltip {...props} channels={channels} symbol={symbol} />}
        />
        <Legend />
        {channels.map(channel => (
          <Area
            key={`${channel}-band`}
            dataKey={(row: ChartRow) => (row[channel] ? [row[channel].lo, row[channel].hi] : null)}
            name={`${LABELS[channel]} min–max`}
            legendType="none"
            tooltipType="none"
            stroke="none"
            fill={CHANNEL_COLORS[channel]}
            fillOpacity={0.15}
            isAnimationActive={false}
            activeDot={false}
          />
        ))}
        {channels.map(channel => (
          <Line
            key={`${channel}-avg`}
            className={`chart-line chart-line-${channel}`}
            dataKey={(row: ChartRow) => row[channel]?.avg ?? null}
            name={LABELS[channel]}
            stroke={CHANNEL_COLORS[channel]}
            strokeWidth={2}
            dot={dot}
            isAnimationActive={false}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** At the hovered time: each channel's avg, min and max, in the device's unit. */
function ChartTooltip({
  active,
  payload,
  label,
  channels,
  symbol,
}: {
  active?: boolean;
  payload?: readonly { payload?: unknown }[];
  label?: string | number;
  channels: ChartChannel[];
  symbol: string;
}) {
  const row = payload?.[0]?.payload as ChartRow | undefined;
  if (!active || !row) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-time">{formatTime(Number(label ?? row.t))}</div>
      <table>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">avg</th>
            <th scope="col">min</th>
            <th scope="col">max</th>
          </tr>
        </thead>
        <tbody>
          {channels
            .filter(channel => row[channel])
            .map(channel => {
              const value = row[channel] as NonNullable<ChartRow[ChartChannel]>;
              return (
                <tr key={channel}>
                  <th scope="row">
                    <span
                      className="chart-swatch"
                      style={{ background: CHANNEL_COLORS[channel] }}
                      aria-hidden="true"
                    />
                    {LABELS[channel]}
                  </th>
                  <td>
                    {value.avg} {symbol}
                  </td>
                  <td>
                    {value.lo} {symbol}
                  </td>
                  <td>
                    {value.hi} {symbol}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
