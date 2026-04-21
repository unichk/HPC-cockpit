// Reusable visual components — ported from the Claude Design bundle.

function Sparkline({ values, filled = true }) {
  if (!values || values.length === 0) return null;
  const w = 100;
  const h = 100;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(1, max - min);
  const pts = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 10) - 5;
    return [x, y];
  });
  const linePath = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {filled && <path className="area" d={areaPath} />}
      <path className="line" d={linePath} />
    </svg>
  );
}

function Ring({ pct, text, size = 44, tone = "" }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  const offset = c - (p / 100) * c;
  const color =
    tone === "crit" ? "var(--crit)" :
    tone === "warn" ? "var(--warn)" :
    "var(--ok)";
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" className="cpu-ring">
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--line)" strokeWidth="3.5" />
      <circle
        cx="22" cy="22" r={r}
        fill="none"
        stroke={color}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 22 22)"
        style={{ transition: "stroke-dashoffset 400ms cubic-bezier(.4,.2,.2,1), stroke 200ms" }}
      />
      <text x="22" y="22" textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: 11, fontWeight: 800, fill: "var(--ink)", fontFamily: "var(--font)" }}>
        {text}
      </text>
    </svg>
  );
}

function FanIcon({ className = "fan-icon" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M12 3c-1.5 0-3 1-3 3c0 2 3 4 3 4s3-2 3-4c0-2-1.5-3-3-3z" opacity="0.85"/>
      <path d="M12 21c1.5 0 3-1 3-3c0-2-3-4-3-4s-3 2-3 4c0 2 1.5 3 3 3z" opacity="0.85"/>
      <path d="M3 12c0-1.5 1-3 3-3c2 0 4 3 4 3s-2 3-4 3c-2 0-3-1.5-3-3z" opacity="0.85"/>
      <path d="M21 12c0 1.5-1 3-3 3c-2 0-4-3-4-3s2-3 4-3c2 0 3 1.5 3 3z" opacity="0.85"/>
    </svg>
  );
}

Object.assign(window, { Sparkline, Ring, FanIcon });
