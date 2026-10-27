function Header() {
    return (
        <div>
            <header className="flex items-center justify-between gap-4 border-b border-slate-700 pb-6">
                <a href="/" className="text-lg font-bold tracking-tight text-white">
                    Price<span className="text-teal-300">Tracker</span>
                </a>

                <span className="rounded-full border border-slate-600 px-3 py-1 text-xs font-medium text-slate-300">
                    Development starter
                </span>
            </header>
        </div>
    )
}

export default Header;