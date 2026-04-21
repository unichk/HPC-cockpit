// ScheduleGantt — today's schedule at a glance in the dashboard sidebar.
// Events come from the live /api/schedule feed (absolute ms); we filter to today.

const EVT_PALETTE = [
  "#5fb96a","#569cd6","#e8a13a","#c792ea","#4ec9b0",
  "#f44747","#ce9178","#dcdcaa","#9cdcfe","#c72c74",
  "#7ed88a","#a8b8e8",
];
const evtColor = id => EVT_PALETTE[((id | 0) - 1 + EVT_PALETTE.length * 2) % EVT_PALETTE.length];

const TIME_W = 24;

function ScheduleGantt({ nodes, events, startH = 0, endH = 24 }) {
  const { useEffect, useState, useRef } = React;
  const wrapRef = useRef(null);
  const [panelW, setPanelW] = useState(0);
  const [tooltip, setTooltip] = useState(null);
  const totalHours = Math.max(1, endH - startH);

  const [nowFrac, setNowFrac] = useState(() => {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  });

  useEffect(() => {
    const measure = () => {
      if (wrapRef.current) setPanelW(wrapRef.current.getBoundingClientRect().width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const d = new Date();
      setNowFrac(d.getHours() + d.getMinutes() / 60);
    }, 30000);
    return () => clearInterval(t);
  }, []);

  // Decompose each event → which of today's node columns it touches and at what hour fraction.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 3600 * 1000);

  const nodeIds = nodes.map(n => n.id);
  if (nodeIds.length === 0) {
    return (
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0 }}>
        <div className="sch-mini-empty">No nodes reporting yet</div>
      </div>
    );
  }
  const colW   = panelW > 0 ? Math.floor((panelW - TIME_W) / nodeIds.length) : 26;
  const totalW = panelW > 0 ? panelW : TIME_W + nodeIds.length * colW;

  const hPct = h => `${Math.max(0, Math.min(100, ((h - startH) / totalHours) * 100))}%`;
  const nowVisible = nowFrac >= startH && nowFrac <= endH;
  const nowPct = `${((nowFrac - startH) / totalHours) * 100}%`;

  // Build list of per-column segments for events overlapping today.
  const segments = [];
  for (const ev of events || []) {
    const s = new Date(ev.startMs);
    const e = new Date(ev.endMs);
    if (e <= todayStart || s >= todayEnd) continue;
    const clampedS = s < todayStart ? todayStart : s;
    const clampedE = e > todayEnd ? todayEnd : e;
    const startHour = (clampedS - todayStart) / 3600000;
    const endHour = (clampedE - todayStart) / 3600000;
    const targets = (ev.nodes === "all")
      ? nodeIds
      : String(ev.nodes || "").split(",").map(s => s.trim()).filter(Boolean);
    for (const nodeId of targets) {
      const col = nodeIds.indexOf(nodeId);
      if (col < 0) continue;
      segments.push({ ev, col, startH: startHour, endH: endHour });
    }
  }

  return (
    <div ref={wrapRef} style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0, overflow:"hidden" }}>
      {/* Column headers */}
      <div style={{ display:"flex", flexShrink:0, background:"var(--surface-2)", borderBottom:"1px solid var(--line)", width:totalW }}>
        <div style={{ width:TIME_W, fontSize:7, color:"var(--muted)", fontWeight:700, padding:"3px 2px" }}>HR</div>
        {nodeIds.map(id => (
          <div key={id} style={{ width:colW, fontSize:8, fontWeight:700, color:"var(--ink)", padding:"3px 2px", textAlign:"center", fontFamily:"var(--mono)", borderLeft:"1px solid var(--line-2)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={id}>
            {id.replace(/^(hpc-|fake-)/, "")}
          </div>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex:1, minHeight:0, position:"relative", overflow:"hidden", width:totalW }}>
        {/* Hour lines */}
        {Array.from({ length: totalHours + 1 }, (_, i) => startH + i).map(h => (
          <div key={h} style={{ position:"absolute", left:0, right:0, top:hPct(h), height:1, background: h%6===0?"var(--line)":"var(--line-2)", zIndex:1 }}>
            {h < endH && (
              <span style={{ position:"absolute", left:1, top:1, fontSize:7.5, color:"var(--muted)", fontWeight:700, fontVariantNumeric:"tabular-nums", lineHeight:1, opacity:h%3===0?1:0.4 }}>
                {String(h).padStart(2,"0")}
              </span>
            )}
          </div>
        ))}

        {/* Alternating bands */}
        {Array.from({ length: totalHours }, (_, i) => startH + i).map(h => h%2===1 ? (
          <div key={h} style={{ position:"absolute", left:TIME_W, right:0, top:hPct(h), height:`calc(${hPct(startH+1)} - 0px)`, background:"color-mix(in oklab, var(--line-2) 60%, transparent)", zIndex:0 }} />
        ) : null)}

        {/* Column separators */}
        {nodeIds.map((_,i) => (
          <div key={i} style={{ position:"absolute", top:0, bottom:0, left:TIME_W + i*colW, width:1, background:"var(--line-2)", zIndex:1 }} />
        ))}

        {/* Events */}
        {segments.map((seg, idx) => {
          const ev = seg.ev;
          const clampedStart = Math.max(seg.startH, startH);
          const clampedEnd   = Math.min(seg.endH, endH);
          if (clampedEnd <= clampedStart) return null;
          const color = evtColor(ev.id);
          const heightPct = ((clampedEnd - clampedStart) / totalHours) * 100;
          const topPct = ((clampedStart - startH) / totalHours) * 100;
          return (
            <a key={`${ev.id}-${seg.col}-${idx}`} href="schedule.html"
              onMouseEnter={e => setTooltip({ ev, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setTooltip(null)}
              onMouseMove={e => setTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
              style={{ position:"absolute", left:TIME_W + seg.col*colW + 2, width:colW-4, top:`${topPct}%`, height:`${heightPct}%`, background:color, borderRadius:3, zIndex:3, opacity:0.88, display:"flex", cursor:"pointer", textDecoration:"none", overflow:"hidden", alignItems:"center", justifyContent:"center", padding:"2px 0" }}
            >
              <span style={{ fontSize:8, fontWeight:800, color:"#fff", writingMode:"vertical-rl", textOrientation:"mixed", lineHeight:1, letterSpacing:"0.02em", overflow:"hidden", maxHeight:"96%", opacity:0.95, margin:"auto", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:colW-6 }}>
                {ev.title}
              </span>
            </a>
          );
        })}

        {/* Current time line */}
        {nowVisible && (
          <div style={{ position:"absolute", left:0, right:0, top:nowPct, height:2, background:"var(--crit)", zIndex:10, pointerEvents:"none" }}>
            <div style={{ position:"absolute", left:TIME_W-4, top:-3, width:8, height:8, borderRadius:"50%", background:"var(--crit)" }} />
          </div>
        )}
      </div>

      {tooltip && (
        <div style={{ position:"fixed", left:tooltip.x+12, top:tooltip.y-10, background:"var(--surface)", border:"1px solid var(--line)", borderRadius:8, padding:"8px 10px", zIndex:999, pointerEvents:"none", boxShadow:"0 4px 16px rgba(0,0,0,0.15)", minWidth:140, maxWidth:220 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
            <div style={{ width:8, height:8, borderRadius:2, background:evtColor(tooltip.ev.id), flexShrink:0 }} />
            <div style={{ fontSize:11, fontWeight:800, color:"var(--ink)" }}>{tooltip.ev.title}</div>
          </div>
          <div style={{ fontSize:10, color:"var(--muted)", fontVariantNumeric:"tabular-nums", marginBottom:2 }}>
            {new Date(tooltip.ev.startMs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
            {" – "}
            {new Date(tooltip.ev.endMs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
          </div>
          <div style={{ fontSize:10, color:"var(--muted)" }}>{tooltip.ev.nodes || "—"}</div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ScheduleGantt, EVT_PALETTE, evtColor });
