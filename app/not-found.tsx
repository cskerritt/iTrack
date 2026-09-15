import Link from "next/link";
import { buttonClassName } from "./lib/buttonClass";

export default function NotFound() {
  return (
    <main id="main-content" className="main-content not-found">
      <section className="error-fallback">
        <h1>Page not found</h1>
        <p>That address doesn&rsquo;t match anything in iTrack.</p>
        <p>
          <Link className={buttonClassName("primary")} href="/">
            Go to Home
          </Link>
        </p>
      </section>
    </main>
  );
}
