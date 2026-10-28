import { Link, NavLink, useLocation } from 'react-router-dom';
import { ScanLine } from 'lucide-react';
import { Button } from './ui/button';
export default function Header() {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link to="/" className="brand" aria-label="Price Tracker home">
          <ScanLine aria-hidden="true" />
          <span>
            price tracker<span className="brand-period">.</span>
          </span>
        </Link>
        <nav aria-label="Main navigation">
          {useLocation().pathname === '/' ? (
            <>
              <Button asChild variant="ghost">
                <Link to="/login">Sign in</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/register">Create account</Link>
              </Button>
            </>
          ) : (
            <>
              <NavLink to="/watchlist">Watchlist</NavLink>
              <NavLink to="/account">Account</NavLink>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
