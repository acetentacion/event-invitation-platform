# Gatherly — event invitation platform concept

A standalone, static concept landing page for a flexible event invitation and guest-management product. This is a new project, separate from the christening invitation site.

## Run locally

Open `index.html` in a browser. No build step, package installation, backend, or account is required.

The page includes an interactive dashboard mockup with guest filters and search, a sample-guest form, and a guest invitation page with an account-free RSVP flow. The landing page's **Start the guided demo** link opens a short walkthrough:

1. In the host dashboard, preview the guest invitation. **Share invite** copies/shares the static `#invite` demo URL only; it does not deliver an invitation or include guest data.
2. On the invitation, enter any fictional name, choose a reply, and submit the RSVP.
3. Use **Return to host dashboard** to see the response in the guest list and updated counts.

All event and guest details are fictional. Guest edits and RSVP replies are stored in this browser's `localStorage` only. They are never sent or shared with a host or another visitor and are not synced across devices. Use **Reset demo data** in the host dashboard to restore the starter guest list and clear the saved demo RSVP for this browser. The reset asks for confirmation before changing anything.

## Free hosting for a client demo

This project is designed for a zero-cost presentation workflow. The simplest option is GitHub Pages:

1. Create a public GitHub repository and push the project files.
2. In the repo settings, go to Pages.
3. Select the default branch and the root folder (`/`).
4. Save the setting and wait for the Pages URL to be generated.
5. Share the published URL with the client.

This gives you a free, static demo site that clients can explore themselves and that the team can also present live, without hosting fees. No backend, account system, paid service, or build step is required.

## Product caveats

Gatherly is a working brand name for the concept. Product scope, pricing, dates, locations, and sample guest data are placeholders. The guest invitation and RSVP are a client-presentation prototype only; there is no authentication, real invitation delivery, messaging, or shared RSVP backend. Responses exist only in the same browser and site origin where they were entered, so they cannot be viewed by another visitor. It is intentionally a static prototype for early client validation and presentation.
