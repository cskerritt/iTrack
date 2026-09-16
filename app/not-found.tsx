import Link from "next/link";
import { PageHeader } from "./components/PageHeader";
import { buttonClassName } from "./lib/buttonClass";

// Rendered by the root layout outside the app shell (no workspace, no rail):
// the page frame, a real title and a Button-styled link home. Not an alert —
// a 404 is a page, so there is no role="alert" here.
export default function NotFound() {
  return (
    <main id="main-content" className="app-main app-main-solo">
      <PageHeader
        title="Page not found"
        lede="That address doesn’t match anything in iTrack."
        documentTitle="Page not found · iTrack"
      />
      <p>
        <Link className={buttonClassName("primary")} href="/">
          Go to Home
        </Link>
      </p>
    </main>
  );
}
