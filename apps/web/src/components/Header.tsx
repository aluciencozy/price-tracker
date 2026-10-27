import type { Page } from '../types/Navigation';

type HeaderProps = {
  page: Page;
  navigate: (page: Page) => void;
  onAdd: () => void;
};

export default function Header({ page, navigate, onAdd }: HeaderProps) {
  return (
    <header className="border-b border-slate-700 bg-slate-900/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
        <button
          onClick={() => navigate('home')}
          aria-label="Price Tracker home"
          className="text-left text-lg font-black text-white"
        >
          Price<span className="text-teal-300">Tracker</span>
        </button>
        <nav
          aria-label="Main navigation"
          className="flex max-w-full flex-wrap items-center gap-2 text-sm"
        >
          {(
            [
              { page: 'home', label: 'Home' },
              { page: 'watchlist', label: 'Watchlist' },
              { page: 'tracker', label: 'Add tracker' },
              { page: 'notifications', label: 'Notifications' },
            ] as const
          ).map((item) => (
            <button
              key={item.page}
              aria-current={page === item.page ? 'page' : undefined}
              onClick={() =>
                item.page === 'tracker' ? onAdd() : navigate(item.page)
              }
              className={`rounded-lg px-3 py-2 ${page === item.page ? 'bg-teal-950 font-bold text-teal-200' : 'text-slate-300 hover:bg-slate-800'}`}
            >
              {item.label}
            </button>
          ))}
          <button
            onClick={() => navigate('login')}
            aria-current={page === 'login' ? 'page' : undefined}
            className="rounded-lg border border-slate-600 px-3 py-2"
          >
            Sign in
          </button>
        </nav>
      </div>
    </header>
  );
}
