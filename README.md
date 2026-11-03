# Gatherly — event invitation platform concept

A standalone, static concept landing page for a flexible event invitation and guest-management product. This is a new project, separate from the christening invitation site.

For the durable roadmap, project decisions, and current implementation handoff, see [PROJECT_STATE.md](./PROJECT_STATE.md). The local v0.1 prototype is separate and documented in [`v0.1/README.md`](./v0.1/README.md); it is not part of this static site.

## Run locally

Open `index.html` in a browser. No build step, package installation, backend, or account is required.

The page includes an interactive dashboard mockup with guest filters and search, a sample-guest form, and a guest invitation page with an account-free RSVP flow. The landing page's **Start the guided demo** link opens a short walkthrough:

1. In the host dashboard, preview the guest invitation. **Share invite** copies/shares the static `#invite` demo URL only; it does not deliver an invitation or include guest data.
2. On the invitation, enter any fictional name, choose a reply, and submit the RSVP.
3. Use **Return to host dashboard** to see the response in the guest list and updated counts.

All event and guest details are fictional. The root demo is localStorage-only: it has no persistent shared data, account authentication, theme editor, or server-backed RSVP edits. Guest edits and RSVP replies stay in this browser; they are never sent or shared with a host or another visitor and are not synced across devices. Use **Reset demo data** in the host dashboard to restore the starter guest list and clear the saved demo RSVP for this browser. The reset asks for confirmation before changing anything.

## Free hosting for a client demo

This project is designed for a zero-cost presentation workflow. The simplest option is GitHub Pages:

1. Create a public GitHub repository and push the project files.
2. In the repo settings, go to Pages.
3. Select the default branch and the root folder (`/`).
4. Save the setting and wait for the Pages URL to be generated.
5. Share the published URL with the client.

This gives you a free, static demo site that clients can explore themselves and that the team can also present live, without hosting fees. No backend, account system, paid service, or build step is required.

## Separate local v0.1 prototype

Theme editing and server-backed RSVP revisions are implemented in the separate local v0.1 prototype, documented in [`v0.1/README.md`](./v0.1/README.md). That prototype is local-only and not production-ready; its workflows are not part of the root static demo.

In v0.1, hosts can:

- Choose a preset theme, adjust colors and fonts, add an optional photo, and preview the invitation.
- Use theme colors that meet the editor/API's WCAG AA text contrast requirement.

Guests can revise their RSVP through their invitation link, subject to the deadline and party-size limit. The host can reopen responses after the deadline. The prototype stores these changes in its local SQLite database; it is not shared or deployed.

## Product caveats

Gatherly is a working brand name for the concept. Product scope, pricing, dates, locations, and sample guest data are placeholders. In the root static demo, the guest invitation and RSVP are for client presentation only: there is no account authentication, real invitation delivery, messaging, or shared RSVP backend. Responses exist only in the same browser and site origin where they were entered, so they cannot be viewed by another visitor. The separate v0.1 prototype has local host authentication and locally persisted workflows, but is not production-ready.
