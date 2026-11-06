import type { Money, PriceHistory as History } from '../data/types';
import { formatMoney } from '../data/validation';
import { EmptyState, LoadError, LoadingRows } from './Ui';
import { useApiMode } from '../data/mode';

export default function PriceHistory({
  history,
  target,
  loading,
  error,
  retry,
}: {
  history?: History;
  target: Money;
  loading?: boolean;
  error?: unknown;
  retry?: () => void;
}) {
  const api = useApiMode();
  const points = history?.items ?? [];
  const compact = Boolean(history?.illustrative && points.length <= 7);
  const left = compact ? 48 : 55;
  const right = compact ? 334 : 655;
  const maximum =
    Math.max(
      target.amountMinor,
      ...points.map((point) => point.price.amountMinor),
      100,
    ) * 1.15;
  const y = (value: number) => 160 - (value / maximum) * 130;
  const x = (index: number) =>
    left + (index / Math.max(points.length - 1, 1)) * (right - left);
  return (
    <section className="history-section" aria-labelledby="history-title">
      <div className="section-heading">
        <h2 id="history-title">Price history</h2>
        <span>USD / Steam</span>
      </div>
      <p className="history-disclosure">
        {!api && history?.illustrative !== false
          ? 'Illustrative history — invented values, not recorded Steam prices or an all-store historical low.'
          : 'Successful observations of this Steam offer via CheapShark.'}
      </p>
      {api && history?.window ? (
        <p>
          Observation window: {history.window.from} to {history.window.to}{' '}
          (end exclusive). Retained from {history.retainedFrom}.
        </p>
      ) : null}
      {loading ? (
        <LoadingRows />
      ) : error ? (
        <LoadError error={error} retry={retry} />
      ) : !points.length ? (
        <EmptyState
          title="No observations yet"
          description="A successful price check will appear here. A failed check never adds a zero-price observation."
        />
      ) : (
        <>
          <div className="chart-legend">
            <span>
              <i className="price-key" aria-hidden="true" />
              {history?.illustrative
                ? 'Illustrative price'
                : 'Observed price'}
            </span>
            <span>
              <i className="target-key" aria-hidden="true" />
              Your target {formatMoney(target)}
            </span>
          </div>
          <div
            className="chart-scroll"
            role="region"
            aria-label={compact ? 'Price chart' : 'Price chart, scroll horizontally on small screens'}
            tabIndex={0}
          >
            <svg
              className={`history-chart${compact ? ' history-chart-compact' : ''}`}
              viewBox={compact ? '0 0 350 205' : '0 0 700 205'}
              role="img"
              aria-labelledby="chart-title"
              aria-describedby="chart-description"
            >
              <title id="chart-title">
                {history?.illustrative ? 'Illustrative sample' : 'Steam'}{' '}
                price chart
              </title>
              <desc id="chart-description">
                {api
                  ? 'Successful local USD observations'
                  : 'Daily illustrative USD values'}{' '}
                with your target shown as a dashed line. Dates and values are
                in the data table below.
              </desc>
              {[0, maximum / 2, maximum].map((value) => (
                <g key={value}>
                  <line
                    className="chart-grid"
                    x1={left}
                    x2={right}
                    y1={y(value)}
                    y2={y(value)}
                  />
                  <text className="chart-label" x="0" y={y(value) + 4}>
                    {formatMoney({
                      amountMinor: Math.round(value),
                      currency: 'USD',
                    })}
                  </text>
                </g>
              ))}
              <line
                className="chart-target"
                x1={left}
                x2={right}
                y1={y(target.amountMinor)}
                y2={y(target.amountMinor)}
              />
              <polyline
                className="chart-line"
                points={points
                  .map(
                    (point, index) =>
                      `${x(index)},${y(point.price.amountMinor)}`,
                  )
                  .join(' ')}
              />
              {points.map((point, index) => (
                <g key={point.id}>
                  <circle
                    className="chart-point"
                    cx={x(index)}
                    cy={y(point.price.amountMinor)}
                    r="4"
                  />
                  <text
                    className="chart-label"
                    x={x(index)}
                    y="190"
                    textAnchor="middle"
                  >
                    {point.observedAt.slice(5, 10)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          {!compact ? <p className="chart-scroll-hint">
            Scroll sideways to see every day.
          </p> : null}
          <details className="history-table">
            <summary>View chart data</summary>
            <div className="table-scroll">
              <table>
                <caption>
                  {history?.illustrative
                    ? 'Illustrative sample values, not actual recorded history.'
                    : 'Successful Steam observations.'}{' '}
                  All times UTC.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Price (USD)</th>
                    <th scope="col">Your target (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((point) => (
                    <tr key={point.id}>
                      <th scope="row">
                        {api
                          ? point.observedAt
                          : point.observedAt.slice(0, 10)}
                      </th>
                      <td>{formatMoney(point.price)}</td>
                      <td>{formatMoney(target)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
