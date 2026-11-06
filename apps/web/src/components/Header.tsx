import { Link, NavLink, useLocation } from 'react-router-dom';
import { ScanLine } from 'lucide-react';
import { Button } from './ui/button';
import { useApiSession } from '../client/sessionContext';
export default function Header() {
  const location = useLocation();
  const session = useApiSession();
  const authPage = [
    '/login', '/register', '/verify', '/verify-email', '/forgot', '/reset', '/reset-password',
  ].includes(location.pathname);
  const signedOut = session && session.session.status !== 'authenticated';
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
          {(session ? signedOut : location.pathname === '/' || authPage) ? (
            <>
              <NavLink to="/watchlist">Watchlist</NavLink>
              {location.pathname !== '/login' ? (
                <Button asChild variant="ghost"><Link to="/login">Sign in</Link></Button>
              ) : null}
              {location.pathname !== '/register' ? (
                <Button asChild variant="outline"><Link to="/register">Create account</Link></Button>
              ) : null}
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
