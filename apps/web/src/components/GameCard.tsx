import { Link } from 'react-router-dom';
import { ArrowUpRight, Mail, Smartphone } from 'lucide-react';
import type { Product, TrackedItem } from '../data/types';
import { formatMoney, trackerStatus } from '../data/validation';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
export function GameArt({ product }: { product: Product }) {
  return (
    <img
      className="game-art"
      src={product.imageUrl || '/art/fallback.svg'}
      alt=""
      loading="lazy"
      width="120"
      height="56"
      onError={(event) => {
        event.currentTarget.onerror = null;
        event.currentTarget.src = '/art/fallback.svg';
      }}
    />
  );
}
export default function GameCard({ item }: { item: TrackedItem }) {
  return (
    <li className="game-row">
      <div className="game-identity">
        <GameArt product={item.product} />
        <div className="game-title">
          <Link to={`/watchlist/${item.id}`}>
            <h2>{item.product.title}</h2>
          </Link>
          <p>Steam / US / USD</p>
          <div className="row-status">
            <Badge variant="secondary">{trackerStatus(item)}</Badge>
          </div>
        </div>
      </div>
      <dl className="row-prices">
        <div>
          <dt>Last-known price</dt>
          <dd>{formatMoney(item.product.currentPrice)}</dd>
        </div>
        <div>
          <dt>Your target</dt>
          <dd>{formatMoney(item.targetPrice)}</dd>
        </div>
      </dl>
      <div className="row-end">
        <div
          className="channel-summary"
          role="group"
          aria-label={`Email ${item.alerts.email ? 'on' : 'off'}, Android push ${item.alerts.push ? 'on' : 'off'}`}
        >
          <Mail aria-hidden="true" />
          <span>{item.alerts.email ? 'On' : 'Off'}</span>
          <Smartphone aria-hidden="true" />
          <span>{item.alerts.push ? 'On' : 'Off'}</span>
        </div>
        <Button asChild variant="ghost">
          <Link
            to={`/watchlist/${item.id}`}
            aria-label={`Details for ${item.product.title}`}
          >
            Details
            <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </li>
  );
}
