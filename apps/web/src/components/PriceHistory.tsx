import type { Money, PriceHistory as History } from '../data/types';
import { formatMoney } from '../data/validation';
import { EmptyState, LoadError, LoadingRows } from './Ui';

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
  const points = history?.items ?? [];
  const maximum =
    Math.max(
      target.amountMinor,
      ...points.map((point) => point.price.amountMinor),
      100,
    ) * 1.15;
  const y = (value: number) => 160 - (value / maximum) * 130;
  const x = (index: number) =>
    55 + (index / Math.max(points.length - 1, 1)) * 600;
  return (
    <section className="history-section" aria-labelledby="history-title">
      <div className="section-heading">
        <h2 id="history-title">Price history</h2>
        <span>USD / Steam</span>
      </div>
      <p className="history-disclosure">
        {history?.illustrative !== false
          ? 'Illustrative sample history. These multi-day values are invented for this chart, not recorded Steam observations or an all-store historical low.'
          : 'Successful observations of this Steam offer via CheapShark.'}
      </p>
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
              {history?.illustrative ? 'Illustrative price' : 'Observed price'}
            </span>
            <span>
              <i className="target-key" aria-hidden="true" />
              Your target {formatMoney(target)}
            </span>
          </div>
          <div
            className="chart-scroll"
            role="region"
            aria-label="Price chart, scroll horizontally on small screens"
            tabIndex={0}
          >
            <svg
              className="history-chart"
              viewBox="0 0 700 205"
              role="img"
              aria-labelledby="chart-title"
              aria-describedby="chart-description"
            >
              <title id="chart-title">
                {history?.illustrative ? 'Illustrative sample' : 'Steam'} price
                chart
              </title>
              <desc id="chart-description">
                Daily USD values with your target shown as a dashed line. Dates
                and values are in the data table below.
              </desc>
              {[0, maximum / 2, maximum].map((value) => (
                <g key={value}>
                  <line
                    className="chart-grid"
                    x1="55"
                    x2="655"
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
                x1="55"
                x2="655"
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
          <p className="chart-scroll-hint">
            Scroll sideways to see every day.
          </p>
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
                      <th scope="row">{point.observedAt.slice(0, 10)}</th>
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
