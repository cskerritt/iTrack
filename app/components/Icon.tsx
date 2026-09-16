/*
 * ICONS
 * One shape per meaning, all drawn on the same 24px grid at one stroke weight,
 * so marks set at the same `size` read as one set. The stroke is in viewBox
 * units and therefore scales with `size` — a 13px mark carries a lighter line
 * than a 21px one, which is what keeps a small mark from going blobby. Keep
 * adjacent icons on the same size for them to weigh the same. Inline SVG
 * rather than a font or sprite: the app ships no icon dependency and has to
 * paint from the offline cache. Every icon is decorative — the label next to
 * it carries the meaning — so it stays out of the accessibility tree and the
 * surrounding element keeps whatever accessible name it already had.
 *
 * Filled variants exist only where the UI already distinguished filled from
 * outline (an earned badge, a completed quest). Everything else is outline.
 */
export const ICON_SHAPES = {
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  home: <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  credentials: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 10h8M8 14h5" />
    </>
  ),
  activityLog: <path d="M5 6h14M5 12h14M5 18h9" />,
  account: (
    <>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  check: <path d="M20 6 9 17l-5-5" />,
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  arrowUpRight: (
    <>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  refresh: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <path d="M12 6.6V12l3.8 2.2" />
    </>
  ),
  diamond: (
    <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.4l7.6 7.6a2.41 2.41 0 0 0 3.4 0l7.6-7.6a2.41 2.41 0 0 0 0-3.4l-7.6-7.6a2.41 2.41 0 0 0-3.4 0z" />
  ),
  diamondFilled: (
    <path
      d="M2.7 10.3a2.41 2.41 0 0 0 0 3.4l7.6 7.6a2.41 2.41 0 0 0 3.4 0l7.6-7.6a2.41 2.41 0 0 0 0-3.4l-7.6-7.6a2.41 2.41 0 0 0-3.4 0z"
      fill="currentColor"
    />
  ),
  circle: <circle cx="12" cy="12" r="9.4" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <circle cx="12" cy="12" r="3.6" />
    </>
  ),
  camera: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  ),
  save: (
    <>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v4h8" />
    </>
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <path d="M12 16.4v-4.6" />
      <path d="M12 7.9h.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <path d="M12 7.6v4.8" />
      <path d="M12 16.4h.01" />
    </>
  ),
  trendingUp: (
    <>
      <path d="M16 7h6v6" />
      <path d="m22 7-8.5 8.5-5-5L2 17" />
    </>
  ),
  zap: (
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  ),
};

export type IconName = keyof typeof ICON_SHAPES;

// Every icon is an inline SVG that inherits its colour from the control it
// sits in, so contrast is decided once by the surrounding token. Size is set
// per site so a mark matches the cap height of the text it stands next to;
// strokeWidth is a prop for the few marks drawn heavier (the rail's plus).
export function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_SHAPES[name]}
    </svg>
  );
}
