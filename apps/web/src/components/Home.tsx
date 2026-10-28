import type { Page } from '../types/Navigation';

type HomeProps = { navigate: (page: Page) => void; onAdd: () => void };

const steps = [
  {
    number: '01',
    title: 'Add a game',
    description: 'Paste a supported Steam game link.',
  },
  {
    number: '02',
    title: 'Set your price',
    description: 'Choose how much you want to pay in USD.',
  },
  {
    number: '03',
    title: 'Get notified',
    description: 'Daily checks and price alerts are planned.',
  },
];

export default function Home({ navigate, onAdd }: HomeProps) {
  return (
    <main id="main-content" className="mx-auto max-w-6xl px-4 pb-6 sm:px-6">
      <section aria-labelledby="home-title" className="py-16 sm:py-20">
        <div>
          <p className="mb-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-teal-300"
            />
            For your next great game
          </p>
          <h1
            id="home-title"
            className="max-w-xl text-5xl font-black leading-[1.08] tracking-tight text-white sm:text-6xl lg:text-7xl"
          >
            Price <span className="text-teal-300">Tracker</span>
          </h1>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-slate-400">
            Your wishlist. Your price. A simpler way to keep an eye on the Steam
            games you want to play next.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              onClick={onAdd}
              className="inline-flex min-h-12 items-center gap-6 rounded-lg bg-teal-300 px-6 py-3 font-bold text-slate-950 transition-colors hover:bg-teal-200"
            >
              Try a tracker <span aria-hidden="true">↗</span>
            </button>
            <button
              onClick={() => navigate('watchlist')}
              className="min-h-12 rounded-lg border border-slate-700 px-5 py-3 font-semibold text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800"
            >
              Explore the watchlist
            </button>
          </div>
          <p className="mt-5 text-xs text-slate-500">
            Steam base games{' '}
            <span aria-hidden="true" className="px-2">
              /
            </span>{' '}
            US prices in USD
          </p>
        </div>
      </section>
      <section
        aria-labelledby="how-it-works"
        className="border-t border-slate-800 py-8"
      >
        <h2 id="how-it-works" className="mb-6 text-xl font-semibold text-white">
          How it works
        </h2>
        <ol className="grid gap-6 md:grid-cols-3">
          {steps.map((step) => (
            <li key={step.number} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="pt-0.5 font-mono text-sm text-teal-300"
              >
                {step.number}
              </span>
              <div>
                <h3 className="font-semibold text-white">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  {step.description}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
