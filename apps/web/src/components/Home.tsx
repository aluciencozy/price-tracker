import { Link } from 'react-router-dom';
import { Bell, Link2, SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { useApiMode } from '../data/mode';
export default function Home() {
  const api = useApiMode();
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <p className="hero-context">For the games on your someday list.</p>
        <h1 id="hero-title" tabIndex={-1}>
          Good games.
          <br />
          Your price.
        </h1>
        <p className="hero-description">
          Keep a little list. Pick your price.
          <br />
          Let the next Steam deal come to you.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/watchlist">
              {api ? 'Open watchlist' : 'Try sample'}
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/register">
              {api ? 'Create account' : 'Preview account setup'}
            </Link>
          </Button>
        </div>
        <p className="hero-note">
          {api
            ? 'Sign in with a verified account. Saved games use the shared API.'
            : 'No sign-up needed for the sample. Nothing is saved.'}
        </p>
      </section>
      <section className="landing-example" aria-label="Example tracker">
        <div className="example-intro">
          <span>A small list. A clear target.</span>
          <span>Sample view</span>
        </div>
        <div className="example-game">
          <img
            src="/art/620.jpg"
            alt=""
            onError={(event) => {
              event.currentTarget.onerror = null;
              event.currentTarget.src = '/art/fallback.svg';
            }}
          />
          <div>
            <strong>Portal 2</strong>
            <p>Steam / US / USD</p>
          </div>
          <div className="example-price">
            <span>Recorded price</span>
            <strong>$9.99</strong>
          </div>
          <div className="example-price">
            <span>Your target</span>
            <strong>$4.99</strong>
          </div>
        </div>
        <p className="example-caption">
          October 26 snapshot via CheapShark. Not a live quote.
        </p>
      </section>
      <section className="how-it-works" aria-labelledby="how-title">
        <Separator />
        <div className="section-intro">
          <h2 id="how-title">
            Less checking.
            <br />
            More playing.
          </h2>
          <p>
            The planned service follows one exact Steam base-game offer. No
            all-store price guessing.
          </p>
        </div>
        <div className="steps">
          <article>
            <Link2 aria-hidden="true" />
            <h3>Save the game</h3>
            <p>Start with a supported Steam base-game link.</p>
          </article>
          <article>
            <SlidersHorizontal aria-hidden="true" />
            <h3>Set your target</h3>
            <p>Choose a USD price and alerts for that game.</p>
          </article>
          <article>
            <Bell aria-hidden="true" />
            <h3>Hear when it qualifies</h3>
            <p>
              {api
                ? 'The server checks daily. Email and opted-in Android push depend on configured services; saving a target does not prove delivery.'
                : 'Planned daily checks, email, and opted-in Android push. Not connected in this sample.'}
            </p>
          </article>
        </div>
      </section>
    </>
  );
}
