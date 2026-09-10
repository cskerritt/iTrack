import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main-content" className="main-content not-found">
      <section className="error-fallback">
        <h1>Page not found</h1>
        <p>That address doesn&rsquo;t match anything in iTrack.</p>
        <p>
          <Link className="button button-primary" href="/">
            Go to Home
          </Link>
        </p>
      </section>
    </main>
  );
}
