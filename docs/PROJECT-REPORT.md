# DocDoor — Technical Project Report

_A home-visit doctor / telemedicine platform — engineering overview_

---

## 1. Context & Motivation

In Turkey, outpatient waits run 2–4 hours and the 65+ population (the group least able to travel to hospitals) is growing quickly. **DocDoor** is my attempt to address that access gap with software: an on-demand platform where a patient books a doctor to their home, pays securely, optionally files an insurance claim, talks to an AI symptom assistant, and follows the visit status in real time — backed by a full administrative back-office.

I built the **entire system end-to-end**: data model, REST and WebSocket APIs, authentication and security, third-party payment and insurance integrations, the React front-end, and a Progressive Web App shell.

## 2. Goals

- A single Node.js service that serves both the REST API and the web client.
- Production-minded **security** from the start (auth, rate limiting, input sanitization, audit logging).
- **Real-time** appointment/status updates without a heavyweight message broker.
- Third-party integrations (payments, insurance, AI) that degrade gracefully to **mock mode** so the project runs with zero external accounts.
- **Internationalization** (4 languages) and an installable **PWA**.

## 3. System Architecture

```
                    ┌─────────────────────────────┐
   Browser / PWA ──▶│  Express App  (server.js)   │
   React (app.jsx)  │                             │
        ▲           │  • Security middleware      │
        │  WebSocket │    (rate limit, sanitize,   │
        └────────────┤     headers, JWT auth)      │
   live updates      │  • REST routes (/api/*)     │
                     └──────────────┬──────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   SQLite (sql.js)          External integrations         WebSocket Server
   users, doctors,          • iyzico  (payments)          real-time push to
   visits, meds,            • SGK/Medula (insurance)      connected clients
   insurance, payments      • Anthropic (AI assistant)
```

A single Express process compiles the JSX front-end on startup (Babel), serves the static PWA, exposes the REST API under `/api/*`, and upgrades connections to a WebSocket server for live updates.

## 4. Tech Stack & Rationale

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | **Node.js + Express** | One language across API and tooling; minimal, well-understood HTTP layer |
| Real-time | **`ws` (WebSocket)** | Push updates without the operational weight of a broker like Kafka/RabbitMQ |
| Database | **SQLite via `sql.js`** | Zero-setup, file-based; the whole app runs from a clone with no DB server |
| Auth | **JWT + bcrypt** | Stateless tokens (separate patient/admin secrets), salted password hashing |
| Front-end | **React (Babel-compiled JSX)** | Component UI without a heavy build pipeline; compiled on server start |
| Delivery | **PWA** (manifest + Lottie) | Installable, app-like experience on mobile |

## 5. Key Engineering Features

**Authentication & security.** JWT with **separate patient and admin signing secrets**; bcrypt password hashing; lightweight, hand-rolled middleware (`middleware/security.js`) providing per-route **rate limiting**, **input sanitization** (strips `<script>` tags and inline event handlers to mitigate XSS), and hardening headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, removes `X-Powered-By`). Login and signup endpoints have stricter limits to resist brute force.

**Real-time sync.** A WebSocket server pushes appointment/status changes to connected clients, so a patient sees a doctor accept/arrive without polling.

**Payments (iyzico).** Pre-authorization on booking → capture after the visit, with a 12-hour full-refund window. When no API key is configured, the module runs in **mock mode**, so the full flow is demonstrable offline.

**Insurance.** Private-insurance eligibility keyed on the Turkish national ID. The **TC Kimlik checksum validator** is implemented as a pure function (`utils/validators.js`) and unit-tested. Coverage rate and co-pay are computed automatically; mock mode included.

**AI health assistant.** Symptom guidance via the Anthropic API, again with a mock fallback.

**Internationalization.** Full UI in **English, Turkish, Spanish and German**.

**Admin panel.** Dashboard, user/doctor management, payments, insurance claims, doctor payouts, complaints, system settings and an audit trail.

## 6. Data Model (overview)

Core tables include `users` (patients & doctors, role-based), `visits`, `meds`, `insurance_records`, and `payments`, plus supporting tables for notifications, favorites and contacts. API responsibilities are split into focused route modules: `auth`, `doctors`, `schedule`, `visits`, `meds`, `insurance`, `payment`, `notifications`, `favorites`, `contacts`, `ai`, `admin`.

## 7. Testing & CI

- **Unit tests** on Node's built-in test runner (zero dependencies) cover the TC Kimlik checksum validator and the security middleware (sanitizer + headers).
- **GitHub Actions** runs the suite on **Node 20 & 22** for every push and pull request.
- A refactor extracted the validator into `utils/` to make it testable and reusable — a small example of refactoring toward separation of concerns.

## 8. Challenges & Solutions

- **Running with no external accounts.** Every paid integration (payments, insurance, AI) detects a missing API key and falls back to a deterministic mock — the demo works from a fresh clone.
- **Real-time without infrastructure.** Chose a single-process WebSocket server over a broker to keep the system deployable and easy to reason about at this scale.
- **Security as a baseline, not an afterthought.** Rate limiting, sanitization, hardening headers and an audit log were built in early rather than retrofitted.
- **Clean process lifecycle.** The rate-limiter's cleanup timer is `unref()`-ed so the process (and CI) can exit cleanly.

## 9. What I Learned

Designing a two-sided product forces decisions far beyond code: data modeling, security trade-offs, third-party integration boundaries, graceful degradation, internationalization, and the discipline of tests + CI. Building DocDoor end-to-end taught me how the pieces of a real product fit together — and how much of "engineering" is making deliberate trade-offs.

## 10. Future Work

Telehealth (video) consultations, a migration path from SQLite to PostgreSQL for scale, end-to-end tests around the booking flow, and observability (structured logging + metrics).

---

_See also: [Architecture-level overview in the main README](../README.md) · [SWOT](SWOT-ANALYSIS.md) · [Strategy](STRATEGY.md) · [Legal analysis](LEGAL-ANALYSIS.md) · [Pitch summary](PITCH.md)._
