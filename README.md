# 🛰️ HYDRO-1 Ground Station — v3.0

> **Real-time telemetry dashboard for the HYDRO-1 flight computer.**
> WebSocket telemetry · 3D attitude · Live charts · EMI noise analysis · CSV export · Audio alerts · Demo mode

[![Status](https://img.shields.io/badge/status-In%20Development-yellow)](https://github.com/DonJechu/HYDRO-1-Ground-Station)
[![Stack](https://img.shields.io/badge/stack-React%20%2B%20Vite-blue)](https://vitejs.dev/)
[![Flight Computer](https://img.shields.io/badge/flight%20computer-HYDRO--1-green)](https://github.com/DonJechu/HydroRocket-Telemetry-System)

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [System Connection](#system-connection)
3. [Features](#features)
4. [Interface Layout](#interface-layout)
5. [Chart Tabs](#chart-tabs)
6. [EMI Noise Analysis](#emi-noise-analysis)
7. [Audio Alerts](#audio-alerts)
8. [Data Persistence & CSV Export](#data-persistence--csv-export)
9. [Tech Stack](#tech-stack)
10. [Getting Started](#getting-started)
11. [Demo Mode](#demo-mode)
12. [Telemetry Protocol](#telemetry-protocol)
13. [Flight Phases](#flight-phases)
14. [Related Repository](#related-repository)

---

## Overview

**HYDRO-1 Ground Station** is the real-time telemetry dashboard for the [HYDRO-1 flight computer](https://github.com/DonJechu/HydroRocket-Telemetry-System). It connects to the ESP32 via WebSocket over Wi-Fi and visualizes all flight data in real time.

The ground station was designed around two goals:

1. **Operational:** situational awareness during flight — phase tracking, altitude, G-force, attitude, and audio alerts for critical events
2. **Research:** capture and quantify telemetry noise for post-flight EMI analysis, comparing unshielded vs. twisted-pair wiring configurations via rolling standard deviation of altitude signal

> ⚠️ **Status:** Active development. Connected and tested with HYDRO-1 v2.0 firmware.

---

## System Connection

```
ESP32 (AP: GANNET) ──► WebSocket ws://192.168.4.1:81 ──► Ground Station
                              10 Hz JSON packets
```

The ESP32 creates a Wi-Fi Access Point. The ground station connects and receives JSON telemetry at 10 Hz. No internet connection required — fully local operation.

---

## Features

| Feature | Description |
|---|---|
| **Real-time telemetry** | Altitude, velocity, G-force, pitch, roll, yaw, temperature, pressure at 10 Hz |
| **Flight phase tracker** | Visual timeline: STANDBY → ARMED → IGNITION → ASCENT → APOGEE → DESCENT → LANDING |
| **Artificial horizon** | SVG attitude ball with pitch/roll visualization — warns at critical angles |
| **3 chart tabs** | VUELO (flight), ORIENTACION (attitude), EMI / RUIDO (noise analysis) |
| **EMI noise tab** | Rolling std-dev of altitude signal — quantifies sensor noise per wiring configuration |
| **Audio alerts** | Synthesized tones for ignition, apogee, landing, and critical G-force — no files needed |
| **CSV export** | One-click export of full flight history with timestamps and all telemetry fields |
| **Auto-save** | Session automatically saved to localStorage every 2 seconds — survives browser refresh |
| **Session restore** | On startup, restores last flight session with badge indicator |
| **G-force gauge** | Arc gauge with dynamic color: green → yellow → red |
| **Altimeter** | Vertical bar with apogee marker and live velocity direction |
| **Event log** | Timestamped log of all phase transitions and connection events (300 entries) |
| **Auto-reconnect** | WebSocket hook with 3-second automatic reconnection on disconnect |
| **Demo mode** | Pre-computed simulated flight — no hardware required |
| **Mute toggle** | Disable/enable all audio alerts during testing |

---

## Interface Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  HEADER: Mission name · Phase chip · Mute · CSV · Clear · T+     │
│  PHASE TIMELINE: SBY → ARM → IGN → ASC → APG → DES → LND        │
│  CONNECTION BAR: URL input / Connect / Demo / Saved samples       │
├──────────┬────────────────────────┬────────────┬─────────────────┤
│ COL A    │ COL B                  │ COL C      │ COL D           │
│          │ [VUELO][ORIENT][EMI]   │            │                 │
│ Telemetry│                        │ Artificial │ Event log       │
│ values   │ Charts (tabbed)        │ horizon    │                 │
│          │                        │            │                 │
│ Mission  │                        │ G gauge    │                 │
│ stats    │                        │ Altimeter  │                 │
└──────────┴────────────────────────┴────────────┴─────────────────┘
```

---

## Chart Tabs

### Tab 1 — VUELO
Standard flight data: altitude (area chart), velocity (line), G-force (line). Rolling buffer of last 600 samples (1 minute at 10 Hz). Auto-scaling axes with padding.

### Tab 2 — ORIENTACION
Attitude data over time: pitch (line, ±50° domain with warning lines at ±20°), roll (line, ±90° domain with warning lines at ±30°), temperature (line).

### Tab 3 — EMI / RUIDO
See [EMI Noise Analysis](#emi-noise-analysis) below.

---

## EMI Noise Analysis

The EMI tab is the research core of this ground station. It quantifies electromagnetic interference by measuring the rolling standard deviation of the altitude signal:

$$\sigma_{rolling}[n] = \sqrt{\frac{1}{W}\sum_{i=n-W+1}^{n}(h_i - \bar{h})^2}$$

Where $W$ is the rolling window size (default: 20 samples).

**Interpretation:**

| Std-dev | Level | Meaning |
|---|---|---|
| < 0.05 m | 🟢 BAJO | Clean wiring — low EMI |
| 0.05–0.2 m | 🟡 MEDIO | Moderate noise — check GND routing |
| > 0.2 m | 🔴 ALTO | High EMI — electromagnetic interference detected |

**Research use:** Run two flights with different wiring configurations (parallel unshielded vs. twisted pair) and compare the peak and average std-dev values. Lower std-dev confirms field confinement predicted by the Poynting Vector framework.

The tab also shows current std-dev, peak noise, window size, and automatic interpretation.

---

## Audio Alerts

Synthesized tones via Web Audio API — no external files required. All tones are generated programmatically:

| Event | Sound | Trigger |
|---|---|---|
| **Ignition** | Low sawtooth rumble burst | Phase → IGNITION (2) |
| **Apogee** | Rising tri-tone (880→1100→1320 Hz) | Phase → APOGEE (4) |
| **Landing** | Double-tap + resolution tone | Phase → LANDING (6) |
| **Warning** | Double square beep at 660 Hz | Critical G > 15G during ASCENT |

Use the 🔇/🔊 button in the header to mute/unmute during ground testing.

---

## Data Persistence & CSV Export

### Auto-save
Every 2 seconds, the current session (up to 600 samples, last 50 log entries, max altitude) is saved to `localStorage`. On next load, the session is automatically restored with a "SESION RESTAURADA" badge.

Use **LIMPIAR** to clear stored session data and start fresh.

### CSV Export
Click **CSV ↓** to download the complete flight history as a `.csv` file:

```
t_ms,alt_m,vel_ms,accel_G,pitch_deg,roll_deg,yaw_deg,temp_C,pressure_hPa,phase
0,0.0,0.0,1.00,0.0,0.0,0.0,24.0,1013.0,0
100,0.0,0.0,1.01,0.0,0.0,0.0,24.0,1013.0,0
...
```

File is named `hydro1_flight_YYYY-MM-DDTHH-MM-SS.csv`. Use this data for post-flight analysis in MATLAB, Python, or Excel.

---

## Tech Stack

```
React 18 + Vite     — UI framework and build tool (localhost:5173)
Recharts            — Altitude, velocity, G-force, pitch, roll, noise charts
Web Audio API       — Synthesized audio alerts (no files)
localStorage        — Session persistence across browser refreshes
Custom SVG          — Artificial horizon ball and G-force arc gauge
WebSocket API       — Native browser WebSocket with custom reconnect hook
```

### Key implementation details

**`useWebSocket` hook** — manages connection lifecycle, automatic 3-second reconnection, and message parsing with stable callback reference via `useRef`.

**`AudioEngine` class** — synthesizes all tones using Web Audio API oscillators with exponential gain ramp for clean note decay. No audio files required.

**`rollingStdDev`** — pure function computing rolling standard deviation over altitude samples. Used as the primary EMI quantification metric.

**`useMemo` optimization** — chart data and noise data are memoized to avoid recomputing on every render.

**Demo mode** — 266 pre-computed frames simulating a complete flight with realistic physics (18 m/s peak, ~40m apogee, parachute descent). All events trigger audio.

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install and run

```bash
git clone https://github.com/DonJechu/HYDRO-1-Ground-Station.git
cd HYDRO-1-Ground-Station
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

### Connect to flight computer

1. Power on HYDRO-1 — wait for `=== READY FOR FLIGHT ===` in serial monitor
2. Connect laptop to Wi-Fi: **SSID: GANNET** / **Password: 1234**
3. Open ground station at `localhost:5173`
4. Default URL `ws://192.168.4.1:81` is pre-filled — click **CONECTAR**

### Build for production

```bash
npm run build
```

---

## Demo Mode

Click **MODO DEMO** to simulate a complete flight without hardware. Plays back 266 frames at 10 Hz including all 7 phase transitions. All audio alerts fire at the correct moments. EMI noise tab shows simulated noise data. CSV export works on demo data.

---

## Telemetry Protocol

JSON packets over WebSocket at 10 Hz:

```json
{
  "t":        12340,
  "alt":      42.3,
  "vel":      12.1,
  "accel":    3.47,
  "pitch":    -2.1,
  "roll":     0.8,
  "yaw":      0.0,
  "temp":     28.4,
  "pressure": 1009.2,
  "phase":    3
}
```

| Field | Type | Unit | Description |
|---|---|---|---|
| `t` | int | ms | Mission elapsed time |
| `alt` | float | m | Filtered altitude above launch point |
| `vel` | float | m/s | Vertical velocity (positive = ascending) |
| `accel` | float | G | Total acceleration magnitude |
| `pitch` | float | ° | Nose-up/down angle |
| `roll` | float | ° | Roll angle |
| `yaw` | float | ° | Yaw (reserved) |
| `temp` | float | °C | Ambient temperature |
| `pressure` | float | hPa | Absolute pressure |
| `phase` | int | 0–6 | Flight state ID |

---

## Flight Phases

| ID | State | Color | Description |
|---|---|---|---|
| 0 | STANDBY | 🟢 Green | Pre-launch, transmitting telemetry |
| 1 | ARMED | 🟡 Yellow | Armed and ready (future: remote command) |
| 2 | IGNITION | 🟠 Orange | Launch detected |
| 3 | ASCENT | 🔵 Blue | Climbing — apogee detection active |
| 4 | APOGEE | 🟣 Purple | Apogee confirmed — parachute deployed |
| 5 | DESCENT | 🔴 Red | Descending with parachute |
| 6 | LANDING | 🟢 Green | Landed — flight complete |

---

## Related Repository

**Flight Computer — Firmware + Hardware + Mechanical:**
[HydroRocket-Telemetry-System](https://github.com/DonJechu/HydroRocket-Telemetry-System)

---

## Author

**Jesús Alberto Perea García**
Mechatronics Engineering Student — IEST Anáhuac, Tamaulipas
Member: IEEE Student Branch · Vértice Excellence Program
[github.com/DonJechu](https://github.com/DonJechu) · jesus.perea@iest.edu.mx

*Part of ongoing research on EMI mitigation in aerospace avionics using the Poynting Vector framework.*
