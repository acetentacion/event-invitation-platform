(function () {
  "use strict";

  // ---------- Storage keys ----------
  var EVENTS_STORAGE_KEY = "gatherly-demo-events";
  var RSVP_STORAGE_KEY = "gatherly-demo-invitation-rsvp";
  var storageUnavailable = false;

  // ---------- Default guests (shared template) ----------
  var defaultGuests = [
    { name: "Olivia Chen", group: "Family", party: 2, status: "attending", color: "OC" },
    { name: "Noah Williams", group: "Friends", party: 1, status: "attending", color: "NW" },
    { name: "Mia Patel", group: "Family", party: 3, status: "attending", color: "MP" },
    { name: "Ethan Brooks", group: "Neighbors", party: 2, status: "attending", color: "EB" },
    { name: "Sofia Martinez", group: "Friends", party: 1, status: "declined", color: "SM" },
    { name: "Grace Kim", group: "Family", party: 2, status: "attending", color: "GK" },
    { name: "Leo Thompson", group: "Friends", party: 2, status: "attending", color: "LT" },
    { name: "Ava Robinson", group: "Neighbors", party: 1, status: "attending", color: "AR" },
    { name: "Isabella Reed", group: "Family", party: 2, status: "attending", color: "IR" },
    { name: "James Parker", group: "Friends", party: 1, status: "declined", color: "JP" },
    { name: "Amir Hassan", group: "Family", party: 3, status: "attending", color: "AH" },
    { name: "Charlotte Lee", group: "Friends", party: 2, status: "attending", color: "CL" },
    { name: "Lucas Martin", group: "Neighbors", party: 1, status: "attending", color: "LM" },
    { name: "Harper Scott", group: "Family", party: 2, status: "pending", color: "HS" },
    { name: "Benjamin Clark", group: "Friends", party: 2, status: "attending", color: "BC" },
    { name: "Ella Nguyen", group: "Family", party: 1, status: "declined", color: "EN" },
    { name: "Henry Adams", group: "Neighbors", party: 3, status: "attending", color: "HA" },
    { name: "Lily Cooper", group: "Friends", party: 2, status: "pending", color: "LC" },
    { name: "Jack Rivera", group: "Family", party: 1, status: "attending", color: "JR" },
    { name: "Zoe Mitchell", group: "Friends", party: 2, status: "pending", color: "ZM" },
    { name: "Mateo Flores", group: "Family", party: 2, status: "attending", color: "MF" },
    { name: "Chloe Bennett", group: "Friends", party: 1, status: "pending", color: "CB" },
    { name: "Oliver James", group: "Neighbors", party: 2, status: "attending", color: "OJ" },
    { name: "Aria Turner", group: "Family", party: 2, status: "pending", color: "AT" },
    { name: "Daniel Morris", group: "Friends", party: 2, status: "attending", color: "DM" },
    { name: "Layla Price", group: "Family", party: 3, status: "pending", color: "LP" },
    { name: "Theo Bailey", group: "Friends", party: 1, status: "attending", color: "TB" },
    { name: "Nina Foster", group: "Neighbors", party: 2, status: "pending", color: "NF" },
    { name: "Caleb Ward", group: "Family", party: 2, status: "attending", color: "CW" },
    { name: "Ruby Hughes", group: "Friends", party: 1, status: "pending", color: "RH" },
    { name: "Miles Perry", group: "Family", party: 2, status: "attending", color: "MP" },
    { name: "Stella Long", group: "Friends", party: 3, status: "pending", color: "SL" },
    { name: "Eli Sanders", group: "Neighbors", party: 2, status: "attending", color: "ES" },
    { name: "Violet Ross", group: "Family", party: 2, status: "pending", color: "VR" },
    { name: "Finn Bailey", group: "Friends", party: 1, status: "attending", color: "FB" },
    { name: "Hazel Perry", group: "Family", party: 2, status: "pending", color: "HP" },
    { name: "Owen Gray", group: "Friends", party: 1, status: "attending", color: "OG" },
    { name: "Isla Bell", group: "Family", party: 2, status: "attending", color: "IB" }
  ];

  function freshGuests() {
    return defaultGuests.map(function (guest) { return Object.assign({}, guest); });
  }

  // ---------- Default events ----------
  var DEFAULT_EVENTS = [
    {
      id: "amelia-bday-2027",
      name: "Amelia\u2019s first trip around the sun",
      date: "Sunday, June 13, 2027 \u00b7 2:00\u20135:00 PM",
      rsvpDeadline: "Please reply by June 1",
      location: "The Willow House \u00b7 Portland, Oregon",
      note: "Garden party attire \u00b7 Little ones welcome",
      intro: "Our little sunshine is turning one! Join us for a lovely afternoon in the garden with good food, sweet treats, and our favorite people.",
      guests: freshGuests()
    },
    {
      id: "sarah-tom-wedding-2027",
      name: "Sarah & Tom",
      date: "Saturday, September 2, 2027 \u00b7 4:00 PM",
      rsvpDeadline: "Please reply by August 5",
      location: "The Greenhouse Barn \u00b7 Hood River, Oregon",
      note: "Garden formal \u00b7 Kids welcome",
      intro: "We cannot wait to celebrate with you. There will be dinner, dancing, and a whole lot of love under the string lights.",
      guests: [
        { name: "Maya Patel", group: "Family", party: 2, status: "attending", color: "MP" },
        { name: "Diego Ramos", group: "Friends", party: 1, status: "pending", color: "DR" },
        { name: "Lena Choi", group: "Family", party: 3, status: "attending", color: "LC" },
        { name: "Samir Haddad", group: "Work", party: 1, status: "declined", color: "SH" },
        { name: "Priya Nair", group: "Family", party: 2, status: "attending", color: "PN" }
      ]
    }
  ];

  function freshDefaultEvents() {
    return DEFAULT_EVENTS.map(function (event) {
      return Object.assign({}, event, { guests: freshGuestsFrom(event.guests) });
    });
  }

  function freshGuestsFrom(template) {
    return (template || []).map(function (guest) { return Object.assign({}, guest); });
  }
  // ---------- Storage helpers ----------
  function loadEvents() {
    try {
      var saved = window.localStorage.getItem(EVENTS_STORAGE_KEY);
      if (!saved) return freshDefaultEvents();
      var parsed = JSON.parse(saved);
      if (!Array.isArray(parsed) || !parsed.length) return freshDefaultEvents();
      return parsed;
    } catch (error) {
      storageUnavailable = true;
      return freshDefaultEvents();
    }
  }

  function saveEvents() {
    try {
      window.localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(events));
      return true;
    } catch (error) {
      storageUnavailable = true;
      return false;
    }
  }

  function loadRsvp() {
    try {
      var saved = window.localStorage.getItem(RSVP_STORAGE_KEY);
      if (!saved) return null;
      var response = JSON.parse(saved);
      if (!response || typeof response.name !== "string" || !response.name.trim() ||
          !Number.isInteger(response.party) || response.party < 1 || response.party > 10 ||
          ["attending", "declined", "pending"].indexOf(response.status) === -1) return null;
      return response;
    } catch (error) {
      storageUnavailable = true;
      return null;
    }
  }

  function saveRsvp(response) {
    try {
      window.localStorage.setItem(RSVP_STORAGE_KEY, JSON.stringify(response));
      return true;
    } catch (error) {
      storageUnavailable = true;
      return false;
    }
  }

  // ---------- Event model ----------
  var events = loadEvents();
  var activeEventId = events[0] ? events[0].id : null;
  var activeFilter = "all";
  var visibleLimit = 5;
  var toastTimer;
  var nextEventId = 1;

  function currentEvent() {
    return events.find(function (event) { return event.id === activeEventId; }) || events[0];
  }

  function currentGuests() {
    return currentEvent().guests;
  }

  function counts() {
    return currentGuests().reduce(function (total, guest) {
      total[guest.status] += 1;
      return total;
    }, { attending: 0, pending: 0, declined: 0 });
  }

function makeCell(text) {
    var cell = document.createElement("td");
    cell.textContent = text;
    return cell;
  }

  // ---------- DOM references ----------
  var guestList = document.getElementById("guest-list");
  var filterButtons = document.querySelectorAll("[data-filter]");
  var searchInput = document.getElementById("guest-search");
  var guestDialog = document.getElementById("guest-dialog");
  var guestForm = document.getElementById("guest-form");
  var invitationSection = document.getElementById("guest-invitation");
  var invitationForm = document.getElementById("invitation-rsvp-form");
  var rsvpConfirmation = document.getElementById("rsvp-confirmation");

  // ---------- Render ----------
  function render() {
    var statusCounts = counts();
    var query = searchInput.value.trim().toLocaleLowerCase();
    var guestListData = currentGuests();
    var filtered = guestListData.filter(function (guest) {
      var matchesFilter = activeFilter === "all" || guest.status === activeFilter;
      var matchesSearch = !query || [guest.name, guest.group, guest.status,
        guest.status === "pending" ? "awaiting" : ""].join(" ").toLocaleLowerCase().indexOf(query) !== -1;
      return matchesFilter && matchesSearch;
    });
    var shown = filtered.slice(0, visibleLimit);
    guestList.replaceChildren();

    shown.forEach(function (guest) {
      var row = document.createElement("tr");
      var nameCell = document.createElement("td");
      var guestCell = document.createElement("span");
      var avatar = document.createElement("span");
      var responseCell = document.createElement("td");
      var pill = document.createElement("span");
      var label = guest.status === "attending" ? "Attending" :
        guest.status === "declined" ? "Declined" : "Awaiting";
      guestCell.className = "guest-cell";
      avatar.className = "guest-avatar";
      avatar.textContent = guest.color;
      guestCell.appendChild(avatar);
      guestCell.appendChild(document.createTextNode(guest.name));
      nameCell.appendChild(guestCell);
      nameCell.setAttribute("data-label", "Guest");
      row.appendChild(nameCell);
      var groupCell = makeCell(guest.group);
      groupCell.setAttribute("data-label", "Group");
      row.appendChild(groupCell);
      var partyCell = makeCell(guest.party + (guest.party === 1 ? " guest" : " guests"));
      partyCell.setAttribute("data-label", "Party size");
      row.appendChild(partyCell);
      pill.className = "response-pill" + (guest.status === "pending" ? " response-pill--pending" :
        guest.status === "declined" ? " response-pill--declined" : "");
      pill.textContent = label;
      responseCell.setAttribute("data-label", "Response");
      responseCell.appendChild(pill);
      row.appendChild(responseCell);
      guestList.appendChild(row);
    });

    document.getElementById("invited-count").textContent = guestListData.length;
    document.getElementById("attending-count").textContent = statusCounts.attending;
    document.getElementById("pending-count").textContent = statusCounts.pending;
    document.getElementById("declined-count").textContent = statusCounts.declined;
    document.getElementById("guest-range").textContent = filtered.length ?
      "Showing 1 to " + shown.length + " of " + filtered.length + " guests" : "No guests in this view";
    document.getElementById("view-all-button").hidden = filtered.length <= 5 || visibleLimit >= filtered.length;
    var empty = document.getElementById("guest-empty");
    empty.hidden = filtered.length !== 0;
    document.getElementById("guest-empty-title").textContent = guestListData.length === 0 ? "No guests yet" :
      (query ? "No matching guests" : "No guests in this filter");
    document.getElementById("guest-empty-copy").textContent = guestListData.length === 0 ?
      "Add a sample guest to see them here." : (query ? "Try another name, group, or response." : "Choose another response filter to see guests.");

    filterButtons.forEach(function (button) {
      var active = button.dataset.filter === activeFilter;
      button.classList.toggle("filter-tab--active", active);
      button.setAttribute("aria-pressed", String(active));
      var labelMap = { all: "Everyone", attending: "Attending", pending: "Awaiting", declined: "Declined" };
      var count = button.dataset.filter === "all" ? guestListData.length : statusCounts[button.dataset.filter];
      button.replaceChildren(document.createTextNode(labelMap[button.dataset.filter] + " "));
      var countNode = document.createElement("span");
      if (button.dataset.filter === "all") countNode.id = "filter-all-count";
      countNode.textContent = count;
      button.appendChild(countNode);
    });

    renderEventSwitcher();
    renderInvitation();
  }

  function renderEventSwitcher() {
    var select = document.getElementById("event-switch");
    if (!select) return;
    var previousValue = select.value;
    select.replaceChildren();
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = events.length ? "Switch event..." : "No events";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    events.forEach(function (event) {
      var option = document.createElement("option");
      option.value = event.id;
      option.textContent = event.name;
      select.appendChild(option);
    });
    select.value = previousValue && events.some(function (e) { return e.id === previousValue; }) ? previousValue : activeEventId;
  }

  function renderInvitation() {
    var event = currentEvent();
    var title = document.getElementById("invitation-title");
    if (title) title.innerHTML = event.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    var dateEl = document.getElementById("invitation-date");
    if (dateEl) dateEl.textContent = event.date;
    var deadlineEl = document.getElementById("invitation-rsvp-deadline");
    if (deadlineEl) deadlineEl.textContent = event.rsvpDeadline;
    var locationEl = document.getElementById("invitation-location");
    if (locationEl) locationEl.textContent = event.location;
    var noteEl = document.getElementById("invitation-note");
    if (noteEl) noteEl.textContent = event.note;
    var introEl = document.getElementById("invitation-intro");
    if (introEl) introEl.textContent = event.intro;
    var heading = document.querySelector(".guest-invitation__rsvp-heading h2");
    if (heading) heading.textContent = "Will you be there?";
  }

  function showToast(message) {
    var toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 3000);
  }
// ---------- Event switcher ----------
  function switchEvent(eventId) {
    if (eventId === activeEventId) return;
    activeEventId = eventId;
    activeFilter = "all";
    visibleLimit = 5;
    if (searchInput) searchInput.value = "";
    render();
    showToast("Now viewing: " + currentEvent().name);
  }

  var eventSwitch = document.getElementById("event-switch");
  if (eventSwitch) {
    eventSwitch.addEventListener("change", function () {
      switchEvent(eventSwitch.value);
    });
  }

  // ---------- Filter + search ----------
  filterButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      activeFilter = button.dataset.filter;
      visibleLimit = 5;
      render();
    });
  });

  if (searchInput) {
    searchInput.addEventListener("input", function () {
      visibleLimit = 5;
      render();
    });
  }

  document.getElementById("view-all-button").addEventListener("click", function () {
    visibleLimit = currentGuests().length;
    render();
  });

  // ---------- Reset demo ----------
  document.getElementById("reset-demo-button").addEventListener("click", function () {
    var confirmed = window.confirm(
      "Reset this browser\u2019s Gatherly demo? This restores the fictional starter guest list and clears the saved demo RSVP."
    );
    if (!confirmed) return;

    events = freshDefaultEvents();
    activeEventId = events[0].id;
    activeFilter = "all";
    visibleLimit = 5;
    if (searchInput) searchInput.value = "";
    var resetSaved = true;
    try {
      window.localStorage.removeItem(EVENTS_STORAGE_KEY);
    } catch (error) {
      resetSaved = false;
    }
    try {
      window.localStorage.removeItem(RSVP_STORAGE_KEY);
    } catch (error) {
      resetSaved = false;
    }
    storageUnavailable = !resetSaved;
    render();
    showToast(resetSaved ?
      "Starter guests restored and the demo RSVP cleared in this browser." :
      "Demo reset for this visit, but browser storage is unavailable.");
  });

  // ---------- Add event ----------
  function openEventDialog(prefill) {
    prefill = prefill || {};
    var dialog = document.getElementById("event-dialog");
    if (!dialog) return;
    document.getElementById("event-name").value = prefill.name || "";
    document.getElementById("event-date").value = prefill.date || "";
    document.getElementById("event-deadline").value = prefill.rsvpDeadline || "";
    document.getElementById("event-location").value = prefill.location || "";
    document.getElementById("event-note").value = prefill.note || "";
    document.getElementById("event-intro").value = prefill.intro || "";
    dialog.showModal();
    document.getElementById("event-name").focus();
  }

  function closeEventDialog() {
    var dialog = document.getElementById("event-dialog");
    if (dialog) dialog.close();
  }
  var closeEventBtn = document.getElementById("close-event-dialog");
  if (closeEventBtn) closeEventBtn.addEventListener("click", closeEventDialog);
  var cancelEventBtn = document.getElementById("cancel-event");
  if (cancelEventBtn) cancelEventBtn.addEventListener("click", closeEventDialog);

  var addEventButton = document.getElementById("add-event-button");
  if (addEventButton) {
    addEventButton.addEventListener("click", function () { openEventDialog(); });
  }

  var eventForm = document.getElementById("event-form");
  if (eventForm) {
    eventForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!eventForm.reportValidity()) return;
      var formData = new FormData(eventForm);
      var name = String(formData.get("name")).trim();
      var date = String(formData.get("date")).trim();
      var deadline = String(formData.get("rsvpDeadline")).trim();
      var location = String(formData.get("location")).trim();
      var note = String(formData.get("note")).trim();
      var intro = String(formData.get("intro")).trim();
      if (!name) return;
      var newEvent = {
        id: "event-" + (nextEventId++) + "-" + Date.now().toString(36),
        name: name,
        date: date,
        rsvpDeadline: deadline,
        location: location,
        note: note,
        intro: intro,
        guests: []
      };
      events.unshift(newEvent);
      var saved = saveEvents();
      switchEvent(newEvent.id);
      eventForm.reset();
      closeEventDialog();
      showToast(saved ? "Event added. Start adding guests." : "Event added for this session; storage unavailable.");
    });
  }

// ---------- Add guest ----------
  document.getElementById("add-guest-button").addEventListener("click", function () {
    if (!events.length) { showToast("Create an event first."); return; }
    guestDialog.showModal();
    guestForm.elements.name.focus();
  });

  function closeGuestDialog() {
    guestDialog.close();
  }
  document.getElementById("close-guest-dialog").addEventListener("click", closeGuestDialog);
  document.getElementById("cancel-guest").addEventListener("click", closeGuestDialog);

  guestForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!guestForm.reportValidity()) return;
    var formData = new FormData(guestForm);
    var name = String(formData.get("name")).trim();
    var group = String(formData.get("group")).trim();
    if (!name || !group) return;
    currentGuests().unshift({
      name: name,
      group: group,
      party: Math.max(1, Math.min(20, Number(formData.get("party")) || 1)),
      status: ["attending", "pending", "declined"].indexOf(formData.get("status")) !== -1 ? formData.get("status") : "pending",
      color: name.split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0); }).join("").toLocaleUpperCase()
    });
    activeFilter = "all";
    if (searchInput) searchInput.value = "";
    visibleLimit = 5;
    var guestSaved = saveEvents();
    render();
    guestForm.reset();
    closeGuestDialog();
    showToast(guestSaved ? "Sample guest added. Saved only in this browser." :
      "Sample guest added for this session; browser storage is unavailable.");
  });
  // ---------- Share ----------
  document.getElementById("share-button").addEventListener("click", function () {
    var shareUrl = window.location.href.split("#")[0] + "#invite";
    var label = document.getElementById("share-label");
    var button = document.getElementById("share-button");
    function feedback(message, buttonLabel) {
      label.textContent = buttonLabel || "Link copied";
      showToast(message || "Guest invitation preview link copied. RSVP is a local demo only.");
      window.setTimeout(function () { label.textContent = "Share invite"; }, 2500);
    }
    function legacyCopy() {
      var input = document.createElement("textarea");
      input.value = shareUrl;
      input.setAttribute("readonly", "");
      input.setAttribute("aria-hidden", "true");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      var didCopy = false;
      try { didCopy = document.execCommand("copy"); } catch (error) { didCopy = false; }
      input.remove();
      if (didCopy) feedback();
      else showToast("Could not copy automatically. Use your browser address bar to share this demo.");
    }
    function copyLink() {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(shareUrl).then(feedback).catch(legacyCopy);
      }
      legacyCopy();
      return Promise.resolve();
    }
    button.disabled = true;
    var sharing = navigator.share ? Promise.resolve().then(function () {
      return navigator.share({
        title: currentEvent().name,
        text: "You\u2019re invited to " + currentEvent().name + ". Open this link to see the details and try the demo RSVP.",
        url: shareUrl
      });
    }).then(function () {
      feedback("Guest invitation preview shared. No real message or RSVP was sent.", "Shared");
    }).catch(function (error) {
      if (error && error.name === "AbortError") return;
      return copyLink();
    }) : copyLink();
    Promise.resolve(sharing).catch(function () {
      showToast("Could not share automatically. You can copy the demo address from your browser.");
    }).then(function () { button.disabled = false; });
  });

  // ---------- RSVP ----------
  function showSavedRsvp() {
    var saved = loadRsvp();
    if (!saved) {
      invitationForm.hidden = false;
      rsvpConfirmation.hidden = true;
      return;
    }
    document.getElementById("rsvp-name").value = saved.name;
    document.getElementById("rsvp-party").value = saved.party;
    var selected = invitationForm.querySelector('input[name="status"][value="' + saved.status + '"]');
    if (selected) selected.checked = true;
    var responseText = saved.status === "attending" ? "We can\u2019t wait to see you there!" :
      saved.status === "declined" ? "Thanks for letting us know. You\u2019ll be missed!" :
        "Thanks! Your reply is marked as maybe for now.";
    document.getElementById("rsvp-confirmation-title").textContent = "Thanks, " + saved.name + "!";
    document.getElementById("rsvp-confirmation-copy").textContent =
      responseText + " Party size: " + saved.party + ". This response is saved only in this browser.";
    invitationForm.hidden = true;
    rsvpConfirmation.hidden = false;
  }

  function updateViewFromHash() {
    var isInvitation = window.location.hash === "#invite";
    var wasInvitation = document.body.dataset.view === "invitation";
    document.body.dataset.view = isInvitation ? "invitation" : "site";
    invitationSection.hidden = !isInvitation;
    if (isInvitation) {
      showSavedRsvp();
      renderInvitation();
      window.scrollTo(0, 0);
    } else if (wasInvitation) {
      var targetId = window.location.hash.slice(1);
      var returnTarget = targetId && document.getElementById(targetId);
      window.requestAnimationFrame(function () {
        (returnTarget || document.getElementById("demo")).scrollIntoView();
      });
    }
  }

  invitationForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!invitationForm.reportValidity()) return;
    var formData = new FormData(invitationForm);
    var name = String(formData.get("name")).trim();
    var party = Number(formData.get("party"));
    var status = String(formData.get("status"));
    if (!name || !Number.isInteger(party) || party < 1 || party > 10 ||
        ["attending", "declined", "pending"].indexOf(status) === -1) return;

    var response = { name: name, party: party, status: status };
    var existingGuest = currentGuests().find(function (guest) {
      return guest.name.toLocaleLowerCase() === name.toLocaleLowerCase();
    });
    if (existingGuest) {
      existingGuest.party = party;
      existingGuest.status = status;
    } else {
      currentGuests().unshift({
        name: name,
        group: "Invitation link",
        party: party,
        status: status,
        color: name.split(/\s+/).slice(0, 2).map(function (part) {
          return part.charAt(0);
        }).join("").toLocaleUpperCase()
      });
    }
    var guestSaved = saveEvents();
    var responseSaved = saveRsvp(response);
    render();
    document.getElementById("rsvp-confirmation-title").textContent = "Thanks, " + name + "!";
    document.getElementById("rsvp-confirmation-copy").textContent = status === "attending" ?
      "We can\u2019t wait to see you there! Party size: " + party + "." :
      status === "declined" ? "Thanks for letting us know. You\u2019ll be missed!" :
        "Thanks! Your reply is marked as maybe for now.";
    if (!guestSaved || !responseSaved) {
      document.getElementById("rsvp-confirmation-copy").textContent +=
        " Browser storage is unavailable, so this demo response may not remain after you leave.";
    } else {
      document.getElementById("rsvp-confirmation-copy").textContent +=
        " This is a local demo response; it was not sent to a host.";
    }
    invitationForm.hidden = true;
    rsvpConfirmation.hidden = false;
    rsvpConfirmation.querySelector("h3").focus();
  });

  document.getElementById("edit-rsvp").addEventListener("click", function () {
    invitationForm.hidden = false;
    rsvpConfirmation.hidden = true;
    document.getElementById("rsvp-name").focus();
  });

  // ---------- Mobile nav ----------
  window.addEventListener("hashchange", updateViewFromHash);

  var menuToggle = document.querySelector(".menu-toggle");
  var mobileNav = document.getElementById("mobile-nav");
  menuToggle.addEventListener("click", function () {
    var isExpanded = menuToggle.getAttribute("aria-expanded") === "true";
    menuToggle.setAttribute("aria-expanded", String(!isExpanded));
    menuToggle.setAttribute("aria-label", isExpanded ? "Open menu" : "Close menu");
    mobileNav.hidden = isExpanded;
  });

  mobileNav.addEventListener("click", function (event) {
    if (event.target.closest("a")) {
      mobileNav.hidden = true;
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Open menu");
    }
  });

  // ---------- Init ----------
  render();
  updateViewFromHash();
  if (storageUnavailable) {
    showToast("Browser storage is unavailable. Demo changes may not remain after you leave this page.");
  }
})();
