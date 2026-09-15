// The brand as text: a blue "i" and "Track" in the display face. The visible
// text names it ("iTrack"), so there is no aria-label — on a generic element
// one is prohibited and was never read out (a11y-12).
export function Brand({
  size = "rail",
  className,
}: {
  size?: "rail" | "bar";
  className?: string;
}) {
  return (
    <span className={["brand", `brand-${size}`, className].filter(Boolean).join(" ")}>
      <span className="brand-i">i</span>Track
    </span>
  );
}
