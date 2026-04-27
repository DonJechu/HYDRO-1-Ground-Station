import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ComposedChart, Bar
} from 'recharts'
import './App.css'

// ── Constants ────────────────────────────────────────────────────────────────

const PHASES = {
  0: { label: 'STANDBY',  color: '#4ade80', short: 'SBY' },
  1: { label: 'ARMED',    color: '#facc15', short: 'ARM' },
  2: { label: 'IGNITION', color: '#fb923c', short: 'IGN' },
  3: { label: 'ASCENT',   color: '#38bdf8', short: 'ASC' },
  4: { label: 'APOGEE',   color: '#c084fc', short: 'APG' },
  5: { label: 'DESCENT',  color: '#f87171', short: 'DES' },
  6: { label: 'LANDING',  color: '#4ade80', short: 'LND' },
}

const ALERT_PHASES = new Set([2, 4])  // IGNITION, APOGEE trigger audio

const MAX_HIST    = 600   // 1 min @ 10 Hz
const NOISE_WIN   = 20    // samples for rolling std-dev
const STORAGE_KEY = 'hydro1_flight'

// ── Audio engine ─────────────────────────────────────────────────────────────
// Synthesized tones — no files needed

class AudioEngine {
  constructor() {
    this._ctx = null
  }
  _ensure() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)()
    return this._ctx
  }
  _beep(freq, dur, type = 'sine', gain = 0.4) {
    try {
      const ctx = this._ensure()
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.connect(env); env.connect(ctx.destination)
      osc.type = type; osc.frequency.value = freq
      env.gain.setValueAtTime(gain, ctx.currentTime)
      env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur)
    } catch {}
  }
  apogee() {
    // Rising tri-tone: apogee confirmed
    this._beep(880, 0.15, 'sine', 0.5)
    setTimeout(() => this._beep(1100, 0.15, 'sine', 0.5), 160)
    setTimeout(() => this._beep(1320, 0.3,  'sine', 0.5), 320)
  }
  ignition() {
    // Low rumble burst
    this._beep(80,  0.2, 'sawtooth', 0.3)
    setTimeout(() => this._beep(120, 0.3, 'sawtooth', 0.3), 50)
  }
  warning() {
    // Double beep
    this._beep(660, 0.1, 'square', 0.35)
    setTimeout(() => this._beep(660, 0.1, 'square', 0.35), 200)
  }
  landing() {
    this._beep(440, 0.12, 'sine', 0.4)
    setTimeout(() => this._beep(440, 0.12, 'sine', 0.4), 150)
    setTimeout(() => this._beep(550, 0.25, 'sine', 0.4), 300)
  }
}

const audio = new AudioEngine()

// ── Pre-computed demo flight ──────────────────────────────────────────────────

const DEMO = (() => {
  const f = []
  let t = 0, alt = 0, vel = 0
  const rnd = (v, n) => +v.toFixed(n)
  const push = (phase, o) => f.push({
    t, alt: rnd(alt, 1), vel: rnd(vel, 1),
    accel: 1, pitch: 0, roll: 0, yaw: 0,
    temp: 24, pressure: 1013, phase, ...o
  })
  for (let i = 0; i < 30; i++) { t += 100; push(0, { accel: rnd(1 + Math.random()*.04, 2) }) }
  for (let i = 0; i < 15; i++) { t += 100; push(1, { accel: 1 }) }
  for (let i = 0; i < 3;  i++) { t += 100; push(2, { accel: rnd(2.5 + i, 2) }) }
  for (let i = 0; i < 80; i++) {
    t += 100
    const p = i / 80
    vel = 18 * (1 - p * 1.15)
    alt = Math.max(0, alt + vel * 0.1)
    const g = p < 0.12 ? 5 - p*10 : Math.max(0.1, 1 - p*0.9)
    push(3, {
      accel: rnd(g, 2),
      pitch: rnd((Math.random()-.5)*3, 1),
      roll:  rnd((Math.random()-.5)*2, 1),
      temp:  rnd(24 - alt*.006, 1),
      pressure: rnd(1013 - alt*.12, 1)
    })
  }
  const peak = alt
  for (let i = 0; i < 8; i++) {
    t += 100; vel = 0
    push(4, { accel: .1, temp: 23, pressure: rnd(1013 - peak*.12, 1) })
  }
  for (let i = 0; i < 110; i++) {
    t += 100
    const p = i/110; alt = peak*(1-p); vel = -(peak/110)/.1
    push(5, {
      accel: rnd(.3 + Math.random()*.12, 2),
      pitch: rnd((Math.random()-.5)*6, 1),
      roll:  rnd((Math.random()-.5)*6, 1),
      temp:  rnd(24 - alt*.005, 1),
      pressure: rnd(1013 - Math.max(0, alt)*.12, 1)
    })
  }
  alt = 0; vel = 0
  for (let i = 0; i < 20; i++) {
    t += 100
    push(6, { accel: 1, pitch: rnd((Math.random()-.5)*1, 1), roll: rnd((Math.random()-.5)*1, 1) })
  }
  return f
})()

// ── Persistence helpers ───────────────────────────────────────────────────────

function saveSession(hist, maxAlt, log) {
  try {
    const payload = { ts: Date.now(), maxAlt, log: log.slice(-50), hist: hist.slice(-MAX_HIST) }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {}
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCSV(hist) {
  const headers = ['t_ms','alt_m','vel_ms','accel_G','pitch_deg','roll_deg','yaw_deg','temp_C','pressure_hPa','phase']
  const rows = hist.map(h =>
    [h.t, h.alt, h.vel, h.accel, h.pitch, h.roll, h.yaw ?? 0, h.temp, h.pressure, h.phase].join(',')
  )
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `hydro1_flight_${new Date().toISOString().replace(/[:.]/g, '-').slice(0,19)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Noise calculation — rolling std-dev of altitude ───────────────────────────
// Used for EMI analysis: higher std-dev = more sensor noise

function rollingStdDev(hist, window = NOISE_WIN) {
  if (hist.length < 3) return []
  return hist.map((h, i) => {
    const slice = hist.slice(Math.max(0, i - window + 1), i + 1)
    const mean  = slice.reduce((s, x) => s + x.alt, 0) / slice.length
    const variance = slice.reduce((s, x) => s + (x.alt - mean) ** 2, 0) / slice.length
    return { i, noise: +Math.sqrt(variance).toFixed(3) }
  })
}

// ── WebSocket hook ────────────────────────────────────────────────────────────

function useWebSocket(url, onMsg) {
  const ws    = useRef(null)
  const cbRef = useRef(onMsg)
  const timer = useRef(null)
  const [status, setStatus] = useState('disconnected')
  useEffect(() => { cbRef.current = onMsg }, [onMsg])

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return
    setStatus('connecting')
    try {
      ws.current = new WebSocket(url)
      ws.current.onopen    = () => { setStatus('connected'); clearTimeout(timer.current) }
      ws.current.onclose   = () => { setStatus('disconnected'); timer.current = setTimeout(connect, 3000) }
      ws.current.onerror   = () => setStatus('error')
      ws.current.onmessage = e  => { try { cbRef.current(JSON.parse(e.data)) } catch {} }
    } catch { setStatus('error') }
  }, [url])

  const disconnect = useCallback(() => {
    clearTimeout(timer.current)
    ws.current?.close(); ws.current = null
    setStatus('disconnected')
  }, [])

  return { status, connect, disconnect }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatRow({ label, value, unit, warn, danger, dec = 1 }) {
  const n = typeof value === 'number' ? value.toFixed(dec) : '--'
  const c = danger && Math.abs(value ?? 0) >= danger ? '#f87171'
          : warn   && Math.abs(value ?? 0) >= warn   ? '#facc15'
          : '#4ade80'
  return (
    <div className="stat-row">
      <span className="sr-label">{label}</span>
      <span className="sr-value" style={{ color: c }}>{n}</span>
      <span className="sr-unit">{unit}</span>
    </div>
  )
}

function PhaseBar({ current }) {
  return (
    <div className="phase-bar">
      {Object.entries(PHASES).map(([k, ph], i, arr) => {
        const id = +k; const active = id === current; const done = id < current
        return (
          <div key={k} className="pb-step">
            <div className="pb-node">
              <div className="pb-dot" style={{
                background:  active ? ph.color : done ? ph.color+'66' : 'transparent',
                borderColor: active ? ph.color : done ? ph.color+'44' : '#1f2f1f',
                boxShadow:   active ? `0 0 10px ${ph.color}88` : 'none',
              }}>
                {active && <div className="pb-ring" style={{ borderColor: ph.color }} />}
              </div>
              <span className="pb-label" style={{ color: active ? ph.color : done ? ph.color+'88' : '#2a3a2a' }}>
                {ph.short}
              </span>
            </div>
            {i < arr.length - 1 && (
              <div className="pb-line" style={{ background: done ? '#2a4a2a' : '#141f14' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function HorizonBall({ pitch, roll }) {
  const p = Math.max(-45, Math.min(45, pitch ?? 0))
  const r = Math.max(-90, Math.min(90, roll  ?? 0))
  const warn = Math.abs(p) > 25 || Math.abs(r) > 35
  return (
    <svg viewBox="0 0 130 130" style={{ width: '100%', maxWidth: 130, flexShrink: 0 }}>
      <defs><clipPath id="hc"><circle cx="65" cy="65" r="58" /></clipPath></defs>
      <circle cx="65" cy="65" r="59" fill="#030a03" stroke={warn ? '#f87171' : '#1a2a1a'} strokeWidth="1" />
      <g clipPath="url(#hc)">
        <g transform={`rotate(${-r} 65 65) translate(0,${p * 0.9})`}>
          <rect x="-20" y="-30" width="170" height="95"  fill="#071a2a" />
          <rect x="-20" y="65"  width="170" height="100" fill="#0c2010" />
          <line x1="-20" y1="65" x2="170" y2="65" stroke="#4ade8044" strokeWidth="1" />
          {[-30,-15,15,30].map(y => (
            <line key={y} x1="42" y1={65+y*.9} x2="88" y2={65+y*.9} stroke="#4ade8022" strokeWidth=".6" />
          ))}
        </g>
      </g>
      <line x1="10" y1="65" x2="44" y2="65" stroke="#4ade80" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="86" y1="65" x2="120" y2="65" stroke="#4ade80" strokeWidth="1.5" strokeLinecap="round" />
      <polygon points="65,56 60,67 70,67" fill="#4ade80" />
      <circle cx="65" cy="65" r="2.5" fill="#4ade80" />
      <circle cx="65" cy="65" r="59" fill="none" stroke={warn ? '#f87171' : '#4ade8022'} strokeWidth="1.5" />
    </svg>
  )
}

function GaugeArc({ value, max, label, color }) {
  const g   = value ?? 0
  const pct = Math.min(g / max, 1)
  const r   = 46, cx = 56, cy = 60
  const rad = a => a * Math.PI / 180
  const px  = a => cx + r * Math.cos(rad(a))
  const py  = a => cy + r * Math.sin(rad(a))
  const sA  = -215, sweep = 250, eA = sA + pct * sweep
  const la  = pct * sweep > 180 ? 1 : 0
  const c   = pct > .8 ? '#f87171' : pct > .5 ? '#facc15' : color
  const d   = pct > .01 ? `M${px(sA)} ${py(sA)} A${r} ${r} 0 ${la} 1 ${px(eA)} ${py(eA)}` : ''
  return (
    <svg viewBox="0 0 112 108" style={{ width: '100%', maxWidth: 112 }}>
      <path d={`M${px(sA)} ${py(sA)} A${r} ${r} 0 1 1 ${px(sA+sweep)} ${py(sA+sweep)}`}
        fill="none" stroke="#0d1f0d" strokeWidth="7" strokeLinecap="round" />
      {d && <path d={d} fill="none" stroke={c} strokeWidth="7" strokeLinecap="round" />}
      <text x={cx} y={cy+4}  textAnchor="middle" fill={c} fontSize="17" fontWeight="700" fontFamily="monospace">{g.toFixed(2)}</text>
      <text x={cx} y={cy+18} textAnchor="middle" fill="#4ade8055" fontSize="7"  fontFamily="monospace">{label}</text>
      <text x="8"  y="100" fill="#4ade8033" fontSize="6" fontFamily="monospace">0</text>
      <text x="88" y="100" fill="#4ade8033" fontSize="6" fontFamily="monospace">{max}</text>
    </svg>
  )
}

function AltBar({ alt, max }) {
  const pct = max > 0 ? Math.min(alt / max, 1) * 100 : 0
  return (
    <div className="alt-bar-outer">
      <div className="alt-bar-track">
        <div className="alt-bar-fill" style={{ height: `${pct}%` }} />
        {max > 0 && <div className="alt-bar-peak" />}
        {[75,50,25].map(p => (
          <div key={p} className="alt-grid-line" style={{ bottom: `${p}%` }} />
        ))}
      </div>
      <div className="alt-bar-ticks">
        <span>{max > 0 ? max.toFixed(0) : '--'}</span>
        <span>{max > 0 ? (max*.75).toFixed(0) : ''}</span>
        <span>{max > 0 ? (max*.5).toFixed(0) : ''}</span>
        <span>{max > 0 ? (max*.25).toFixed(0) : ''}</span>
        <span>0</span>
      </div>
    </div>
  )
}

const TT = (bg, stroke) => ({
  contentStyle: { background: bg, border: `1px solid ${stroke}`, fontFamily: 'monospace', fontSize: 10, padding: '3px 8px' },
  labelStyle:   { display: 'none' },
  itemStyle:    { color: stroke },
})

// ── Tabs for col-b ────────────────────────────────────────────────────────────

const CHART_TABS = ['VUELO', 'ORIENTACION', 'EMI / RUIDO']

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [wsUrl, setWsUrl]   = useState('ws://192.168.4.1:81')
  const [data, setData]     = useState(null)
  const [hist, setHist]     = useState([])
  const [maxAlt, setMaxAlt] = useState(0)
  const [log, setLog]       = useState([])
  const [demo, setDemo]     = useState(false)
  const [chartTab, setChartTab] = useState(0)
  const [muted, setMuted]   = useState(false)
  const [restored, setRestored] = useState(false)

  const prevPhase  = useRef(null)
  const demoTimer  = useRef(null)
  const saveTimer  = useRef(null)
  const mutedRef   = useRef(false)
  useEffect(() => { mutedRef.current = muted }, [muted])

  // ── Auto-save to localStorage every 2s ─────────────────────────────────────
  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      if (hist.length > 0) saveSession(hist, maxAlt, log)
    }, 2000)
    return () => clearTimeout(saveTimer.current)
  }, [hist, maxAlt, log])

  // ── Restore on mount ────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = loadSession()
    if (saved && saved.hist?.length > 0) {
      setHist(saved.hist)
      setMaxAlt(saved.maxAlt ?? 0)
      setLog(saved.log ?? [])
      setRestored(true)
      setTimeout(() => setRestored(false), 4000)
    }
  }, [])

  const pushLog = useCallback((msg, type = 'info') => {
    const ts = new Date().toISOString().substr(11, 11)
    setLog(l => [...l.slice(-299), { ts, msg, type }])
  }, [])

  const onMsg = useCallback((msg) => {
    setData(msg)
    setMaxAlt(p => Math.max(p, msg.alt ?? 0))
    setHist(h => {
      const n = [...h, msg]
      return n.length > MAX_HIST ? n.slice(-MAX_HIST) : n
    })

    // Phase transition — log + audio
    if (prevPhase.current !== null && prevPhase.current !== msg.phase) {
      const ph = PHASES[msg.phase]
      pushLog(`Fase → ${ph?.label ?? msg.phase}`, 'event')
      if (!mutedRef.current) {
        if (msg.phase === 2) audio.ignition()
        else if (msg.phase === 4) audio.apogee()
        else if (msg.phase === 6) audio.landing()
        else if (ALERT_PHASES.has(msg.phase)) audio.warning()
      }
    }
    prevPhase.current = msg.phase

    // Critical G warning
    if (!mutedRef.current && (msg.accel ?? 0) > 15 && prevPhase.current === 3) {
      audio.warning()
    }
  }, [pushLog])

  const { status, connect, disconnect } = useWebSocket(wsUrl, onMsg)

  useEffect(() => {
    if (status === 'connected')    pushLog('Conectado: ' + wsUrl, 'ok')
    if (status === 'disconnected') pushLog('Desconectado', 'warn')
    if (status === 'error')        pushLog('Error de conexion', 'error')
  }, [status]) // eslint-disable-line

  const startDemo = useCallback(() => {
    setDemo(true); setHist([]); setMaxAlt(0); setLog([])
    prevPhase.current = null
    clearSession()
    pushLog('Demo iniciado', 'info')
    let idx = 0
    demoTimer.current = setInterval(() => {
      if (idx >= DEMO.length) {
        clearInterval(demoTimer.current); setDemo(false)
        pushLog('Simulacion completada', 'ok'); return
      }
      onMsg(DEMO[idx++])
    }, 100)
  }, [onMsg, pushLog])

  const stopDemo = useCallback(() => {
    clearInterval(demoTimer.current); setDemo(false)
    pushLog('Demo detenido', 'warn')
  }, [pushLog])

  useEffect(() => () => { clearInterval(demoTimer.current); clearTimeout(saveTimer.current) }, [])

  const phase     = PHASES[data?.phase ?? 0] ?? PHASES[0]
  const live      = status === 'connected' || demo

  // ── Derived chart data ──────────────────────────────────────────────────────
  const chartData = useMemo(() => hist.map((h, i) => ({
    i,
    alt:   +(h.alt   ?? 0).toFixed(1),
    vel:   +(h.vel   ?? 0).toFixed(1),
    accel: +(h.accel ?? 1).toFixed(2),
    pitch: +(h.pitch ?? 0).toFixed(1),
    roll:  +(h.roll  ?? 0).toFixed(1),
    temp:  +(h.temp  ?? 0).toFixed(1),
  })), [hist])

  const noiseData = useMemo(() => rollingStdDev(hist, NOISE_WIN), [hist])

  const altMax = Math.max(maxAlt * 1.1, 5)
  const velMin = hist.length ? Math.min(...hist.map(h => h.vel ?? 0)) - 1 : -2
  const velMax = hist.length ? Math.max(...hist.map(h => h.vel ?? 0)) + 1 :  2
  const gMax   = hist.length ? Math.max(...hist.map(h => h.accel ?? 0)) + 0.5 : 3
  const noiseMax = noiseData.length ? Math.max(...noiseData.map(n => n.noise), 0.1) * 1.2 : 0.5

  const handleClearStorage = useCallback(() => {
    clearSession()
    setHist([]); setMaxAlt(0); setLog([])
    prevPhase.current = null
    pushLog('Historial borrado', 'warn')
  }, [pushLog])

  return (
    <div className="app">

      {/* ── HEADER ──────────────────────────────────────── */}
      <header className="hdr">
        <div className="hdr-left">
          <div className="logo-mark">
            <div className="logo-ring" />
            <div className="logo-dot" style={{ background: phase.color, boxShadow: `0 0 8px ${phase.color}` }} />
          </div>
          <div>
            <div className="mission-name">HYDRO<span>-1</span></div>
            <div className="mission-sub">GROUND STATION v3.0</div>
          </div>
        </div>

        <div className="phase-chip" style={{ borderColor: phase.color+'66', background: phase.color+'0d' }}>
          <div className="phase-chip-dot" style={{ background: phase.color }}>
            <div className="phase-chip-ring" style={{ borderColor: phase.color }} />
          </div>
          <span style={{ color: phase.color, fontFamily: 'monospace', fontWeight: 700, letterSpacing: '.15em' }}>
            {phase.label}
          </span>
        </div>

        <div className="hdr-right">
          {restored && (
            <div className="restored-badge">SESION RESTAURADA</div>
          )}
          <button
            className={`btn btn-icon ${muted ? 'btn-muted' : ''}`}
            onClick={() => setMuted(m => !m)}
            title={muted ? 'Activar audio' : 'Silenciar'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => hist.length > 0 && exportCSV(hist)}
            disabled={hist.length === 0}
            title="Exportar CSV"
          >
            CSV ↓
          </button>
          <button
            className="btn btn-ghost"
            onClick={handleClearStorage}
            title="Borrar historial guardado"
          >
            LIMPIAR
          </button>
          <div className={`conn-chip ${demo ? 'demo' : status}`}>
            <div className="cc-dot" />{demo ? 'DEMO' : status.toUpperCase()}
          </div>
          <div className="clock">T+ {data ? (data.t/1000).toFixed(1) : '--.-'}s</div>
        </div>
      </header>

      {/* ── PHASE TIMELINE ──────────────────────────────── */}
      <div className="phase-strip">
        <PhaseBar current={data?.phase ?? 0} />
      </div>

      {/* ── CONN BAR ────────────────────────────────────── */}
      <div className={`conn-bar ${live ? (demo ? 'cb-demo' : 'cb-live') : ''}`}>
        {!live ? <>
          <span className="cb-label">WebSocket:</span>
          <input className="cb-input" value={wsUrl} onChange={e => setWsUrl(e.target.value)} spellCheck={false} />
          <button className="btn btn-go" onClick={connect}>CONECTAR</button>
          <div className="cb-sep" />
          <button className="btn btn-ghost" onClick={startDemo}>MODO DEMO</button>
          {hist.length > 0 && (
            <span className="cb-saved">
              <span className="cb-saved-dot" /> {hist.length} muestras guardadas localmente
            </span>
          )}
        </> : <>
          <div className="cb-live-dot" style={{ background: demo ? '#facc15' : '#4ade80' }} />
          <span className="cb-url">
            {demo ? `Simulando — ${hist.length}/${DEMO.length} frames` : wsUrl}
          </span>
          <button className="btn btn-stop" onClick={demo ? stopDemo : disconnect}>
            {demo ? 'DETENER' : 'DESCONECTAR'}
          </button>
        </>}
      </div>

      {/* ── MAIN GRID ───────────────────────────────────── */}
      <div className="grid-main">

        {/* COL A — Telemetry */}
        <div className="col-a">
          <div className="panel">
            <div className="panel-hd">TELEMETRIA</div>
            <div className="stat-list">
              <StatRow label="ALTITUD"   value={data?.alt}      unit="m"   warn={40}  danger={55} />
              <StatRow label="VELOCIDAD" value={data?.vel}      unit="m/s" warn={12}  danger={18} />
              <StatRow label="G-FORCE"   value={data?.accel}    unit="G"   warn={5}   danger={15} dec={2} />
              <StatRow label="PITCH"     value={data?.pitch}    unit="°"   warn={20}  danger={40} />
              <StatRow label="ROLL"      value={data?.roll}     unit="°"   warn={30}  danger={60} />
              <StatRow label="YAW"       value={data?.yaw}      unit="°" />
              <StatRow label="TEMP"      value={data?.temp}     unit="°C"  dec={1} />
              <StatRow label="PRESION"   value={data?.pressure} unit="hPa" dec={1} />
              <StatRow label="APOGEO"    value={maxAlt}         unit="m"   dec={1} />
            </div>
          </div>

          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-hd">MISION</div>
            <div className="fstat-list">
              {[
                ['Apogeo',    maxAlt.toFixed(1) + ' m',                     '#c084fc'],
                ['Fase',      phase.label,                                    phase.color],
                ['T+',        data ? (data.t/1000).toFixed(1)+'s' : '--',   '#4ade80'],
                ['Muestras',  hist.length,                                    '#38bdf8'],
                ['Temp',      data ? data.temp.toFixed(1)+'°C' : '--',       '#fb923c'],
                ['Presion',   data ? data.pressure.toFixed(0)+' hPa' : '--', '#a3e635'],
                ['Guardado',  hist.length > 0 ? 'Si — ' + hist.length : 'No', hist.length > 0 ? '#4ade80' : '#5a7a5a'],
              ].map(([k,v,c]) => (
                <div className="fstat-row" key={k}>
                  <span className="fstat-k">{k}</span>
                  <span className="fstat-v" style={{ color: c }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* COL B — Charts with tabs */}
        <div className="col-b">
          <div className="chart-tabs">
            {CHART_TABS.map((t, i) => (
              <button
                key={t} className={`ctab ${chartTab === i ? 'ctab-active' : ''}`}
                onClick={() => setChartTab(i)}
              >{t}</button>
            ))}
          </div>

          {/* TAB 0: Flight data */}
          {chartTab === 0 && <>
            <div className="panel chart-panel">
              <div className="panel-hd">ALTITUD <span className="hd-unit">m</span></div>
              <div className="chart-area">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top:6, right:4, left:-18, bottom:0 }}>
                    <defs>
                      <linearGradient id="gAlt" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#4ade80" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#4ade80" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 6" stroke="#0d1f0d" />
                    <XAxis dataKey="i" hide />
                    <YAxis domain={[0, altMax]} tick={{ fill:'#4ade8066', fontSize:9, fontFamily:'monospace' }} width={36} />
                    <Tooltip {...TT('#020a02', '#4ade80')} />
                    <Area type="monotone" dataKey="alt" stroke="#4ade80" strokeWidth={2} fill="url(#gAlt)" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="panel chart-panel" style={{ flex:'0 0 155px' }}>
              <div className="panel-hd">VELOCIDAD <span className="hd-unit">m/s</span></div>
              <div className="chart-area">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top:6, right:4, left:-18, bottom:0 }}>
                    <CartesianGrid strokeDasharray="2 6" stroke="#071520" />
                    <XAxis dataKey="i" hide />
                    <YAxis domain={[Math.min(velMin,-1), Math.max(velMax,1)]} tick={{ fill:'#38bdf866', fontSize:9, fontFamily:'monospace' }} width={36} />
                    <Tooltip {...TT('#020912', '#38bdf8')} />
                    <ReferenceLine y={0} stroke="#38bdf833" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="vel" stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="panel chart-panel" style={{ flex:'0 0 135px' }}>
              <div className="panel-hd">G-FORCE <span className="hd-unit">G</span></div>
              <div className="chart-area">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top:6, right:4, left:-18, bottom:0 }}>
                    <CartesianGrid strokeDasharray="2 6" stroke="#1a1400" />
                    <XAxis dataKey="i" hide />
                    <YAxis domain={[0, gMax]} tick={{ fill:'#facc1566', fontSize:9, fontFamily:'monospace' }} width={36} />
                    <Tooltip {...TT('#0a0a02', '#facc15')} />
                    <ReferenceLine y={1} stroke="#facc1533" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="accel" stroke="#facc15" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>}

          {/* TAB 1: Orientation */}
          {chartTab === 1 && <>
            <div className="panel chart-panel">
              <div className="panel-hd">PITCH <span className="hd-unit">°</span></div>
              <div className="chart-area">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top:6, right:4, left:-18, bottom:0 }}>
                    <CartesianGrid strokeDasharray="2 6" stroke="#0d1f0d" />
                    <XAxis dataKey="i" hide />
                    <YAxis domain={[-50, 50]} tick={{ fill:'#c084fc66', fontSize:9, fontFamily:'monospace' }} width={36} />
                    <Tooltip {...TT('#08030f', '#c084fc')} />
                    <ReferenceLine y={0}   stroke="#c084fc33" strokeDasharray="4 4" />
                    <ReferenceLine y={20}  stroke="#facc1533" strokeDasharray="2 4" label={{ value:'warn', fill:'#facc1544', fontSize:8 }} />
                    <ReferenceLine y={-20} stroke="#facc1533" strokeDasharray="2 4" />
                    <Line type="monotone" dataKey="pitch" stroke="#c084fc" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="panel chart-panel" style={{ flex:'0 0 155px' }}>
              <div className="panel-hd">ROLL <span className="hd-unit">°</span></div>
              <div className="chart-area">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top:6, right:4, left:-18, bottom:0 }}>
                    <CartesianGrid strokeDasharray="2 6" stroke="#0d1f0d" />
                    <XAxis dataKey="i" hide />
                    <YAxis domain={[-90, 90]} tick={{ fill:'#fb923c66', fontSize:9, fontFamily:'monospace' }} width={36} />
                    <Tooltip {...TT('#0f0800', '#fb923c')} />
                    <ReferenceLine y={0}   stroke="#fb923c33" strokeDasharray="4 4" />
                    <ReferenceLine y={30}  stroke="#f8717133" strokeDasharray="2 4" />
                    <ReferenceLine y={-30} stroke="#f8717133" strokeDasharray="2 4" />
                    <Line type="monotone" dataKey="roll" stroke="#fb923c" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="panel chart-panel" style={{ flex:'0 0 135px' }}>
              <div className="panel-hd">TEMPERATURA <span className="hd-unit">°C</span></div>
              <div className="chart-area">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top:6, right:4, left:-18, bottom:0 }}>
                    <CartesianGrid strokeDasharray="2 6" stroke="#0d1f0d" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fill:'#38bdf866', fontSize:9, fontFamily:'monospace' }} width={36} />
                    <Tooltip {...TT('#020912', '#38bdf8')} />
                    <Line type="monotone" dataKey="temp" stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>}

          {/* TAB 2: EMI / Noise */}
          {chartTab === 2 && <>
            <div className="panel" style={{ flex:'0 0 auto', padding:'10px 12px' }}>
              <div className="panel-hd">ANALISIS DE RUIDO EMI</div>
              <div className="emi-info">
                <div className="emi-stat">
                  <span>Std-dev actual</span>
                  <span style={{ color: '#f87171', fontFamily:'monospace', fontWeight:700 }}>
                    {noiseData.length ? noiseData[noiseData.length-1].noise.toFixed(3) : '--'} m
                  </span>
                </div>
                <div className="emi-stat">
                  <span>Pico de ruido</span>
                  <span style={{ color: '#facc15', fontFamily:'monospace', fontWeight:700 }}>
                    {noiseData.length ? Math.max(...noiseData.map(n=>n.noise)).toFixed(3) : '--'} m
                  </span>
                </div>
                <div className="emi-stat">
                  <span>Ventana rolling</span>
                  <span style={{ color: '#4ade80', fontFamily:'monospace' }}>{NOISE_WIN} muestras</span>
                </div>
                <div className="emi-stat">
                  <span>Interpretacion</span>
                  <span style={{ color: '#38bdf8', fontFamily:'monospace', fontSize:'.65rem' }}>
                    {noiseData.length ? (
                      noiseData[noiseData.length-1].noise < 0.05 ? 'BAJO — cableado limpio' :
                      noiseData[noiseData.length-1].noise < 0.2  ? 'MEDIO — revisar GND' :
                      'ALTO — interferencia EMI'
                    ) : '--'}
                  </span>
                </div>
              </div>
            </div>
            <div className="panel chart-panel" style={{ flex: 1 }}>
              <div className="panel-hd">RUIDO ALTITUD — STD-DEV ROLLING <span className="hd-unit">m (ventana {NOISE_WIN})</span></div>
              <div className="chart-area">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={noiseData} margin={{ top:6, right:4, left:-18, bottom:0 }}>
                    <CartesianGrid strokeDasharray="2 6" stroke="#1a0505" />
                    <XAxis dataKey="i" hide />
                    <YAxis domain={[0, noiseMax]} tick={{ fill:'#f8717166', fontSize:9, fontFamily:'monospace' }} width={36} />
                    <Tooltip {...TT('#0f0202', '#f87171')} />
                    <ReferenceLine y={0.05} stroke="#4ade8033" strokeDasharray="4 4" label={{ value:'bajo', fill:'#4ade8044', fontSize:8, position:'right' }} />
                    <ReferenceLine y={0.2}  stroke="#facc1533" strokeDasharray="4 4" label={{ value:'medio', fill:'#facc1544', fontSize:8, position:'right' }} />
                    <Bar dataKey="noise" fill="#f87171" fillOpacity={0.5} isAnimationActive={false} />
                    <Line type="monotone" dataKey="noise" stroke="#f87171" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="panel" style={{ flex:'0 0 90px', padding:'10px 12px' }}>
              <div className="panel-hd">GUIA DE USO</div>
              <div className="emi-guide">
                Compara el nivel de ruido entre configuraciones de cableado. Menor std-dev = menos EMI.
                Ideal para probar twisting de cables, ferrites, o distancia al motor servo.
              </div>
            </div>
          </>}
        </div>

        {/* COL C — Instruments */}
        <div className="col-c">
          <div className="panel" style={{ flex:'0 0 auto' }}>
            <div className="panel-hd">HORIZONTE ARTIFICIAL</div>
            <div className="horizon-row">
              <HorizonBall pitch={data?.pitch ?? 0} roll={data?.roll ?? 0} />
              <div className="horizon-nums">
                {[['PITCH', data?.pitch, 20], ['ROLL', data?.roll, 30], ['YAW', data?.yaw, 999]].map(([l,v,thr]) => (
                  <div className="hn-row" key={l}>
                    <span className="hn-l">{l}</span>
                    <span className="hn-v" style={{ color: Math.abs(v??0) > thr ? '#f87171' : '#4ade80' }}>
                      {(v??0).toFixed(1)}°
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="panel" style={{ flex:'0 0 auto' }}>
            <div className="panel-hd">ACELEROMETRO</div>
            <div className="gauges-row">
              <GaugeArc value={data?.accel} max={20} label="G-FORCE" color="#facc15" />
              <div className="gauge-mini-stack">
                {[['PITCH',data?.pitch,'°'],['ROLL',data?.roll,'°'],['TEMP',data?.temp,'°C']].map(([l,v,u])=>(
                  <div className="gms" key={l}>
                    <span className="gms-l">{l}</span>
                    <span className="gms-v">{(v??0).toFixed(1)}</span>
                    <span className="gms-u">{u}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-hd">ALTIMETRO</div>
            <div className="altim-row">
              <AltBar alt={data?.alt ?? 0} max={maxAlt} />
              <div className="altim-nums">
                <div className="an-big">{(data?.alt ?? 0).toFixed(1)}<span>m</span></div>
                <div className="an-peak">▲ APOGEO: {maxAlt.toFixed(1)} m</div>
                <div className="an-vel" style={{ color: (data?.vel??0) >= 0 ? '#4ade80' : '#f87171' }}>
                  {(data?.vel??0) >= 0 ? '▲' : '▼'} {Math.abs(data?.vel??0).toFixed(1)} m/s
                </div>
                <div className="an-pres">{(data?.pressure??0).toFixed(0)} hPa</div>
              </div>
            </div>
          </div>
        </div>

        {/* COL D — Log */}
        <div className="col-d">
          <div className="panel" style={{ flex: 1, minHeight: 0 }}>
            <div className="panel-hd">LOG DE EVENTOS</div>
            <div className="log-scroll">
              {log.length === 0 && <div className="log-empty">-- sin datos --</div>}
              {[...log].reverse().map((e, i) => (
                <div key={i} className={`log-line lt-${e.type}`}>
                  <span className="ll-ts">{e.ts}</span>
                  <span className="ll-msg">{e.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
