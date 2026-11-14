// Directory page: every LDAP user and group, read-only, from /api/ldap.
// Clicking a group or member chip filters both lists to it.

const { useState, useEffect, useMemo } = React;

const DIR_POLL_MS = 30000;

// Placeholders only: no handler, no API behind them yet.
const DIR_ACTIONS = [
  [
    { key: "create-user", label: "Create user", icon: "userPlus" },
    { key: "delete-user", label: "Delete user", icon: "userMinus", danger: true },
  ],
  [
    { key: "create-group", label: "Create group", icon: "groupPlus" },
    { key: "add-to-group", label: "Add user to group", icon: "link" },
    { key: "delete-group", label: "Delete group", icon: "trash", danger: true },
  ],
];

// Theme colors an avatar may take; picked by a stable hash of the name.
const AVATAR_COLORS = ["var(--ink-2)", "var(--info)", "var(--mem)", "var(--swap)", "var(--ok)", "var(--crit)", "var(--warn)"];
function avatarColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const ICONS = {
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
  group: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  user: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
  server: <><rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/></>,
  search: <><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>,
  userPlus: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></>,
  userMinus: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" y1="11" x2="16" y2="11"/></>,
  groupPlus: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><line x1="17.5" y1="14" x2="17.5" y2="21"/><line x1="14" y1="17.5" x2="21" y2="17.5"/></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
  trash: <><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></>,
};
function Icon({ name, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>
  );
}

function Avatar({ name, small }) {
  return (
    <span className={`dir-avatar ${small ? "sm" : ""}`} style={{ "--av": avatarColor(name) }}>
      {String(name).slice(0, 2)}
    </span>
  );
}

function Stat({ icon, label, value, small }) {
  return (
    <div className="dir-stat">
      <div className="dir-stat-icon"><Icon name={icon} size={18} /></div>
      <div className="dir-stat-body">
        <div className="dir-stat-label">{label}</div>
        <div className={`dir-stat-value ${small ? "small" : ""}`} title={typeof value === "string" ? value : undefined}>{value}</div>
      </div>
    </div>
  );
}

function SkeletonRows({ cols, rows = 5 }) {
  return Array.from({ length: rows }, (_, i) => (
    <tr key={i}>{Array.from({ length: cols }, (_, j) => (
      <td key={j}><div className="dir-skel" style={{ width: `${40 + ((i * 7 + j * 13) % 50)}%` }} /></td>
    ))}</tr>
  ));
}

function DirectoryPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [me, setMe] = useState(null);
  useEffect(() => { window.cockpitAuth.me().then(setMe); }, []);

  useEffect(() => {
    const cached = readCachedSettings();
    if (cached && cached.theme) document.documentElement.dataset.theme = cached.theme;
    loadSettings().then((s) => { if (s && s.theme) document.documentElement.dataset.theme = s.theme; });
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/ldap", { cache: "no-store" });
        const type = r.headers.get("content-type") || "";
        if (!type.includes("json")) throw new Error(`HTTP ${r.status} (the cockpit server may need a restart)`);
        const body = await r.json();
        if (!alive) return;
        if (!r.ok || body.error) throw new Error(body.error || `HTTP ${r.status}`);
        setData(body);
        setError(null);
      } catch (e) {
        if (alive) setError(String(e.message || e));
      }
    };
    tick();
    const h = setInterval(tick, DIR_POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, []);

  const users = (data && data.users) || [];
  const groups = (data && data.groups) || [];
  const myUid = me && me.user;
  const myEntry = users.find((u) => u.uid === myUid);

  const q = query.trim().toLowerCase();
  const shownUsers = useMemo(() => !q ? users : users.filter((u) =>
    [u.uid, u.name, u.home, u.shell, u.mail, u.primaryGroup, String(u.uidNumber), ...u.groups]
      .some((v) => v && String(v).toLowerCase().includes(q))), [users, q]);
  const shownGroups = useMemo(() => !q ? groups : groups.filter((g) =>
    [g.cn, g.description, String(g.gid), ...g.members, ...g.primaryMembers]
      .some((v) => v && String(v).toLowerCase().includes(q))), [groups, q]);

  const groupTag = (name, primary) => (
    <button key={name} className={`dir-tag ${primary ? "primary" : ""}`} onClick={() => setQuery(name)}
            title={primary ? `Primary group ${name} — click to filter` : `${name} — click to filter`}>
      {name}
    </button>
  );

  return (
    <div className="dir">
      <header className="dir-top">
        <a className="dir-back" href="index.html">← Cockpit</a>
        <div className="dir-heading">
          <div className="dir-title">Users &amp; groups</div>
        </div>
        <div className="dir-spacer" />
        <span className={`dir-live ${error ? "err" : ""}`}
              title={error || (data ? `Fetched ${new Date(data.fetched_ms).toLocaleTimeString()}, refreshes every 30 s` : "")}>
          <span className="dir-live-dot" />
          {error ? "query failed" : data ? `updated ${new Date(data.fetched_ms).toLocaleTimeString()}` : "loading…"}
        </span>
        <cockpitWatchdog.Button />
        <cockpitAuth.LogoutButton />
      </header>

      {error && (
        <div className="dir-error">
          <div>
            <strong>Could not read the LDAP directory.</strong>{" "}
            <code>{error}</code>
            {data && <div className="dir-sub" style={{ marginTop: 4 }}>Showing the last successful result.</div>}
          </div>
        </div>
      )}

      <section className="dir-stats">
        <Stat icon="users" label="Users" value={data ? users.length : "–"} />
        <Stat icon="group" label="Groups" value={data ? groups.length : "–"} />
        <Stat icon="user" label="Signed in as" small
              value={myUid ? `${myUid}${myEntry ? ` · uid ${myEntry.uidNumber}` : ""}` : "–"} />
        <Stat icon="server" label="LDAP server" small value={data ? data.uri : "–"} />
      </section>

      <section className="dir-toolbar">
        <label className="dir-search">
          <Icon name="search" size={15} />
          <input type="search" placeholder="Search users, groups, home, shell…" aria-label="Filter users and groups"
                 value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="dir-search-clear" onClick={() => setQuery("")} aria-label="Clear filter">×</button>}
        </label>
        <div className="dir-spacer" />
        <div className="dir-actions">
          {DIR_ACTIONS.map((group, gi) => (
            <React.Fragment key={gi}>
              {gi > 0 && <span className="dir-actions-sep" />}
              {group.map((a) => (
                <button key={a.key} className={`dir-action ${a.danger ? "danger" : ""}`} disabled
                        title={`${a.label}: not implemented yet`}>
                  <Icon name={a.icon} size={14} />{a.label}<span className="dir-soon">soon</span>
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>
      </section>

      <div className="dir-body">
        <section className="dir-card">
          <div className="dir-card-head">
            <h2>Users</h2>
            <span className="dir-count">{q && data ? `${shownUsers.length} / ${users.length}` : users.length}</span>
          </div>
          <div className="dir-wrap">
            <table className="dir-table">
              <thead>
                <tr>
                  <th>User</th><th className="num">UID</th><th className="num">GID</th>
                  <th>Groups</th><th>Home</th><th>Shell</th>
                </tr>
              </thead>
              <tbody>
                {!data && !error && <SkeletonRows cols={6} />}
                {data && shownUsers.length === 0 && (
                  <tr><td colSpan={6} className="dir-empty">No users match “{query}”.</td></tr>
                )}
                {shownUsers.map((u) => (
                  <tr key={u.uid}>
                    <td>
                      <div className="dir-who">
                        <Avatar name={u.uid} />
                        <div className="dir-who-text">
                          <span className="dir-who-uid">{u.uid}{u.uid === myUid && <span className="dir-you">you</span>}</span>
                          {(u.name && u.name !== u.uid || u.mail) && (
                            <span className="dir-who-name">{[u.name !== u.uid && u.name, u.mail].filter(Boolean).join(" · ")}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="num">{u.uidNumber ?? "–"}</td>
                    <td className="num">{u.gid ?? "–"}</td>
                    <td>
                      {u.primaryGroup && groupTag(u.primaryGroup, true)}
                      {u.groups.filter((g) => g !== u.primaryGroup).map((g) => groupTag(g, false))}
                    </td>
                    <td className="mono">{u.home}</td>
                    <td className="mono">{u.shell}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dir-card">
          <div className="dir-card-head">
            <h2>Groups</h2>
            <span className="dir-count">{q && data ? `${shownGroups.length} / ${groups.length}` : groups.length}</span>
          </div>
          <div className="dir-groups">
            {!data && !error && (
              <div className="dir-group"><div className="dir-skel" style={{ width: "60%" }} /></div>
            )}
            {data && shownGroups.length === 0 && (
              <div className="dir-empty">{q ? `No groups match “${query}”.` : "No groups in the directory."}</div>
            )}
            {shownGroups.map((g) => {
              const all = [...new Set([...g.primaryMembers, ...g.members])];
              return (
                <div key={g.cn} className="dir-group">
                  <div className="dir-group-head">
                    <span className="dir-group-icon" style={{ "--av": avatarColor(g.cn) }}><Icon name="group" size={15} /></span>
                    <div className="dir-group-text">
                      <span className="dir-group-name">{g.cn}</span>
                      <span className="dir-group-meta">
                        gid <code>{g.gid ?? "–"}</code> · {all.length} member{all.length === 1 ? "" : "s"}
                        {g.description && ` · ${g.description}`}
                      </span>
                    </div>
                  </div>
                  {all.length > 0 && (
                    <div className="dir-group-members">
                      {all.map((m) => (
                        <button key={m} className="dir-member" onClick={() => setQuery(m)}
                                title={`${m} — click to filter`}>
                          <Avatar name={m} small />{m}
                          {g.primaryMembers.includes(m) && <span className="dir-member-primary">primary</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<DirectoryPage />);
