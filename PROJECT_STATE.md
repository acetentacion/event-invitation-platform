# Gatherly project state

**Last updated:** 2026-11-07 (Asia/Manila)
**Purpose:** Durable project handoff for future sessions. Update this file when scope, decisions, implementation, or validation changes.

## Current handoff snapshot (2026-11-07)

The project files and latest work are saved in this workspace. The latest implementation round added timezone-safe RSVP deadlines, capacity-aware walk-ins, replacement schedules for postponements, and operational door-list fields. Deadlines are converted from event-zone wall time to UTC with DST gap/overlap validation; legacy offset/Z values remain compatible. Walk-ins block at capacity unless a host confirms an override with a reason. Postponements keep RSVPs open and capture a local update preview. CSV and print outputs include walk-in and check-in state/timestamps. The root static demo remains unchanged, the existing SQLite database was not reset or overwritten, and the full v0.1 suite passes.

### Latest session (2026-11-07) — Organizer-readiness milestone

Implemented and verified in `v0.1/server.js`, `v0.1/persistence.js`, `v0.1/public/app.js`, and `v0.1/test/`:

- Timezone-safe local RSVP deadlines with UTC persistence, explicit timezone display, DST transition validation, and legacy ISO compatibility.
- Capacity-aware synthetic walk-ins with `409` blocking and explicit host override/reason flow.
- Migration-safe postponed replacement schedule fields and automatic local update previews; RSVP and cancellation behavior remain intact.
- Operational CSV and print output with walk-in and check-in timestamps, still host-only.

The full v0.1 test suite passes 42/42, including deadline, walk-in, postponement, export, and UI assertions. JavaScript syntax checks pass for the server, persistence, and public app files. No database reset, commit, or push was performed.

To continue with another coding assistant, open this folder and have it read this file first, then [`v0.1/README.md`](./v0.1/README.md) before changing the prototype. The key latest implementation is in `v0.1/public/app.js`, `v0.1/public/index.html`, `v0.1/public/styles.css`, `v0.1/server.js`, and `v0.1/persistence.js`; tests are in `v0.1/test/`.

This workspace is a Git repository on branch `main` with remote `origin` at `https://github.com/acetentacion/event-invitation-platform.git`. The latest committed changes are on `origin/main`; see the commit history for the latest changes. Agent definitions now live in `agents/` (six: Backend Developer, DevOps Engineer, Engineering Manager, Event Organizer, Frontend Developer, QA Engineer). The `.github/agents/` directory mirrors five of them (no Event Organizer there).

Run the prototype from PowerShell with `Set-Location .\v0.1; npm start`; validate with `Set-Location .\v0.1; npm test`. It uses local SQLite data under `v0.1/data/`; do not reset or overwrite it. The app is for synthetic data, binds to loopback, and sends no email. Do not expose it publicly or enter real guest data. The root static demo is separate and remains unchanged. This workspace has no Git repository at its root, and no commit or deployment was made.

## Latest session (2026-11-07) — Event status and local communication previews

Implemented the next Gatherly milestone in `v0.1`:

- **Event lifecycle:** additive SQLite migration adds `active`, `postponed`, or `cancelled` status plus an optional organizer note. Owner-only status updates preserve publication and all existing RSVP records. Guest invitation routes still require publication, show postponed/cancelled messaging, and reject RSVP writes for cancelled events.
- **Local communication previews:** owner-only `POST /api/events/:id/messages` captures per-recipient previews into a separate additive `local_messages` table. Filters are all, pending/no reply, yes, maybe, and no/declined; revoked guests are excluded by default. The existing outbox view merges invitation and preview captures and labels them by type. No email is sent.
- **UI and tests:** host event cards expose status/note and local preview composers; guest invitations show lifecycle messaging. Focused API, migration, UI, and syntax checks pass, and the full suite is the required final validation.

## Latest session (2026-11-05) — Event Organizer review + Milestone 1 plan

An Event Organizer domain review of Gatherly identified the minimum viable operational set needed before real-guest use: **attendee-level detail, event capacity cap, check-in/attendance, guest communication (reminders/updates/cancellation), and export/print**. These are captured as Milestone 1 (M1.1–M1.5) in the Engineering Manager task plan, with Milestones 2–4 for high/medium/low-priority items and cross-cutting impracticality fixes (C-1…C-5). The full to-do list with agent assignments lives in the Engineering Manager session output.

### Milestone 1.1 — Attendee-level detail (Backend — COMPLETED)

Implemented in `v0.1/persistence.js` and `v0.1/server.js`:

- **Schema:** New `rsvp_attendees` table (`id`, `guest_unit_id`, `name`, `dietary`, `accessibility`, `age_band`, `created_at`) with FK to `guest_units` ON DELETE CASCADE. Migration logic creates the table on existing databases.
- **`saveRsvp()`** now accepts an optional `attendees` array, replaces existing attendee rows on update within a transaction.
- **`attendeesForGuest(guestId)`** query method.
- **`getGuestByToken()`** includes `attendees` array in the guest record.
- **RSVP submit handler** validates: attendees array (max 20), age band (adult/child), no RSVP cannot include attendees, attendees count cannot exceed partySize.
- **`dashboardGuests()`** includes `attendees` per guest unit.
- Persistence tests: **5/5 pass**. API validation test: **passes**.

Frontend (RSVP form attendee fields) and QA tests are spec'd but not yet implemented due to pre-existing uncommitted UI changes breaking `eventDetail` in `server.js`.

Current working-tree note: the sidebar event-switcher and top-bar create-event redesign is present, and the test harness now matches the attendee table, attendee-aware RSVP payloads, and current workspace controls. The accidental `eventDetail` removal was restored. The full v0.1 suite passes 31/31 tests.

### Agent roster (updated)
Six agents in `agents/`: Backend Developer, DevOps Engineer, Engineering Manager, Event Organizer, Frontend Developer, QA Engineer. `.github/agents/` mirrors the first five.

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
- **Bulk guest creation:** hosts can paste up to 100 tab-separated guest rows at once. The server validates every row before capturing any invitations; a single invalid row rejects the entire batch atomically. Each guest unit and its local outbox message are created in one transaction. A bulk composer UI (`Bulk invite` button) renders a textarea, live preview, and a link-collection panel that surfaces each generated RSVP link with copy buttons and toast feedback.
- **Guest invite-link retrieval:** `GET /api/guests/:id/invite-link` returns the retained RSVP URL stored in `guest_units.invite_url` for a guest unit owned by the host. Legacy rows with an empty URL are backfilled only from their own single canonical invitation outbox record after matching guest/event identity and token hash; request-time recovery persists the same safe result. It returns 404 for unknown/other-host/missing links, 410 for revoked links, and 422 with `LEGACY_INVITE_UNRECOVERABLE` when an old link cannot be proven safe. The outbox is a bounded legacy recovery source, not the source of truth for new links.
- **Event scheduling and capacity:** Hosts can update title, date, required start time, optional end time, IANA timezone, location, RSVP deadline, and optional event capacity through `PUT /api/events/:id`; timing columns migrate safely as nullable fields so existing date-only records remain valid. Schedule fields are shown in host summaries and guest invitations, while RSVP deadline behavior is unchanged. Draft token routes return a non-success response until the event is published.
- **Organizer operations:** Authenticated hosts can download `/api/events/:id/export` as CSV with guest unit, RSVP, attendee, dietary, accessibility, age-band, revoked, and update-time fields. The host dashboard also provides a print mode for an offline-readable door/catering list. Guest routes have no export or print access.
- **Duplicate-email guard:** `guest_units` now carries `UNIQUE(event_id, email)`. Both the single-guest and bulk endpoints check for an existing guest unit with the same email on the same event before creating anything; the bulk endpoint also rejects duplicate emails within the same batch.
- **RSVP writes are transactional:** `saveRsvp` runs inside `BEGIN IMMEDIATE`/`COMMIT` and verifies the guest unit exists before upserting, so a failed write cannot leave a partial row.
- **Mobile RSVP layout:** the `.rsvp-choices` grid collapses to a single column at `max-width: 460px`, matching the root demo. Previously the three-choice radio grid overflowed horizontally at 320–430px.
- **Sidebar cleanup:** the `customize-invitation-toggle` sidebar nav item was a hidden remote control that programmatically clicked the first event card's theme toggle. It was removed; the per-card "Customize invitation" toggle is the canonical control.
- Theme editor/API implementation is complete. Theme settings persist per event and render on the guest RSVP page. The agreed shape is classic/garden/midnight/custom preset; primary/background/text hex colors; serif/sans font; optional PNG/JPEG/WebP cover image with 1 MiB decoded limit. The editor blocks text/background contrast below 4.5:1, and the server independently validates the same WCAG AA threshold. Older saved low-contrast text colors are displayed with a readable fallback.
- Invitation image-in-shape is implemented separately from the full cover image. Invitation copy now safely persists an optional PNG/JPEG/WebP image (1 MiB decoded limit), `circle`/`rounded-square`/`square`/`arch` shape, and optional alt text; legacy six-field copy records default to no image and circle. The editor previews uploads live, and guest rendering uses semantic image markup with decorative behavior when alt text is blank.
- **Invitation presentation settings** now include `revealMotion` (`none` | `fade` | `slide-up`) and `celebration` (`off` | `sparkle` | `leaves`) in addition to `revealMode` and `chimeEnabled`. The editor exposes reveal-motion and celebration-accent selects; the guest invitation applies fade/slide-up animations and optional sparkle/falling-leaves overlays. Reduced-motion visitors get `animation: none` for all decorative effects. The chime control is now labelled "Play gentle background music"; the audio control is hidden in the theme preview.
- The v0.1 UI now follows the root demo's warm paper/botanical palette, editorial serif and sans typography, Gatherly mark, and invitation styling while retaining the local-only warning and functional host/guest workflows. The root demo remains unchanged.
- The published-event workflow now explains the local-only next step: create a guest unit to generate a private RSVP link and view its captured invitation in the local outbox; it explicitly states no email is sent. Empty guest lists offer an "Add first guest unit" action.
- The v0.1 guest invitation now follows the root demo's editorial card layout: Gatherly mark, botanical details, formatted event/date/location/deadline/capacity, accessible RSVP choice cards, and a thank-you/update state. It uses the real API guest identity/theme and preserves the existing RSVP submission contract.
- The v0.1 host view now uses an event-first workspace dashboard inspired by the landing demo: sidebar navigation, event overview/actions, response-summary cards, a dedicated guest-list panel, and a secondary event-creation section. Existing local workflows and disclosures remain available.
- The create-event form is now collapsible (hidden by default, opened via the "Create event" button or the sidebar "Create event" nav item, and re-hidden on submit or cancel). The empty-events state shows a "Create your first event" button.
- The guest table now uses a fixed column layout with `table-layout: fixed` at desktop widths and a responsive grid with `data-label` cell annotations at mobile widths, replacing the previous horizontal-scroll behavior.

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

- The complete v0.1 suite passes 39/39 after the event-day milestone, including household and attendee check-in, duplicate/reversal handling, synthetic walk-ins, ownership and cancellation checks, live totals, migration-safe persistence, and UI check-in controls. JavaScript syntax checks pass for every `v0.1` JavaScript file.
- The `.github/agents/` directory was added with five agent definition files (Backend Developer, DevOps Engineer, Engineering Manager, Frontend Developer, QA Engineer). These are configuration files for the Kilo agent system, not application code.
- The local `v0.1/data/gatherly.sqlite` reports `setupRequired=false`, so a host account exists. The browser at port 3000 has been reloaded to the host sign-in page; no credentials are recorded here.

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
