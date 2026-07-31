# ⚡ Vaelos — Smart Transport Operations Platform

**Vaelos** is a fleet operations platform for managing vehicles, drivers, trips, maintenance, fuel, expenses, and AI-driven insights in one place. Built for hackathon scale — fast, self-contained, and PWA-installable.

> **Stack:** Node.js + Express + better-sqlite3 + WebSockets · Vanilla JS frontend · Leaflet maps · Progressive Web App

---

## ✨ Features

### Core (10 mandatory business rules)
- **Authentication** — JWT in httpOnly cookies, 4 roles (Fleet Manager, Driver, Safety Officer, Financial Analyst)
- **Vehicles** — Full CRUD, capacity & odometer tracking, status (Available / On Trip / In Shop / Retired)
- **Drivers** — License expiry tracking with auto-notifications (expired / expiring soon)
- **Trips** — Draft → Dispatched → Completed / Cancelled lifecycle with cargo, distance, and revenue
- **Maintenance** — Open / Closed records, vehicle auto-set to "In Shop"
- **Fuel & Expenses** — Per-vehicle tracking with km/L efficiency
- **KPIs & Metrics** — Live fleet utilization, ROI, cost analysis
- **CSV / PDF export** of full report
- **Dark / light theme** with smooth transitions
- **Audit logging** of every mutation

### 🔥 Rare / uncommon features
- 🗺️ **Interactive Live Map** — Leaflet-powered view of every vehicle with status-coloured markers, dispatch info, and OSM tiles
- 🤖 **AI Assistant** — Plain-English Q&A ("most expensive vehicles", "best ROI", "expired licenses", "fleet utilization") with rule-based NL → data
- 🔮 **Predictive Maintenance AI** — Risk score per vehicle (odometer, fuel drift, days-since-service, repair history, ROI)
- 🏆 **Driver Leaderboard** — Podium layout, gold/silver/bronze badges by safety score
- 📋 **Audit Log Timeline** — Entity-coloured activity timeline of all mutations
- 🔔 **Live WebSocket updates** — KPI badges refresh in real time on any mutation
- 🎙️ **Voice commands** — Web Speech API ("open dashboard", "go to vehicles", "toggle theme")
- 📱 **PWA** — Installable, offline-capable service worker

---

## 🚀 Quick start

```bash
npm install
npm run init-db      # create database with seed data
npm start            # http://localhost:3000
```

Then sign in with one of the demo accounts:

| Role               | Email                 | Password   |
|--------------------|-----------------------|------------|
| Fleet Manager      | admin@vaelos.com      | admin123   |
| Driver             | alex@vaelos.com       | driver123  |
| Safety Officer     | sarah@vaelos.com      | safety123  |
| Financial Analyst  | felix@vaelos.com      | finance123 |

---

## 🧪 Test business rules

```bash
npm test
```

Runs an end-to-end smoke test of all 10 mandatory business rules plus the new features.

---

## 📂 Project structure

```
Vaelos/
├── server.js                Express + WebSocket server
├── database.js              SQLite schema & seed
├── operations.js            All business logic (audit, predictive, AI, leaderboard)
├── test_business_rules.js   End-to-end test suite
├── public/
│   ├── index.html           Single-page app shell
│   ├── app.js               Frontend router + all pages
│   ├── style.css            Theme, dashboard, leaderboard podium, risk gauge, timeline
│   ├── manifest.json        PWA manifest
│   ├── sw.js                Service worker (offline shell)
│   ├── icon-192.svg         App icon
│   └── icon-512.svg         App icon
└── package.json
```

---

## 🔌 API reference (selected)

| Method | Path                              | Auth | Description                           |
|--------|-----------------------------------|------|---------------------------------------|
| POST   | `/api/auth/login`                 | —    | Get JWT cookie                        |
| GET    | `/api/auth/me`                    | ✔    | Current user                          |
| GET    | `/api/vehicles?type=&status=&region=` | ✔ | List + filter vehicles             |
| POST   | `/api/trips`                      | ✔    | Create draft trip                     |
| POST   | `/api/trips/:id/dispatch`         | ✔    | Dispatch (validates capacity + license) |
| POST   | `/api/trips/:id/complete`         | ✔    | Complete trip                         |
| GET    | `/api/kpis`                       | ✔    | Dashboard KPIs                        |
| GET    | `/api/metrics`                    | ✔    | Per-vehicle efficiency / ROI          |
| GET    | `/api/audit?limit=200`            | ✔    | Audit log timeline                    |
| GET    | `/api/predictive-maintenance`     | ✔    | Risk scoring                          |
| GET    | `/api/leaderboard`                | ✔    | Driver ranking                        |
| POST   | `/api/ai`                         | ✔    | `{ question: "..." }` → natural-language answer |

WebSocket: connect to `/ws` for live mutation broadcasts.

---

## 🧠 How the rare features work

**Predictive Maintenance** scores each vehicle 0–100 by adding risk factors:
- Odometer > 50,000 km → 30 pts; > 25,000 km → 15 pts
- Fuel efficiency < 6 km/L → 25 pts
- Days since last maintenance > 180 → 25 pts
- Maintenance count ≥ 3 → 15 pts
- Low / negative ROI → 5 pts

Risk = High (≥ 60) / Medium (≥ 30) / Low.

**AI Assistant** matches questions against 12 patterns (`most expensive`, `best roi`, `lowest fuel`, `expired`, `expiring`, `available vehicle`, `on trip`, `in shop`, `utilization`, `total revenue`, `summary`, `help`). Answers include a tabular breakdown of the underlying records.

**Driver Leaderboard** ranks by safety score, awards 🥇 / 🥈 / 🥉, shows trips completed and total km.

**Audit Log** records every mutating call (`actor`, `action`, `entity`, `entity_id`, `message`) with timestamps, color-coded by entity type.

---

## 📜 License

MIT