# Gatherly project state

**Last updated:** 2026-11-03 (Asia/Manila)  
**Purpose:** Durable project handoff for future sessions. Update this file when scope, decisions, implementation, or validation changes.

## Current handoff snapshot (2026-11-03)

The project files and latest work are saved in this workspace. The latest requested UI improvement is complete: the local v0.1 theme editor previews a clone of the actual guest invitation, and browser verification plus all 18 tests passed. No feature is currently left mid-implementation.

To continue with another coding assistant, open this folder and have it read this file first, then [`v0.1/README.md`](./v0.1/README.md) before changing the prototype. The key latest implementation is in `v0.1/public/app.js`, `v0.1/public/index.html`, and `v0.1/public/styles.css`; preview and UI regressions are in `v0.1/test/theme-ui.test.js` and related UI tests.

Run the prototype from PowerShell with `Set-Location .\v0.1; npm start`; validate with `Set-Location .\v0.1; npm test`. It uses local SQLite data under `v0.1/data/`; do not reset or overwrite it. The app is for synthetic data, binds to loopback, and sends no email. Do not expose it publicly or enter real guest data. The root static demo is separate and remains unchanged. This workspace has no Git repository at its root, and no commit or deployment was made.

## Product and goal

Gatherly is an event invitation and guest-management product. The near-term goal is a zero-budget client demo and a working v0.1 prototype, not a production launch. Keep the public static demo separate from v0.1.

## Non-negotiable constraints

- Prefer free alternatives; do not introduce paid hosting or services without approval.
- Do not choose or provision a production cloud provider, project, or region until the user decides.
- Use synthetic data only in the prototype. Do not send real email.
- Do not push or commit changes unless requested.
- Keep the public demo working and separate from local v0.1 development.

## Product decisions

- The host chooses per event whether an RSVP unit is an individual or a household/group.
- Each guest unit receives a unique, revocable RSVP link. The link is a bearer credential; anyone with it can access that unit's RSVP.
- Guests may change their RSVP until the deadline. The host can explicitly reopen responses afterward.
- Household party size is bounded by the limit set for that guest unit; an individual RSVP is limited to one.
- Email is in scope as a workflow, but v0.1 only captures invitation content in a local outbox. Nothing is delivered.
- Invitation themes (presets, custom colors/fonts, optional photo upload, and preview) are implemented in local v0.1, with WCAG AA text/background contrast enforcement; they are not part of the public static demo.

## Current project layout

### Public static demo — repository root

- `index.html`, `styles.css`, and `app.js` are a standalone browser-only client demo.
- Includes a guided walkthrough, host dashboard mockup, guest invitation and RSVP interaction.
- Demo edits/responses stay in that browser's `localStorage`; they are not shared across visitors or devices.
- The root [`README.md`](./README.md) documents how to run and present it.
- Historical project context records the live GitHub Pages URL as `https://acetentacion.github.io/event-invitation-platform/`. Its current availability was not checked during this update.

### Local shared-data prototype — [`v0.1/`](./v0.1/)

- [`server.js`](./v0.1/server.js) serves the local API and static UI; it binds to loopback.
- [`public/`](./v0.1/public/) contains the prototype interface.
- [`persistence.js`](./v0.1/persistence.js) and [`store.js`](./v0.1/store.js) provide SQLite storage.
- [`test/`](./v0.1/test/) contains API integration tests.
- [`reset.js`](./v0.1/reset.js) resets only the local prototype database after an explicit confirmation.
- [`README.md`](./v0.1/README.md) is the source for v0.1 setup and safety details.
- Implemented: local host setup/sign-in, events, individual/household modes, guest link issuance and revocation, RSVP revisions and limits, deadline enforcement and host reopen/close, persisted dashboard totals, and local outbox capture.
- The host event card exposes publish now; draft/published state is shown and the publish action is hidden once published.
- Theme editor/API implementation is complete. Theme settings persist per event and render on the guest RSVP page. The agreed shape is classic/garden/midnight/custom preset; primary/background/text hex colors; serif/sans font; optional PNG/JPEG/WebP cover image with 1 MiB decoded limit. The editor blocks text/background contrast below 4.5:1, and the server independently validates the same WCAG AA threshold. Older saved low-contrast text colors are displayed with a readable fallback.
- The v0.1 UI now follows the root demo's warm paper/botanical palette, editorial serif and sans typography, Gatherly mark, and invitation styling while retaining the local-only warning and functional host/guest workflows. The root demo remains unchanged.
- The published-event workflow now explains the local-only next step: create a guest unit to generate a private RSVP link and view its captured invitation in the local outbox; it explicitly states no email is sent. Empty guest lists offer an “Add first guest unit” action.
- The v0.1 guest invitation now follows the root demo's editorial card layout: Gatherly mark, botanical details, formatted event/date/location/deadline/capacity, accessible RSVP choice cards, and a thank-you/update state. It uses the real API guest identity/theme and preserves the existing RSVP submission contract.
- The v0.1 host view now uses an event-first workspace dashboard inspired by the landing demo: sidebar navigation, event overview/actions, response-summary cards, a dedicated guest-list panel, and a secondary event-creation section. Existing local workflows and disclosures remain available.

## Run and validate

Requirements: Node.js 24 or newer. From PowerShell:

```powershell
cd .\v0.1
npm start
npm test
```

Open `http://127.0.0.1:3000`. The app must remain local; do not expose it to the public internet. To reset prototype records, stop the server and run `npm run reset` from `v0.1`; confirm by typing exactly `RESET`. This removes the SQLite database and its SQLite sidecars.

The root static demo can be opened directly by opening `index.html` in a browser. Its reset control is separate from the v0.1 database reset.

### Latest validation

- Theme-preview parity verified in the browser at port 3000: the editor shows the full invitation card structure (including botanical decoration, event details, party-capacity guidance, and RSVP choices), and the RSVP controls are disabled. The preview rendered the current event details and Garden theme; switching to Midnight immediately updated the preview's palette and font. Reloading restored the saved Garden preset, confirming the draft change was not persisted. At a 390px mobile viewport, the page had no horizontal overflow. `npm test` from `v0.1/` passes all 18 tests (0 failures).
- After the dashboard redesign, `npm test` from `v0.1/` passed all 17 tests (0 failures), and JavaScript syntax checks passed. Browser inspection confirmed the workspace sidebar/event-first dashboard at desktop widths and its stacked mobile layout at 390px, without horizontal overflow or page errors. The primary local app is running at port 3000.
- After the guest-page redesign, a synthetic-only browser walk-through verified invitation details, successful RSVP submission, confirmation, reopening the existing response for editing, and decline selection (party size 0). Browser caught a mismatch between the new radio-card controls and the old select-based change handler; fixed the handler to listen on the response fieldset. The invitation rendered without page errors at 320, 390, and 1280px with no horizontal overflow. All 17 tests pass; JavaScript syntax checks pass. The isolated temporary DB was removed; app on port 3000 was restarted and returned HTTP 200.
- After the publish-guidance update, live browser inspection initially found a missing stats container causing a null-reference error. Restored the container and added a regression assertion; `npm test` from `v0.1/` passes all 15 tests, and JavaScript syntax checks pass. The local app on port 3000 was restarted and verified HTTP 200; browser confirms the published event displays counts, next-step guidance, and the zero-guest action with no page errors.
- After the demo-style alignment, `npm test` from `v0.1/` passed all 15 tests (0 failures), and JavaScript syntax checks passed. Browser checks at 320, 390, and 1280px showed no horizontal overflow; reloading the app on port 3000 returned HTTP 200 with no page errors. Authenticated dashboard/guest visual testing against the current local database was not performed in this pass.
- `npm test` from `v0.1/` passed all 13 tests (0 failures), including regressions for insufficient contrast in the editor and API. `node --check .\public\app.js` passed.
- Browser verification of themes confirmed a saved palette and uploaded synthetic cover persisted and rendered on the guest invitation. The latest contrast follow-up is covered by UI/API tests; no new browser walkthrough was performed for this follow-up.
- Started the local server on `http://127.0.0.1:3000`; smoke-tested `/`, `/api/status`, and `/app.js`. The UI loaded and initial status reported setup required.
- Browser-tested host registration, household event creation, guest-link issuance, publishing, RSVP submission and revision, outbox capture, dashboard totals, and link revocation using an isolated temporary database. Verified published status; after a household RSVP update to party size 2, the dashboard showed `Yes: 1` and `Attending people: 2`; the old link returned unavailable after revocation.
- Found and fixed UI issues during browser QA: form reset after async event/guest creation, decline form submission with disabled party size (now sends 0), and leaving the RSVP form visible for an invalid/revoked link (now hidden; regression test added).
- Browser-verified deadline lifecycle on 2026-11-03 with an isolated temporary database: past-deadline guest page showed RSVPs closed; API confirmed `canRespond=false` and rejected a write with HTTP 409; host reopen enabled the RSVP form and accepted a household RSVP; host close hid the form again, preserved the existing `yes`/party-of-3 response, and rejected another write with HTTP 409.
- Browser-verified household capacity and response revisions on 2026-11-03: guest was shown the max of 2; entering 3 showed inline validation and blocked submission; valid changes through yes (party 2), maybe (party 1), and no (party 0) saved, with dashboard counts updating to `Yes: 1 / Attending people: 2`, `Maybe: 1`, and `No: 1 / Attending people: 0`. Added visible party-capacity guidance and a custom validation message in the UI.
- Browser/API-verified persistence and host auth on 2026-11-03 using a temporary SQLite database: created a host, event, household guest, and yes/party-of-3 RSVP; stopped and restarted the server with the same DB path; after logging in, event, guest, answer, and totals were intact (`Yes: 1`, `Attending people: 3`). Browser sign-out returned to sign-in; logging in again restored the dashboard. API logout invalidated the prior session (old cookie received 401), while a fresh login retained event/RSVP data.
- The temporary persistence database and server were removed/stopped after verification. Port 3000 remains active for the user's existing local app.
- During the fetch issue, confirmed port 3000 responded normally while port 3001 was not listening; 3001 was a stopped isolated test server. The user-facing port-3000 app remains running. The temporary e2e database/server was stopped and removed afterward.
- The local `v0.1/data/gatherly.sqlite` now reports `setupRequired=false`, so a host account exists. The browser at port 3000 has been reloaded to the host sign-in page; no credentials are recorded here.

## Safety and what is not production-ready

Use synthetic names and reserved test-domain email addresses only. SQLite records and guest bearer links are not encrypted at rest. The local prototype is not a production authentication, privacy, security, availability, or backup solution. There is no HTTPS deployment, production identity provider, actual email sender, backup, or monitoring. Do not use real guest data or deploy this prototype publicly.

No cloud resources or external email provider were provisioned for v0.1.

## Roadmap / next actions

1. **Completed — demo-to-prototype handoff:** root documentation now makes clear that the public demo is localStorage-only and points to the separate, local-only v0.1 prototype for theme editing and server-backed RSVP revisions.
2. **Next milestone — product decisions:** agree on product scope and deployment/operational direction before any deployment or use with real guests. No provider has been selected; do not provision resources. This is a decision milestone, not production implementation or a claim of production readiness.
3. **Before any real guests:** after decisions, plan production privacy/security controls, account recovery, secure link lifecycle, backups, monitoring, data retention/deletion, and consent-aware email delivery. Do not treat the current local code as production-ready.
4. **Keep the public Pages demo unchanged** unless a separate request explicitly scopes demo changes.

## Handoff notes

- The project-plan PDF is a roadmap, not a statement that all listed work has shipped. Some planning material predates the current local prototype.
- When resuming, read this file, then `v0.1/README.md` and the relevant code/tests. Confirm current deployment status rather than assuming a historical URL is live.
- Record new user decisions, implementation changes, and actual test/deployment results here; distinguish verified facts from plans.
