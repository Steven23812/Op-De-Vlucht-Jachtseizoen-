import { useState, useEffect, useRef, useCallback } from "react";
import { readParty, writeParty, subscribeParty } from "./firebase";

// ─── utils ───────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, "0");
const fmt = s => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
const randCode = () => Math.random().toString(36).substring(2, 7).toUpperCase();
const mapsUrl = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

// ─── GPS ─────────────────────────────────────────────────────────────────────
function getGPS() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej("GPS niet beschikbaar op dit apparaat");
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      e => {
        if (e.code === 1) rej("Locatietoegang geweigerd – sta dit toe in je browserinstellingen");
        else if (e.code === 2) rej("Locatie niet beschikbaar – controleer je GPS");
        else rej("GPS timeout – probeer opnieuw");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// ─── screens ─────────────────────────────────────────────────────────────────
const S = { home: 0, create: 1, join: 2, lobby: 3, game: 4, ended: 5 };

export default function App() {
  const [screen, setScreen] = useState(S.home);
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [party, setParty] = useState(null);
  const [myId] = useState(() => Math.random().toString(36).slice(2));
  const [myRole, setMyRole] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [err, setErr] = useState("");
  const [gpsStatus, setGpsStatus] = useState("idle");
  const [gpsErr, setGpsErr] = useState("");
  const [countdown, setCountdown] = useState(null);
  const [totalLeft, setTotalLeft] = useState(null);
  const [pulseAnim, setPulseAnim] = useState(0);
  const [settings, setSettings] = useState({ interval: 5, duration: 60 });

  const countRef = useRef(null);
  const totalRef = useRef(null);
  const unsubRef = useRef(null);
  const screenRef = useRef(screen);
  const myRoleRef = useRef(myRole);
  const partyCodeRef = useRef(null);
  screenRef.current = screen;
  myRoleRef.current = myRole;

  // ─── realtime subscription ─────────────────────────────────────────────────
  const subscribeToParty = useCallback((code) => {
    if (unsubRef.current) unsubRef.current();
    partyCodeRef.current = code;
    unsubRef.current = subscribeParty(code, (p) => {
      if (!p) return;
      setParty(p);

      // Game started
      if (p.status === "playing" && screenRef.current === S.lobby) {
        const me = p.members[myId];
        if (me) {
          setMyRole(me.role);
          setCountdown(p.settings.interval * 60);
          setTotalLeft(p.settings.duration * 60);
          setScreen(S.game);
        }
      }

      // Game ended
      if (p.status === "ended" && screenRef.current === S.game) {
        clearInterval(countRef.current);
        clearInterval(totalRef.current);
        setScreen(S.ended);
      }
    });
  }, [myId]);

  // ─── GPS push ──────────────────────────────────────────────────────────────
  const pushLocation = useCallback(async () => {
    setGpsStatus("getting");
    try {
      const loc = await getGPS();
      setGpsStatus("ok");
      setGpsErr("");
      setPulseAnim(k => k + 1);
      const code = partyCodeRef.current;
      const p = await readParty(code);
      if (!p) return;
      const newEntry = { ...loc, time: new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) };
      const history = [newEntry, ...(p.locationHistory || []).slice(0, 19)];
      await writeParty(code, { ...p, lastLocation: loc, locationHistory: history });
    } catch (e) {
      setGpsStatus("error");
      setGpsErr(String(e));
    }
  }, []);

  // ─── fugitive interval timer ───────────────────────────────────────────────
  useEffect(() => {
    if (screen !== S.game || myRole !== "fugitive") return;
    pushLocation();
    const intervalSec = party?.settings?.interval * 60 || settings.interval * 60;
    countRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { pushLocation(); return intervalSec; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(countRef.current);
  }, [screen, myRole]); // eslint-disable-line

  // ─── total game timer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (screen !== S.game) return;
    const hostNow = isHost;
    totalRef.current = setInterval(() => {
      setTotalLeft(t => {
        if (t <= 1) {
          clearInterval(totalRef.current);
          if (hostNow) endGame();
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(totalRef.current);
  }, [screen]); // eslint-disable-line

  // ─── cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (unsubRef.current) unsubRef.current();
      clearInterval(countRef.current);
      clearInterval(totalRef.current);
    };
  }, []);

  // ─── actions ───────────────────────────────────────────────────────────────
  async function createParty() {
    if (!name.trim()) return setErr("Voer een naam in");
    const code = randCode();
    const p = {
      code, status: "lobby", settings,
      host: myId,
      members: { [myId]: { name: name.trim(), role: null } },
      lastLocation: null,
      locationHistory: [],
      createdAt: Date.now(),
    };
    await writeParty(code, p);
    setParty(p);
    setIsHost(true);
    setErr("");
    subscribeToParty(code);
    setScreen(S.lobby);
  }

  async function joinParty() {
    if (!name.trim()) return setErr("Voer een naam in");
    const code = joinCode.trim().toUpperCase();
    if (!code) return setErr("Voer een partycode in");
    const p = await readParty(code);
    if (!p) return setErr("Party niet gevonden – controleer de code");
    if (p.status !== "lobby") return setErr("Spel is al begonnen");
    const updated = { ...p, members: { ...p.members, [myId]: { name: name.trim(), role: null } } };
    await writeParty(code, updated);
    setParty(updated);
    setIsHost(false);
    setErr("");
    subscribeToParty(code);
    setScreen(S.lobby);
  }

  async function assignRole(memberId, role) {
    const code = partyCodeRef.current;
    const p = await readParty(code);
    const updatedMembers = { ...p.members };
    // Remove fugitive from others if assigning fugitive
    if (role === "fugitive") {
      Object.keys(updatedMembers).forEach(k => {
        if (updatedMembers[k].role === "fugitive") updatedMembers[k] = { ...updatedMembers[k], role: null };
      });
    }
    updatedMembers[memberId] = { ...updatedMembers[memberId], role };
    await writeParty(code, { ...p, members: updatedMembers });
  }

  async function startGame() {
    const code = partyCodeRef.current;
    const p = await readParty(code);
    const members = Object.values(p.members);
    if (!members.some(m => m.role === "fugitive")) return setErr("Wijs een vluchteling aan!");
    if (!members.some(m => m.role === "chaser")) return setErr("Er moet minstens één agent zijn!");
    await writeParty(code, { ...p, status: "playing", startedAt: Date.now() });
  }

  async function endGame() {
    const code = partyCodeRef.current;
    const p = await readParty(code);
    if (!p) return;
    await writeParty(code, { ...p, status: "ended" });
    setScreen(S.ended);
  }

  function reset() {
    if (unsubRef.current) unsubRef.current();
    clearInterval(countRef.current);
    clearInterval(totalRef.current);
    partyCodeRef.current = null;
    setParty(null); setMyRole(null); setIsHost(false);
    setCountdown(null); setTotalLeft(null);
    setGpsStatus("idle"); setGpsErr(""); setErr("");
    setName(""); setJoinCode("");
    setScreen(S.home);
  }

  // ─── derived state ─────────────────────────────────────────────────────────
  const loc = party?.lastLocation;
  const membersList = party?.members ? Object.entries(party.members).map(([id, m]) => ({ id, ...m })) : [];
  const intervalSec = (party?.settings?.interval || settings.interval) * 60;
  const durationSec = (party?.settings?.duration || settings.duration) * 60;
  const intervalPct = countdown != null ? 1 - countdown / intervalSec : 0;
  const totalPct = totalLeft != null ? 1 - totalLeft / durationSec : 0;
  const fugitiveName = membersList.find(m => m.role === "fugitive")?.name || "?";

  return (
    <div style={{
      fontFamily: "'Bebas Neue', Impact, sans-serif",
      minHeight: "100dvh", maxWidth: 430, margin: "0 auto",
      background:
        myRole === "fugitive" ? "radial-gradient(ellipse at top,#1a0000 0%,#070000 100%)" :
          myRole === "chaser" ? "radial-gradient(ellipse at top,#00040f 0%,#000408 100%)" :
            "#0b0b0b",
      color: "#fff", overflowX: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@300;400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
        ::-webkit-scrollbar{width:0}
        @keyframes pulse-ring{0%{transform:scale(1);opacity:.9}100%{transform:scale(2.8);opacity:0}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.15}}
        @keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
        @keyframes scanline{0%{top:-4px}100%{top:100%}}
        .su{animation:slideUp .35s ease both}
        .btn{border:none;cursor:pointer;font-family:'Bebas Neue',sans-serif;letter-spacing:2px;transition:all .15s}
        .btn:active{transform:scale(.95);opacity:.85}
        input{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:17px;padding:12px 14px;width:100%;outline:none;letter-spacing:.5px}
        input:focus{border-color:rgba(255,255,255,.3)}
        input::placeholder{color:#3a3a3a}
        .card{border-radius:14px}
        .scanline-bar{position:fixed;left:0;right:0;height:2px;background:rgba(255,255,255,.02);animation:scanline 5s linear infinite;pointer-events:none;z-index:999}
      `}</style>
      <div className="scanline-bar" />

      {/* ══ HOME ══ */}
      {screen === S.home && (
        <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px" }}>
          <div className="su" style={{ textAlign: "center", marginBottom: 44 }}>
            <div style={{ fontSize: 11, letterSpacing: 6, color: "#333", fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 8 }}>STUKTV STIJL</div>
            <div style={{ fontSize: 82, lineHeight: .92, background: "linear-gradient(135deg,#ff1500,#ff7700)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>OP DE</div>
            <div style={{ fontSize: 82, lineHeight: .92, marginBottom: 18 }}>VLUCHT</div>
            <div style={{ display: "inline-flex", gap: 10 }}>
              <div style={{ width: 28, height: 3, background: "#ff2200", borderRadius: 2 }} />
              <div style={{ width: 8, height: 3, background: "#333", borderRadius: 2 }} />
              <div style={{ width: 8, height: 3, background: "#333", borderRadius: 2 }} />
            </div>
          </div>
          <div className="su" style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12, animationDelay: ".1s" }}>
            <div>
              <div style={{ fontSize: 11, color: "#444", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 8 }}>JOUW NAAM</div>
              <input value={name} onChange={e => { setName(e.target.value); setErr(""); }} placeholder="bijv. Enzo" maxLength={16} />
            </div>
            {err && <div style={{ color: "#ff4422", fontSize: 13, fontFamily: "'Barlow Condensed',sans-serif", textAlign: "center" }}>{err}</div>}
            <button className="btn" onClick={() => { if (!name.trim()) return setErr("Voer eerst een naam in"); setErr(""); setScreen(S.create); }} style={{ padding: "18px 0", borderRadius: 12, fontSize: 22, background: "linear-gradient(135deg,#bb0000,#ff3300)", color: "#fff", width: "100%", boxShadow: "0 0 28px rgba(255,30,0,.2)" }}>
              🏃 PARTY AANMAKEN
            </button>
            <button className="btn" onClick={() => { if (!name.trim()) return setErr("Voer eerst een naam in"); setErr(""); setScreen(S.join); }} style={{ padding: "18px 0", borderRadius: 12, fontSize: 22, background: "linear-gradient(135deg,#002299,#0055ff)", color: "#fff", width: "100%", boxShadow: "0 0 28px rgba(0,80,255,.15)" }}>
              🚔 PARTY JOINEN
            </button>
          </div>
        </div>
      )}

      {/* ══ CREATE ══ */}
      {screen === S.create && (
        <div style={{ padding: "32px 20px 40px", minHeight: "100dvh" }}>
          <button className="btn" onClick={() => setScreen(S.home)} style={{ color: "#444", fontSize: 14, background: "none", fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 24, letterSpacing: 1 }}>← TERUG</button>
          <div style={{ fontSize: 38, letterSpacing: 3, marginBottom: 4 }}>INSTELLINGEN</div>
          <div style={{ width: 36, height: 3, background: "#ff3300", borderRadius: 2, marginBottom: 28 }} />
          <SettingRow label="Locatie-interval" value={settings.interval} unit="min" options={[1,2,3,5,8,10,15,20]} onChange={v => setSettings(s => ({ ...s, interval: v }))} accent="#ff3300" />
          <div style={{ height: 14 }} />
          <SettingRow label="Speelduur" value={settings.duration} unit="min" options={[15,30,45,60,90,120]} onChange={v => setSettings(s => ({ ...s, duration: v }))} accent="#ff3300" />
          <div style={{ height: 32 }} />
          {err && <div style={{ color: "#ff4422", fontSize: 13, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 12, textAlign: "center" }}>{err}</div>}
          <button className="btn" onClick={createParty} style={{ width: "100%", padding: "18px 0", borderRadius: 12, fontSize: 22, background: "linear-gradient(135deg,#bb0000,#ff3300)", color: "#fff" }}>
            PARTY AANMAKEN →
          </button>
        </div>
      )}

      {/* ══ JOIN ══ */}
      {screen === S.join && (
        <div style={{ padding: "32px 20px 40px", minHeight: "100dvh" }}>
          <button className="btn" onClick={() => setScreen(S.home)} style={{ color: "#444", fontSize: 14, background: "none", fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 24, letterSpacing: 1 }}>← TERUG</button>
          <div style={{ fontSize: 38, letterSpacing: 3, marginBottom: 4 }}>JOINEN</div>
          <div style={{ width: 36, height: 3, background: "#0055ff", borderRadius: 2, marginBottom: 28 }} />
          <div style={{ fontSize: 11, color: "#444", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 8 }}>PARTYCODE</div>
          <input value={joinCode} onChange={e => { setJoinCode(e.target.value.toUpperCase()); setErr(""); }} placeholder="bijv. XK3P2" maxLength={10} style={{ fontSize: 32, textAlign: "center", letterSpacing: 8, marginBottom: 20 }} />
          {err && <div style={{ color: "#ff4422", fontSize: 13, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 12, textAlign: "center" }}>{err}</div>}
          <button className="btn" onClick={joinParty} style={{ width: "100%", padding: "18px 0", borderRadius: 12, fontSize: 22, background: "linear-gradient(135deg,#002299,#0055ff)", color: "#fff" }}>
            JOINEN →
          </button>
        </div>
      )}

      {/* ══ LOBBY ══ */}
      {screen === S.lobby && party && (
        <div style={{ padding: "28px 20px 40px", minHeight: "100dvh" }}>
          <div className="su card" style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.09)", padding: "18px 20px", marginBottom: 22, textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#444", letterSpacing: 4, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 4 }}>PARTYCODE — DEEL MET VRIENDEN</div>
            <div style={{ fontSize: 58, letterSpacing: 10, color: "#ff3300", lineHeight: 1 }}>{party.code}</div>
            <div style={{ fontSize: 12, color: "#2a2a2a", fontFamily: "'Barlow Condensed',sans-serif", marginTop: 6 }}>
              {party.settings.interval} min interval · {party.settings.duration} min speelduur
            </div>
          </div>

          <div style={{ fontSize: 11, color: "#333", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 10 }}>
            SPELERS ({membersList.length})
          </div>

          {membersList.map(m => (
            <div key={m.id} className="card" style={{ background: "rgba(255,255,255,.04)", border: `1px solid ${m.role === "fugitive" ? "rgba(255,50,0,.35)" : m.role === "chaser" ? "rgba(0,100,255,.3)" : "rgba(255,255,255,.07)"}`, padding: "12px 14px", marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 26 }}>{m.role === "fugitive" ? "🏃" : m.role === "chaser" ? "🚔" : "👤"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 18, letterSpacing: 1 }}>
                  {m.name}
                  {m.id === myId && <span style={{ fontSize: 11, color: "#444", fontFamily: "'Barlow Condensed',sans-serif", marginLeft: 6 }}>(jij)</span>}
                </div>
                <div style={{ fontSize: 12, fontFamily: "'Barlow Condensed',sans-serif", letterSpacing: 1, marginTop: 1, color: m.role === "fugitive" ? "#ff4422" : m.role === "chaser" ? "#3399ff" : "#333" }}>
                  {m.role === "fugitive" ? "VLUCHTELING" : m.role === "chaser" ? "AGENT" : "GEEN ROL"}
                </div>
              </div>
              {isHost && (
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn" onClick={() => assignRole(m.id, "fugitive")} style={{ padding: "6px 10px", borderRadius: 8, fontSize: 13, background: m.role === "fugitive" ? "rgba(200,0,0,.5)" : "rgba(255,255,255,.08)", color: "#fff", border: m.role === "fugitive" ? "1px solid rgba(255,50,0,.5)" : "1px solid transparent" }}>🏃</button>
                  <button className="btn" onClick={() => assignRole(m.id, "chaser")} style={{ padding: "6px 10px", borderRadius: 8, fontSize: 13, background: m.role === "chaser" ? "rgba(0,50,200,.5)" : "rgba(255,255,255,.08)", color: "#fff", border: m.role === "chaser" ? "1px solid rgba(0,100,255,.5)" : "1px solid transparent" }}>🚔</button>
                </div>
              )}
            </div>
          ))}

          {err && <div style={{ color: "#ff4422", fontSize: 13, fontFamily: "'Barlow Condensed',sans-serif", margin: "10px 0", textAlign: "center" }}>{err}</div>}

          {isHost ? (
            <button className="btn" onClick={startGame} style={{ width: "100%", padding: "18px 0", borderRadius: 12, fontSize: 22, color: "#fff", marginTop: 16, background: membersList.some(m => m.role === "fugitive") && membersList.some(m => m.role === "chaser") ? "linear-gradient(135deg,#bb0000,#ff3300)" : "rgba(255,255,255,.07)" }}>
              🚀 SPEL STARTEN
            </button>
          ) : (
            <div style={{ marginTop: 24, textAlign: "center", color: "#333", fontSize: 16, fontFamily: "'Barlow Condensed',sans-serif", letterSpacing: 2, animation: "blink 2s infinite" }}>
              WACHTEN OP HOST OM TE STARTEN...
            </div>
          )}
          <button className="btn" onClick={reset} style={{ width: "100%", padding: "12px 0", borderRadius: 10, fontSize: 15, background: "none", color: "#2a2a2a", marginTop: 10, border: "1px solid rgba(255,255,255,.06)" }}>VERLATEN</button>
        </div>
      )}

      {/* ══ GAME – VLUCHTELING ══ */}
      {screen === S.game && myRole === "fugitive" && (
        <div style={{ padding: "24px 20px 40px", minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: "#ff4422", letterSpacing: 4, fontFamily: "'Barlow Condensed',sans-serif" }}>JIJ BENT</div>
              <div style={{ fontSize: 30, color: "#ff2200", letterSpacing: 3 }}>VLUCHTELING 🏃</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#333", letterSpacing: 2, fontFamily: "'Barlow Condensed',sans-serif" }}>RESTERENDE TIJD</div>
              <div style={{ fontSize: 30, animation: totalLeft < 120 ? "blink .6s infinite" : "none", color: totalLeft < 120 ? "#ff2200" : "#fff" }}>
                {totalLeft != null ? fmt(totalLeft) : "--:--"}
              </div>
            </div>
          </div>

          <div style={{ height: 3, background: "#150000", borderRadius: 2, marginBottom: 18, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${totalPct * 100}%`, background: "linear-gradient(90deg,#ff2200,#ff6600)", transition: "width 1s linear", borderRadius: 2 }} />
          </div>

          {/* Countdown ring */}
          <div style={{ textAlign: "center", position: "relative", marginBottom: 18 }}>
            <div key={pulseAnim} style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 172, height: 172, borderRadius: "50%", border: "2px solid #ff2200", animation: "pulse-ring .9s ease-out forwards", pointerEvents: "none" }} />
            <div style={{ width: 172, height: 172, borderRadius: "50%", background: "rgba(160,0,0,.07)", border: "3px solid rgba(255,30,0,.15)", display: "inline-flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative" }}>
              <svg style={{ position: "absolute", top: 0, left: 0, transform: "rotate(-90deg)" }} width="172" height="172">
                <circle cx="86" cy="86" r="80" fill="none" stroke="rgba(255,30,0,.08)" strokeWidth="5" />
                <circle cx="86" cy="86" r="80" fill="none" stroke="#ff2200" strokeWidth="5"
                  strokeDasharray={`${2 * Math.PI * 80}`}
                  strokeDashoffset={`${2 * Math.PI * 80 * (1 - intervalPct)}`}
                  strokeLinecap="round" style={{ transition: "stroke-dashoffset 1s linear" }} />
              </svg>
              <div style={{ fontSize: 10, color: "#882200", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif" }}>VOLGENDE UPDATE</div>
              <div style={{ fontSize: 52, lineHeight: 1.1, animation: countdown <= 10 ? "blink .4s infinite" : "none" }}>
                {countdown != null ? fmt(countdown) : "--:--"}
              </div>
              <div style={{ fontSize: 10, color: "#330800", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif" }}>LOCATIE</div>
            </div>
          </div>

          {/* GPS status */}
          <div className="card" style={{ background: "rgba(200,10,0,.06)", border: "1px solid rgba(255,30,0,.13)", padding: 14, marginBottom: 10 }}>
            {gpsStatus === "getting" && <div style={{ textAlign: "center", color: "#555", fontFamily: "'Barlow Condensed',sans-serif", fontSize: 15 }}>📡 GPS ophalen...</div>}
            {gpsStatus === "error" && <div style={{ color: "#ff5533", fontFamily: "'Barlow Condensed',sans-serif", fontSize: 13, lineHeight: 1.5 }}>⚠️ {gpsErr}<br /><span style={{ color: "#553322", fontSize: 11 }}>Sta locatietoegang toe in je browserinstellingen.</span></div>}
            {gpsStatus === "ok" && loc && (
              <>
                <div style={{ fontSize: 10, color: "#ff4422", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 5 }}>LOCATIE GEDEELD ✓</div>
                <div style={{ fontSize: 15, fontFamily: "'Barlow Condensed',sans-serif", color: "#bbb" }}>{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}</div>
                <div style={{ fontSize: 11, color: "#3a2a2a", fontFamily: "'Barlow Condensed',sans-serif", marginTop: 2 }}>±{loc.acc}m nauwkeurigheid</div>
              </>
            )}
            {gpsStatus === "idle" && <div style={{ color: "#333", textAlign: "center", fontFamily: "'Barlow Condensed',sans-serif", fontSize: 14 }}>Wachten op GPS...</div>}
          </div>

          <button className="btn" onClick={pushLocation} style={{ width: "100%", padding: "13px 0", borderRadius: 10, fontSize: 18, background: "rgba(255,40,0,.12)", color: "#ff4422", border: "1px solid rgba(255,40,0,.2)", marginBottom: 10 }}>
            📍 NU LOCATIE STUREN
          </button>

          {loc && (
            <a href={mapsUrl(loc.lat, loc.lng)} target="_blank" rel="noreferrer" style={{ display: "block", textAlign: "center", padding: "12px 0", background: "rgba(255,255,255,.05)", borderRadius: 10, fontSize: 16, color: "#555", textDecoration: "none", marginBottom: 10, fontFamily: "'Bebas Neue',sans-serif", letterSpacing: 2, border: "1px solid rgba(255,255,255,.06)" }}>
              🗺️ BEKIJK OP KAART
            </a>
          )}

          <div className="card" style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.05)", padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: "#2a2a2a", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 6 }}>AGENTEN OP JE HIELEN</div>
            {membersList.filter(m => m.role === "chaser").map(m => (
              <div key={m.id} style={{ fontSize: 14, color: "#444", fontFamily: "'Barlow Condensed',sans-serif", padding: "3px 0" }}>🚔 {m.name}</div>
            ))}
          </div>

          <button className="btn" onClick={reset} style={{ width: "100%", padding: "12px 0", borderRadius: 10, fontSize: 15, background: "none", color: "#222", border: "1px solid rgba(255,255,255,.05)", marginTop: "auto" }}>STOPPEN</button>
        </div>
      )}

      {/* ══ GAME – AGENT ══ */}
      {screen === S.game && myRole === "chaser" && (
        <div style={{ padding: "24px 20px 40px", minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: "#3399ff", letterSpacing: 4, fontFamily: "'Barlow Condensed',sans-serif" }}>JIJ BENT</div>
              <div style={{ fontSize: 30, color: "#0066ff", letterSpacing: 3 }}>AGENT 🚔</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#333", letterSpacing: 2, fontFamily: "'Barlow Condensed',sans-serif" }}>RESTERENDE TIJD</div>
              <div style={{ fontSize: 30, animation: totalLeft < 120 ? "blink .6s infinite" : "none", color: totalLeft < 120 ? "#3399ff" : "#fff" }}>
                {totalLeft != null ? fmt(totalLeft) : "--:--"}
              </div>
            </div>
          </div>

          <div style={{ height: 3, background: "#00030a", borderRadius: 2, marginBottom: 18, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${totalPct * 100}%`, background: "linear-gradient(90deg,#002299,#0088ff)", transition: "width 1s linear", borderRadius: 2 }} />
          </div>

          <div className="card" style={{ background: "rgba(0,80,255,.06)", border: "1px solid rgba(0,100,255,.18)", padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#224488", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 8 }}>VLUCHTELING: {fugitiveName}</div>
            {loc ? (
              <>
                <div style={{ fontSize: 10, color: "#3366aa", letterSpacing: 2, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 6 }}>
                  LAATSTE LOCATIE — {party?.locationHistory?.[0]?.time || ""}
                </div>
                <div style={{ fontSize: 17, fontFamily: "'Barlow Condensed',sans-serif", color: "#bbb", marginBottom: 12 }}>
                  {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
                </div>
                <a href={mapsUrl(loc.lat, loc.lng)} target="_blank" rel="noreferrer" style={{ display: "block", textAlign: "center", padding: "13px 0", background: "linear-gradient(135deg,#002299,#0055ff)", borderRadius: 10, fontSize: 19, letterSpacing: 2, color: "#fff", textDecoration: "none", fontFamily: "'Bebas Neue',sans-serif" }}>
                  🗺️ OPEN IN GOOGLE MAPS
                </a>
              </>
            ) : (
              <div style={{ textAlign: "center", color: "#112244", fontSize: 15, fontFamily: "'Barlow Condensed',sans-serif", padding: "14px 0", animation: "blink 1.5s infinite" }}>
                📡 Wachten op eerste locatie van vluchteling...
              </div>
            )}
          </div>

          {party?.locationHistory?.length > 1 && (
            <div className="card" style={{ background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.05)", padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "#222", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 8 }}>LOCATIEGESCHIEDENIS</div>
              {(party.locationHistory || []).slice(0, 6).map((h, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,.04)", fontSize: 13, fontFamily: "'Barlow Condensed',sans-serif" }}>
                  <a href={mapsUrl(h.lat, h.lng)} target="_blank" rel="noreferrer" style={{ color: i === 0 ? "#3399ff" : "#333", textDecoration: "none" }}>
                    {h.lat.toFixed(4)}, {h.lng.toFixed(4)} ↗
                  </a>
                  <span style={{ color: "#222" }}>{h.time}</span>
                </div>
              ))}
            </div>
          )}

          <div className="card" style={{ background: "rgba(0,40,140,.05)", border: "1px solid rgba(0,80,255,.1)", padding: 14, marginBottom: 14, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#112244", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 2 }}>VOLGENDE LOCATIE VERWACHT OVER ±</div>
            <div style={{ fontSize: 44, color: "#0066ff" }}>{countdown != null ? fmt(countdown) : fmt((party?.settings?.interval || 5) * 60)}</div>
          </div>

          {isHost && (
            <button className="btn" onClick={endGame} style={{ width: "100%", padding: "16px 0", borderRadius: 12, fontSize: 22, background: "linear-gradient(135deg,#aa5500,#ff8800)", color: "#fff", marginBottom: 10 }}>
              🎯 VLUCHTELING GEPAKT!
            </button>
          )}

          <button className="btn" onClick={reset} style={{ width: "100%", padding: "12px 0", borderRadius: 10, fontSize: 15, background: "none", color: "#222", border: "1px solid rgba(255,255,255,.05)", marginTop: "auto" }}>STOPPEN</button>
        </div>
      )}

      {/* ══ ENDED ══ */}
      {screen === S.ended && (
        <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 80, marginBottom: 16 }}>🎯</div>
          <div style={{ fontSize: 60, color: "#ff8800", letterSpacing: 4, lineHeight: 1 }}>GEPAKT!</div>
          <div style={{ fontSize: 18, color: "#444", letterSpacing: 2, margin: "14px 0 44px", fontFamily: "'Barlow Condensed',sans-serif", lineHeight: 1.6 }}>
            {myRole === "fugitive" ? "De agenten hebben je gevonden!" : "Jullie hebben de vluchteling gepakt!"}
          </div>
          <button className="btn" onClick={reset} style={{ width: "100%", padding: "18px 0", borderRadius: 12, fontSize: 22, background: "linear-gradient(135deg,#bb0000,#ff3300)", color: "#fff" }}>
            🔄 OPNIEUW SPELEN
          </button>
        </div>
      )}
    </div>
  );
}

function SettingRow({ label, value, unit, options, onChange, accent }) {
  return (
    <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: "#444", letterSpacing: 3, fontFamily: "'Barlow Condensed',sans-serif", marginBottom: 10 }}>{label.toUpperCase()}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {options.map(o => (
          <button key={o} onClick={() => onChange(o)} style={{ padding: "7px 12px", borderRadius: 8, border: "none", cursor: "pointer", fontFamily: "'Bebas Neue',sans-serif", fontSize: 16, letterSpacing: 1.5, background: value === o ? accent : "rgba(255,255,255,.07)", color: value === o ? "#fff" : "#444", boxShadow: value === o ? `0 0 12px ${accent}44` : "none", transition: "all .15s" }}>
            {o} {unit}
          </button>
        ))}
      </div>
    </div>
  );
}
