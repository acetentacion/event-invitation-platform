(function () {
  'use strict';

  var STORAGE_KEY = 'gatherly-demo-guests';
  var RSVP_STORAGE_KEY = 'gatherly-demo-invitation-rsvp';
  var storageUnavailable = false;
  var defaultGuests = [
    { name: 'Olivia Chen', group: 'Family', party: 2, status: 'attending', color: 'OC' },
    { name: 'Noah Williams', group: 'Friends', party: 1, status: 'attending', color: 'NW' },
    { name: 'Mia Patel', group: 'Family', party: 3, status: 'attending', color: 'MP' },
    { name: 'Ethan Brooks', group: 'Neighbors', party: 2, status: 'attending', color: 'EB' },
    { name: 'Sofia Martinez', group: 'Friends', party: 1, status: 'declined', color: 'SM' },
    { name: 'Grace Kim', group: 'Family', party: 2, status: 'attending', color: 'GK' },
    { name: 'Leo Thompson', group: 'Friends', party: 2, status: 'attending', color: 'LT' },
    { name: 'Ava Robinson', group: 'Neighbors', party: 1, status: 'attending', color: 'AR' },
    { name: 'Isabella Reed', group: 'Family', party: 2, status: 'attending', color: 'IR' },
    { name: 'James Parker', group: 'Friends', party: 1, status: 'declined', color: 'JP' },
    { name: 'Amir Hassan', group: 'Family', party: 3, status: 'attending', color: 'AH' },
    { name: 'Charlotte Lee', group: 'Friends', party: 2, status: 'attending', color: 'CL' },
    { name: 'Lucas Martin', group: 'Neighbors', party: 1, status: 'attending', color: 'LM' },
    { name: 'Harper Scott', group: 'Family', party: 2, status: 'pending', color: 'HS' },
    { name: 'Benjamin Clark', group: 'Friends', party: 2, status: 'attending', color: 'BC' },
    { name: 'Ella Nguyen', group: 'Family', party: 1, status: 'declined', color: 'EN' },
    { name: 'Henry Adams', group: 'Neighbors', party: 3, status: 'attending', color: 'HA' },
    { name: 'Lily Cooper', group: 'Friends', party: 2, status: 'pending', color: 'LC' },
    { name: 'Jack Rivera', group: 'Family', party: 1, status: 'attending', color: 'JR' },
    { name: 'Zoe Mitchell', group: 'Friends', party: 2, status: 'pending', color: 'ZM' },
    { name: 'Mateo Flores', group: 'Family', party: 2, status: 'attending', color: 'MF' },
    { name: 'Chloe Bennett', group: 'Friends', party: 1, status: 'pending', color: 'CB' },
    { name: 'Oliver James', group: 'Neighbors', party: 2, status: 'attending', color: 'OJ' },
    { name: 'Aria Turner', group: 'Family', party: 2, status: 'pending', color: 'AT' },
    { name: 'Daniel Morris', group: 'Friends', party: 2, status: 'attending', color: 'DM' },
    { name: 'Layla Price', group: 'Family', party: 3, status: 'pending', color: 'LP' },
    { name: 'Theo Bailey', group: 'Friends', party: 1, status: 'attending', color: 'TB' },
    { name: 'Nina Foster', group: 'Neighbors', party: 2, status: 'pending', color: 'NF' },
    { name: 'Caleb Ward', group: 'Family', party: 2, status: 'attending', color: 'CW' },
    { name: 'Ruby Hughes', group: 'Friends', party: 1, status: 'pending', color: 'RH' },
    { name: 'Miles Perry', group: 'Family', party: 2, status: 'attending', color: 'MP' },
    { name: 'Stella Long', group: 'Friends', party: 3, status: 'pending', color: 'SL' },
    { name: 'Eli Sanders', group: 'Neighbors', party: 2, status: 'attending', color: 'ES' },
    { name: 'Violet Ross', group: 'Family', party: 2, status: 'pending', color: 'VR' },
    { name: 'Finn Bailey', group: 'Friends', party: 1, status: 'attending', color: 'FB' },
    { name: 'Hazel Perry', group: 'Family', party: 2, status: 'pending', color: 'HP' },
    { name: 'Owen Gray', group: 'Friends', party: 1, status: 'attending', color: 'OG' },
    { name: 'Isla Bell', group: 'Family', party: 2, status: 'attending', color: 'IB' }
  ];

  function loadGuests() {
    try {
      var saved = window.localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        return defaultGuests.slice();
      }
      var parsed = JSON.parse(saved);
      return Array.isArray(parsed) && parsed.length ? parsed : defaultGuests.slice();
    } catch (error) {
      storageUnavailable = true;
      return defaultGuests.slice();
    }
  }

  function saveGuests() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(guests));
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
      if (!response || typeof response.name !== 'string' || !response.name.trim() ||
          !Number.isInteger(response.party) || response.party < 1 || response.party > 10 ||
          ['attending', 'declined', 'pending'].indexOf(response.status) === -1) return null;
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

  var guests = loadGuests();
  var activeFilter = 'all';
  var visibleLimit = 5;
  var toastTimer;
  var guestList = document.getElementById('guest-list');
  var filterButtons = document.querySelectorAll('[data-filter]');
  var searchInput = document.getElementById('guest-search');
  var guestDialog = document.getElementById('guest-dialog');
  var guestForm = document.getElementById('guest-form');
  var invitationSection = document.getElementById('guest-invitation');
  var invitationForm = document.getElementById('invitation-rsvp-form');
  var rsvpConfirmation = document.getElementById('rsvp-confirmation');
  var nextGuestId = 1;

  function counts() {
    return guests.reduce(function (total, guest) {
      total[guest.status] += 1;
      return total;
    }, { attending: 0, pending: 0, declined: 0 });
  }

  function makeCell(text) {
    var cell = document.createElement('td');
    cell.textContent = text;
    return cell;
  }

  function render() {
    var statusCounts = counts();
    var query = searchInput.value.trim().toLocaleLowerCase();
    var filtered = guests.filter(function (guest) {
      var matchesFilter = activeFilter === 'all' || guest.status === activeFilter;
      var matchesSearch = !query || [guest.name, guest.group, guest.status,
        guest.status === 'pending' ? 'awaiting' : ''].join(' ').toLocaleLowerCase().indexOf(query) !== -1;
      return matchesFilter && matchesSearch;
    });
    var shown = filtered.slice(0, visibleLimit);
    guestList.replaceChildren();

    shown.forEach(function (guest) {
      var row = document.createElement('tr');
      var nameCell = document.createElement('td');
      var guestCell = document.createElement('span');
      var avatar = document.createElement('span');
      var responseCell = document.createElement('td');
      var pill = document.createElement('span');
      var label = guest.status === 'attending' ? 'Attending' :
        guest.status === 'declined' ? 'Declined' : 'Awaiting';
      guestCell.className = 'guest-cell';
      avatar.className = 'guest-avatar';
      avatar.textContent = guest.color;
      guestCell.appendChild(avatar);
      guestCell.appendChild(document.createTextNode(guest.name));
      nameCell.appendChild(guestCell);
      nameCell.setAttribute('data-label', 'Guest');
      row.appendChild(nameCell);
      var groupCell = makeCell(guest.group);
      groupCell.setAttribute('data-label', 'Group');
      row.appendChild(groupCell);
      var partyCell = makeCell(guest.party + (guest.party === 1 ? ' guest' : ' guests'));
      partyCell.setAttribute('data-label', 'Party size');
      row.appendChild(partyCell);
      pill.className = 'response-pill' + (guest.status === 'pending' ? ' response-pill--pending' :
        guest.status === 'declined' ? ' response-pill--declined' : '');
      pill.textContent = label;
      responseCell.setAttribute('data-label', 'Response');
      responseCell.appendChild(pill);
      row.appendChild(responseCell);
      guestList.appendChild(row);
    });

    document.getElementById('invited-count').textContent = guests.length;
    document.getElementById('attending-count').textContent = statusCounts.attending;
    document.getElementById('pending-count').textContent = statusCounts.pending;
    document.getElementById('declined-count').textContent = statusCounts.declined;
    document.getElementById('guest-range').textContent = filtered.length ?
      'Showing 1 to ' + shown.length + ' of ' + filtered.length + ' guests' : 'No guests in this view';
    document.getElementById('view-all-button').hidden = filtered.length <= 5 || visibleLimit >= filtered.length;
    var empty = document.getElementById('guest-empty');
    empty.hidden = filtered.length !== 0;
    document.getElementById('guest-empty-title').textContent = guests.length === 0 ? 'No guests yet' :
      (query ? 'No matching guests' : 'No guests in this filter');
    document.getElementById('guest-empty-copy').textContent = guests.length === 0 ?
      'Add a sample guest to see them here.' : (query ? 'Try another name, group, or response.' : 'Choose another response filter to see guests.');

    filterButtons.forEach(function (button) {
      var active = button.dataset.filter === activeFilter;
      button.classList.toggle('filter-tab--active', active);
      button.setAttribute('aria-pressed', String(active));
      var labelMap = { all: 'Everyone', attending: 'Attending', pending: 'Awaiting', declined: 'Declined' };
      var count = button.dataset.filter === 'all' ? guests.length : statusCounts[button.dataset.filter];
      button.replaceChildren(document.createTextNode(labelMap[button.dataset.filter] + ' '));
      var countNode = document.createElement('span');
      if (button.dataset.filter === 'all') countNode.id = 'filter-all-count';
      countNode.textContent = count;
      button.appendChild(countNode);
    });
  }

  function showToast(message) {
    var toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.remove('is-visible');
    }, 3000);
  }

  filterButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      activeFilter = button.dataset.filter;
      visibleLimit = 5;
      render();
    });
  });

  searchInput.addEventListener('input', function () {
    visibleLimit = 5;
    render();
  });

  document.getElementById('view-all-button').addEventListener('click', function () {
    visibleLimit = guests.length;
    render();
  });

  document.getElementById('add-guest-button').addEventListener('click', function () {
    guestDialog.showModal();
    guestForm.elements.name.focus();
  });

  function closeGuestDialog() {
    guestDialog.close();
  }
  document.getElementById('close-guest-dialog').addEventListener('click', closeGuestDialog);
  document.getElementById('cancel-guest').addEventListener('click', closeGuestDialog);

  guestForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!guestForm.reportValidity()) return;
    var formData = new FormData(guestForm);
    var name = String(formData.get('name')).trim();
    var group = String(formData.get('group')).trim();
    if (!name || !group) return;
    guests.unshift({
      name: name,
      group: group,
      party: Math.max(1, Math.min(20, Number(formData.get('party')) || 1)),
      status: ['attending', 'pending', 'declined'].indexOf(formData.get('status')) !== -1 ? formData.get('status') : 'pending',
      color: name.split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0); }).join('').toLocaleUpperCase(),
      id: nextGuestId++
    });
    activeFilter = 'all';
    searchInput.value = '';
    visibleLimit = 5;
    var guestSaved = saveGuests();
    render();
    guestForm.reset();
    closeGuestDialog();
    showToast(guestSaved ? 'Sample guest added. Saved only in this browser.' :
      'Sample guest added for this session; browser storage is unavailable.');
  });

  document.getElementById('share-button').addEventListener('click', function () {
    var shareUrl = window.location.href.split('#')[0] + '#invite';
    var label = document.getElementById('share-label');
    var button = document.getElementById('share-button');
    function feedback(message, buttonLabel) {
      label.textContent = buttonLabel || 'Link copied';
      showToast(message || 'Guest invitation preview link copied. RSVP is a local demo only.');
      window.setTimeout(function () { label.textContent = 'Share invite'; }, 2500);
    }
    function legacyCopy() {
      var input = document.createElement('textarea');
      input.value = shareUrl;
      input.setAttribute('readonly', '');
      input.setAttribute('aria-hidden', 'true');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      var didCopy = false;
      try { didCopy = document.execCommand('copy'); } catch (error) { didCopy = false; }
      input.remove();
      if (didCopy) feedback();
      else showToast('Could not copy automatically. Use your browser address bar to share this demo.');
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
        title: "Amelia's first trip around the sun",
        text: "You're invited to Amelia's garden party. Open this link to see the details and try the demo RSVP.",
        url: shareUrl
      });
    }).then(function () {
      feedback('Guest invitation preview shared. No real message or RSVP was sent.', 'Shared');
    }).catch(function (error) {
      if (error && error.name === 'AbortError') return;
      return copyLink();
    }) : copyLink();
    Promise.resolve(sharing).catch(function () {
      showToast('Could not share automatically. You can copy the demo address from your browser.');
    }).then(function () { button.disabled = false; });
  });

  function showSavedRsvp() {
    var saved = loadRsvp();
    if (!saved) {
      invitationForm.hidden = false;
      rsvpConfirmation.hidden = true;
      return;
    }
    document.getElementById('rsvp-name').value = saved.name;
    document.getElementById('rsvp-party').value = saved.party;
    var selected = invitationForm.querySelector('input[name="status"][value="' + saved.status + '"]');
    if (selected) selected.checked = true;
    var responseText = saved.status === 'attending' ? 'We can’t wait to see you there!' :
      saved.status === 'declined' ? 'Thanks for letting us know. You’ll be missed!' :
        'Thanks! Your reply is marked as maybe for now.';
    document.getElementById('rsvp-confirmation-title').textContent = 'Thanks, ' + saved.name + '!';
    document.getElementById('rsvp-confirmation-copy').textContent =
      responseText + ' Party size: ' + saved.party + '. This response is saved only in this browser.';
    invitationForm.hidden = true;
    rsvpConfirmation.hidden = false;
  }

  function updateViewFromHash() {
    var isInvitation = window.location.hash === '#invite';
    document.body.dataset.view = isInvitation ? 'invitation' : 'site';
    invitationSection.hidden = !isInvitation;
    if (isInvitation) {
      showSavedRsvp();
      window.scrollTo(0, 0);
    }
  }

  invitationForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!invitationForm.reportValidity()) return;
    var formData = new FormData(invitationForm);
    var name = String(formData.get('name')).trim();
    var party = Number(formData.get('party'));
    var status = String(formData.get('status'));
    if (!name || !Number.isInteger(party) || party < 1 || party > 10 ||
        ['attending', 'declined', 'pending'].indexOf(status) === -1) return;

    var response = { name: name, party: party, status: status };
    var existingGuest = guests.find(function (guest) {
      return guest.name.toLocaleLowerCase() === name.toLocaleLowerCase();
    });
    if (existingGuest) {
      existingGuest.party = party;
      existingGuest.status = status;
    } else {
      guests.unshift({
        name: name,
        group: 'Invitation link',
        party: party,
        status: status,
        color: name.split(/\s+/).slice(0, 2).map(function (part) {
          return part.charAt(0);
        }).join('').toLocaleUpperCase()
      });
    }
    var guestSaved = saveGuests();
    var responseSaved = saveRsvp(response);
    render();
    document.getElementById('rsvp-confirmation-title').textContent = 'Thanks, ' + name + '!';
    document.getElementById('rsvp-confirmation-copy').textContent = status === 'attending' ?
      'We can’t wait to see you there! Party size: ' + party + '.' :
      status === 'declined' ? 'Thanks for letting us know. You’ll be missed!' :
        'Thanks! Your reply is marked as maybe for now.';
    if (!guestSaved || !responseSaved) {
      document.getElementById('rsvp-confirmation-copy').textContent +=
        ' Browser storage is unavailable, so this demo response may not remain after you leave.';
    } else {
      document.getElementById('rsvp-confirmation-copy').textContent +=
        ' This is a local demo response; it was not sent to a host.';
    }
    invitationForm.hidden = true;
    rsvpConfirmation.hidden = false;
    rsvpConfirmation.querySelector('h3').focus();
  });

  document.getElementById('edit-rsvp').addEventListener('click', function () {
    invitationForm.hidden = false;
    rsvpConfirmation.hidden = true;
    document.getElementById('rsvp-name').focus();
  });

  window.addEventListener('hashchange', updateViewFromHash);

  var menuToggle = document.querySelector('.menu-toggle');
  var mobileNav = document.getElementById('mobile-nav');
  menuToggle.addEventListener('click', function () {
    var isExpanded = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isExpanded));
    menuToggle.setAttribute('aria-label', isExpanded ? 'Open menu' : 'Close menu');
    mobileNav.hidden = isExpanded;
  });

  mobileNav.addEventListener('click', function (event) {
    if (event.target.closest('a')) {
      mobileNav.hidden = true;
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', 'Open menu');
    }
  });

  render();
  updateViewFromHash();
  if (storageUnavailable) {
    showToast('Browser storage is unavailable. Demo changes may not remain after you leave this page.');
  }
}());
