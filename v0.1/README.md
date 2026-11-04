# Gatherly v0.1 — local shared RSVP slice

This runnable vertical slice is isolated from the public static demo in the repository root.
It uses Node.js built-ins and SQLite; there are no external services or dependencies.

## Current scope

- First-run local host setup with scrypt password hashes and cookie sessions.
- Event creation with individual or household/group RSVP mode.
- Draft/published event status and a host publish control.
- Unique, revocable bearer links; household party limits are checked by the server. Each guest unit stores its RSVP URL in `guest_units.invite_url`, so `GET /api/guests/:id/invite-link` reads the retained link directly (404 for unknown or other-host guests, 410 if revoked). The outbox body is a captured message, not the source of truth for the link.
- Hosts can paste up to 100 tab-separated guest rows at once; each RSVP link and local outbox message is created atomically after validation. A single invalid row rejects the entire batch. Duplicate emails within a batch or against an existing guest unit for the same event are rejected.
- Guests can submit or revise yes/no/maybe and party size.
- Server-enforced deadline closure and explicit host reopen/close.
- Dashboard counts reflect the latest persisted RSVP, including attending people.
- Invitation email content goes to a SQLite-backed local outbox. Nothing is sent.
- Event themes persist in SQLite with classic defaults, owner-only updates, and theme data in authenticated event and guest invitation reads. Optional PNG, JPEG, or WebP base64 cover images are limited to 1 MiB decoded; no image is uploaded to a cloud service.
- Invitation presentation settings persist per event with owner-only updates. The default is direct reveal with reveal motion `none`, celebration `off`, and the optional built-in chime disabled. Reveal motion accepts `none`, `fade`, or `slide-up`; celebration accepts `off`, `sparkle`, or `leaves`. Falling leaves and sparkle are decorative and disabled for visitors who prefer reduced motion. The chime setting only enables a built-in generated chime; no uploaded or third-party audio is used by this backend contract.
- Relational records persist in SQLite behind `persistence.js`.

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
