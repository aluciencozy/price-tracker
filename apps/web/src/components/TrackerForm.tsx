import { useState } from 'react';
import type { SteamGame } from '../types/SteamGame';
import { Btn, Field, Panel, Status } from './Ui';

type TrackerFormProps = {
  game: SteamGame | null;
  targetMinor?: number;
  games: SteamGame[];
  onSave: (appId: number, targetMinor: number) => void;
  onCancel: () => void;
};

export default function TrackerForm({
  game,
  targetMinor,
  games,
  onSave,
  onCancel,
}: TrackerFormProps) {
  const [url, setUrl] = useState(
    game ? `https://store.steampowered.com/app/${game.appId}/` : '',
  );
  const [target, setTarget] = useState(
    targetMinor === undefined ? '' : (targetMinor / 100).toFixed(2),
  );
  const [message, setMessage] = useState('');

  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    let appId: number;
    // Parse the link locally; the API must validate actual game support later.
    try {
      if (/^\d+$/.test(url.trim())) appId = Number(url.trim());
      else {
        const parsed = new URL(url.trim());
        const match = parsed.pathname.match(/^\/app\/(\d+)(?:\/[^/]*)?\/?$/);
        if (
          parsed.protocol !== 'https:' ||
          parsed.hostname !== 'store.steampowered.com' ||
          parsed.port ||
          parsed.username ||
          parsed.password ||
          !match
        )
          throw new Error();
        appId = Number(match[1]);
      }
      if (
        !games.some((item) => item.appId === appId) ||
        (game && game.appId !== appId)
      )
        throw new Error();
    } catch {
      setMessage(
        'Use a sample Steam base-game URL or app ID from the example catalog. Other games, DLC, bundles, and editions require backend validation.',
      );
      return;
    }
    const value = target.trim();
    // Store targets as integer cents; zero is a valid target.
    const cents = Math.round(Number(value) * 100);
    if (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isSafeInteger(cents)) {
      setMessage(
        'Enter a non-negative USD target with at most two decimal places.',
      );
      return;
    }
    onSave(appId, cents);
  }

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Panel title={game ? 'Edit Steam tracker' : 'Add a Steam game'}>
          <form onSubmit={submit} className="space-y-4">
            <Field
              label="Steam base-game URL or app ID"
              value={url}
              onChange={setUrl}
              placeholder="https://store.steampowered.com/app/620/"
            />
            <Field
              label="Target price (USD)"
              type="number"
              min="0"
              step="0.01"
              value={target}
              onChange={setTarget}
              placeholder="8.00"
            />
            {message && <Status tone="error">{message}</Status>}
            <div className="flex flex-wrap gap-3">
              <Btn type="submit">Save tracker (mock)</Btn>
              <Btn variant="secondary" onClick={onCancel}>
                Cancel
              </Btn>
            </div>
          </form>
        </Panel>
      </div>
      <Panel title="Supported scope">
        <p className="mb-3 text-sm text-slate-300">
          PC base games · Steam offers · US / USD. DLC, bundles, and special
          editions are outside MVP scope.
        </p>
        <p className="text-sm text-slate-400">
          This local preview recognizes{' '}
          {games.map((item) => `${item.name} (${item.appId})`).join(', ')}.
          Prices are examples; live support must be validated by the API.
        </p>
        <div className="mt-4">
          <Btn
            variant="secondary"
            onClick={() => setUrl('https://store.steampowered.com/app/620/')}
          >
            Try Portal 2
          </Btn>
        </div>
      </Panel>
    </div>
  );
}
