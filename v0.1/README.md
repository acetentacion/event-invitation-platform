# Gatherly v0.1 — local shared RSVP slice

This runnable vertical slice is isolated from the public static demo in the repository root.
It uses Node.js built-ins and SQLite; there are no external services or dependencies.

## Current scope

- First-run local host setup with scrypt password hashes and cookie sessions.
- Event creation with individual or household/group RSVP mode.
- Draft/published event status and a host publish control.
- Hosts can mark a published event active, postponed, or cancelled with an optional organizer note. Published guest links remain readable; postponed invitations show the note, while cancelled invitations keep existing RSVP records visible to the host and block new RSVP writes.
- Hosts can edit an event's title, date, start time, optional end time, timezone, location, RSVP deadline, and optional capacity from the dashboard. Capacity is enforced against attending RSVP party sizes and exposes remaining places in host event reads. Supported timezones come from the Node runtime's IANA timezone list.
- RSVP deadlines without an offset are interpreted as wall-clock values in the selected event timezone, stored as UTC, and rejected when the timezone is missing or the local time falls in a DST gap/overlap. Legacy ISO timestamps with an explicit offset or `Z` remain accepted. Host and guest displays include timezone context.
- Draft events do not expose usable guest invitation API responses; publish an event before sharing its private RSVP links.
- Unique, revocable bearer links; household party limits are checked by the server. Each guest unit stores its RSVP URL in `guest_units.invite_url`, so `GET /api/guests/:id/invite-link` reads the retained link directly (404 for unknown, other-host, or missing links; 410 if revoked). On startup, legacy rows with an empty retained URL are backfilled only when their own single invitation outbox record matches the guest name, event title/date, recipient when known, canonical invitation subject/body, and token hash. The endpoint repeats that narrowly scoped recovery for rows encountered after startup, persists a successful result, and returns 422 with `LEGACY_INVITE_UNRECOVERABLE` when ownership or identity cannot be proven. The outbox is only a bounded legacy recovery source, not the source of truth for new links.
- Hosts can paste up to 100 tab-separated guest rows at once; each RSVP link and local outbox message is created atomically after validation. A single invalid row rejects the entire batch. Duplicate emails within a batch or against an existing guest unit for the same event are rejected.
- Guests can submit or revise yes/no/maybe and party size.
- Server-enforced deadline closure and explicit host reopen/close.
- Dashboard counts reflect the latest persisted RSVP, including attending people.
- Invitation email content goes to a SQLite-backed local outbox. Nothing is sent.
- Hosts can capture targeted local message previews for all guests, pending/no reply, attending/yes, maybe, or declined recipients. Revoked guests are excluded by default; subjects and messages have sensible local defaults, and no email is sent.
- Event themes persist in SQLite with classic defaults, owner-only updates, and theme data in authenticated event and guest invitation reads. Optional PNG, JPEG, or WebP base64 cover images are limited to 1 MiB decoded; no image is uploaded to a cloud service.
- Invitation presentation settings persist per event with owner-only updates. The default is direct reveal with reveal motion `none`, celebration `off`, and the optional built-in chime disabled. Reveal motion accepts `none`, `fade`, or `slide-up`; celebration accepts `off`, `sparkle`, or `leaves`. Falling leaves and sparkle are decorative and disabled for visitors who prefer reduced motion. The chime setting only enables a built-in generated chime; no uploaded or third-party audio is used by this backend contract.
- Relational records persist in SQLite behind `persistence.js`. The legacy invite URL backfill is idempotent and does not inspect local preview messages or other guests/events.
- Legacy databases whose `guest_units` table predates email support are migrated additively: `email` is added as nullable and existing rows remain `NULL` because historical addresses cannot be safely recovered or inferred. New invitations still require validated synthetic email addresses, and duplicate checks remain enforced for supplied addresses. Legacy rows remain usable through their existing bearer token and RSVP data; an invite URL is recovered only under the strict outbox rule above, otherwise it is reported as unavailable, and such rows are omitted from local message-recipient previews rather than receiving a fabricated identity.
- Hosts can download a CSV guest export containing RSVP and attendee detail, and can open a print-friendly door/catering list from each event card. Both workflows are authenticated host actions; guest invitation routes do not expose them.
- Event-day check-in is available to the authenticated event owner at `GET /api/events/:id/check-in`, `POST /api/events/:id/check-in`, and `POST /api/events/:id/check-in/reverse`. Check in a whole guest unit or a named RSVP attendee, reverse either state, and read live invited, confirmed, checked-in, and walk-in totals. `POST /api/events/:id/check-in/walk-in` registers and checks in a synthetic walk-in attendee. Duplicate active check-ins, cross-event/owner targets, and cancelled-event mutations are rejected.
- Walk-ins consume event capacity. A full event returns `409`; a host can explicitly retry with `override: true` and a reason. The UI confirms the override and asks for the reason. CSV and print door lists include walk-in state and check-in timestamps for units and named attendees.
- Experimental seating drafts are available to the authenticated host at `GET /api/events/:id/seating`, `POST /api/events/:id/seating/plans`, `POST /api/events/:id/seating/plans/:planId/run`, `PUT /api/events/:id/seating/plans/:planId/assignments`, and `POST /api/events/:id/seating/plans/:planId/publish`. Drafts use confirmed named attendees, deterministic heuristic placement, table capacities, round/rectangle/square/banquet top-view shapes, versioned SQLite records, and explicit publish; RSVP and check-in records are never mutated. RSVP changes mark existing plans stale. This feature remains synthetic-data-only and local-only.
- A postponed event can persist a replacement date, start/end time, and IANA timezone in the status request's `replacement` object. RSVPs remain open, guest and host schedule displays use the replacement schedule, and a local update preview is captured for active recipients. Legacy status-only postponement requests remain compatible.
- Check-in state is stored in an additive, reversible `check_ins` table. Existing RSVP and attendee rows are preserved; legacy databases receive the table and a `guest_units.walk_in` marker without rewriting existing records. Walk-ins are synthetic local guest units and do not receive invitation links or email.

The host API accepts a complete theme object at `PUT /api/events/:id/theme`:
`preset`, `primaryColor`, `backgroundColor`, `textColor`, `fontFamily`, and `coverImage`.
Presets are `classic`, `garden`, `midnight`, or `custom`; colors use `#RRGGBB`;
fonts are `serif` or `sans`; `coverImage` is `null` or a PNG/JPEG/WebP base64 data URL.
Text and background colors must meet WCAG AA contrast of at least 4.5:1. The editor warns
and blocks saving when this requirement is not met; the API enforces the same rule.
Older saved themes that do not meet the threshold are displayed with a readable text-color
fallback, and the host editor can save that corrected color back to the event.

The host API accepts exactly `{ "revealMode": "envelope" | "direct", "chimeEnabled": boolean, "revealMotion": "none" | "fade" | "slide-up", "celebration": "off" | "sparkle" | "leaves" }`
at `PUT /api/events/:id/invitation`. The current `invitationSettings` object is returned in
event list/detail and public guest invitation responses. Falling leaves are decorative and
disabled for visitors who prefer reduced motion. The chime setting only enables a built-in
generated chime; no uploaded or third-party audio is used by this backend contract.

Invitation copy is stored separately from presentation settings and is returned as
`invitationCopy` in event and guest invitation reads. Hosts save
`{ "title": string, "intro": string, "rsvpHeading": string, "rsvpHelper": string, "footerNote": string }`
plus the image fields through `PUT /api/events/:id/invitation-copy`. The legacy `greeting`
field remains accepted and returned for saved payload compatibility, but is ignored when
rendering. Greetings are generated as `An invitation for <guest name>`; the host preview
uses `Alex Morgan`. Omitting `greeting` while saving preserves any stored legacy value.
Values are trimmed and limited to 120, 100,
500, 100, 200, and 300 characters respectively. A blank title falls back to the event title;
all copy is rendered as text rather than HTML. The current copy object also includes
`image` (null or a PNG/JPEG/WebP base64 data URL), `imageShape` (`circle`, `rounded-square`,
`square`, or `arch`, default `circle`), and optional `imageAlt` text up to 200 characters.
Invitation images use the same 1 MiB decoded limit as cover images and are independent of
the full invitation cover image. The v0.1 frontend no longer exposes or renders the legacy
theme cover image; the backend field remains accepted and returned so existing data and API
contracts stay compatible. Older six-field copy objects and older two-key invitation settings
remain readable with safe defaults.

## Safety and limitations

Use synthetic names and email addresses only. The prototype is not production-ready and must not be exposed to the public internet or used for real guest data. SQLite records and captured invitation links are not encrypted at rest; this does not provide production privacy. There is no production identity provider, HTTPS deployment, real email delivery, backup, or monitoring. No paid service, cloud resource, or external email provider is configured.

An RSVP URL is a bearer link: anyone who has it can access that guest unit's RSVP. Keep demo links private and revoke the guest link if exposed.

## Run locally

Use Node.js 24 or newer. In PowerShell, start from this directory:

```powershell
npm start
```

Open the printed `http://127.0.0.1:3000` URL. Keep the process running while using the app. The server is loopback-only.

The first host account is created in the sign-in page. Use a fictional address and a unique 12+ character local password. Use the generated link only in local testing.

## Data and reset

Event, host, RSVP, session, and local-outbox records persist at `data/gatherly.sqlite`. Stop the server, then run:

```powershell
npm run reset
```

The reset asks for the exact confirmation `RESET` and removes only that SQLite file and its `-wal` / `-shm` sidecars. It does not touch the repository-root demo. If you set `GATHERLY_DB_PATH`, use the same environment variable for reset.

## Test

Run the API integration tests from this directory:

```powershell
npm test
```

The tests use temporary databases and synthetic records, leaving your local database untouched.

## Not included in v0.1

A production hosting region, production privacy/security controls, a real email provider/sender, deliverability and unsubscribe handling, backups, and monitoring are still undecided or out of scope. No cloud provisioning, deployment, or commit/push is part of this slice.
