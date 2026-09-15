import { notFound } from "next/navigation";
import { Styleguide } from "./Styleguide";

export const dynamic = "force-dynamic";

// Development only: the primitives and instruments in every state, so axe,
// the screenshot gate and the e2e suite have a surface for cases no real
// screen reaches yet (nested dialogs, a form error summary, every ring state).
// vinext inlines process.env.NODE_ENV as "production" in `npm run build`, so
// the deployed worker answers 404 here (tests/rendered-html.test.mjs).
export default function StyleguidePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Styleguide />;
}
