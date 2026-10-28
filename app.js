const state = {
  token: localStorage.getItem('sos_token') || '',
  user: null,
  contacts: [],
  activeAlert: null,
  watchId: null,
  lastSaved: 0,
  signUpMode: false,
};

const $ = (id) => document.getElementById(id);

function toast(message) {
  const toastEl = $('toast');
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return headers;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = { error: text || 'Request failed.' };
  }

  if (!response.ok) {
    throw new Error(payload?.error || 'Request failed.');
  }

  return payload;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') {
      el.className = value;
    } else if (key.startsWith('on')) {
      el.addEventListener(key.slice(2), value);
    } else {
      el.setAttribute(key, value);
    }
  }

  children.flat().forEach((child) => {
    if (child instanceof Node) {
      el.appendChild(child);
    } else if (child != null) {
      el.appendChild(document.createTextNode(String(child)));
    }
  });

  return el;
}

function showAuth() {
  $('authView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
}

function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
}

function setAuthMode() {
  const title = state.signUpMode ? 'Create account' : 'Sign in';
  $('authTitle').textContent = title;
  $('authBtn').textContent = state.signUpMode ? 'Sign up' : 'Sign in';
  $('authToggle').textContent = state.signUpMode ? 'I have an account' : 'Create account';
  $('authErr').textContent = '';
}

async function loadSession() {
  try {
    const data = await apiFetch('/api/session');
    state.user = data.user;
    showApp();
    await loadContacts();
    await resumeActiveAlert();
    loadHistory();
  } catch (error) {
    console.error(error);
    state.token = '';
    localStorage.removeItem('sos_token');
    showAuth();
  }
}

function setupTabs() {
  document.querySelectorAll('nav.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach((item) => {
        item.classList.toggle('on', item === button);
      });

      ['sos', 'contacts', 'history'].forEach((tab) => {
        $( `tab-${tab}` ).classList.toggle('hidden', tab !== button.dataset.tab);
      });

      if (button.dataset.tab === 'history') {
        loadHistory();
      }
    });
  });
}

function setupAuthEvents() {
  $('authToggle').addEventListener('click', () => {
    state.signUpMode = !state.signUpMode;
    setAuthMode();
  });

  $('authBtn').addEventListener('click', async () => {
    const email = $('email').value.trim();
    const password = $('password').value;
    $('authErr').textContent = '';

    if (!email || password.length < 6) {
      $('authErr').textContent = 'Enter an email and a password of 6+ characters.';
      return;
    }

    $('authBtn').disabled = true;

    try {
      const endpoint = state.signUpMode ? '/api/register' : '/api/login';
      const response = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });

      state.token = response.token;
      localStorage.setItem('sos_token', state.token);
      state.user = response.user;
      showApp();
      await loadContacts();
      await resumeActiveAlert();
      loadHistory();
    } catch (error) {
      $('authErr').textContent = error.message;
    } finally {
      $('authBtn').disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    state.token = '';
    state.user = null;
    state.activeAlert = null;
    state.contacts = [];
    localStorage.removeItem('sos_token');
    stopTracking();
    showAuth();
    $('email').value = '';
    $('password').value = '';
  });
}

async function loadContacts() {
  try {
    const response = await apiFetch('/api/contacts');
    state.contacts = response.contacts || [];
    const list = $('contactList');
    list.replaceChildren();

    if (!state.contacts.length) {
      list.appendChild(h('p', { class: 'muted' }, 'No contacts yet. Add at least one trusted person.'));
      renderNotifyList();
      return;
    }

    state.contacts.forEach((contact) => {
      const row = h(
        'div',
        { class: 'item' },
        h('div', {}, h('strong', {}, contact.name), h('div', { class: 'muted' }, `${contact.phone}${contact.relation ? ` · ${contact.relation}` : ''}`)),
        h('button', {
          class: 'btn secondary small',
          onclick: async () => {
            if (!confirm(`Remove ${contact.name}?`)) return;
            try {
              await apiFetch(`/api/contacts/${contact.id}`, { method: 'DELETE' });
              await loadContacts();
            } catch (error) {
              toast(error.message);
            }
          },
        }, 'Remove')
      );
      list.appendChild(row);
    });

    renderNotifyList();
  } catch (error) {
    toast(error.message);
  }
}

$('addContactBtn').addEventListener('click', async () => {
  const name = $('cName').value.trim();
  const phone = $('cPhone').value.trim().replace(/[\s()-]/g, '');
  const relation = $('cRel').value.trim();
  $('cErr').textContent = '';

  if (!name) {
    $('cErr').textContent = 'Name is required.';
    return;
  }

  if (!/^\+?\d{7,15}$/.test(phone)) {
    $('cErr').textContent = 'Enter a valid phone number, preferably with country code.';
    return;
  }

  try {
    await apiFetch('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({ name, phone, relation: relation || null }),
    });

    ['cName', 'cPhone', 'cRel'].forEach((field) => { $(field).value = ''; });
    toast('Contact saved');
    await loadContacts();
  } catch (error) {
    $('cErr').textContent = error.message;
  }
});

function setupHoldButton() {
  const button = $('sosBtn');
  const progress = $('progress').firstElementChild;
  let startTime = 0;
  let animationFrame = 0;

  function cancelHold() {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    button.classList.remove('holding');
    progress.style.width = '0%';
  }

  function tick() {
    const elapsed = performance.now() - startTime;
    const progressAmount = Math.min(1, elapsed / 2000);
    progress.style.width = `${progressAmount * 100}%`;

    if (progressAmount >= 1) {
      cancelHold();
      triggerSOS();
      return;
    }

    animationFrame = requestAnimationFrame(tick);
  }

  function beginHold(event) {
    if (event.type === 'keydown' && (event.repeat || !['Enter', ' '].includes(event.key))) {
      return;
    }

    if (event.type === 'keydown') {
      event.preventDefault();
    }

    if (animationFrame) return;

    button.classList.add('holding');
    startTime = performance.now();
    if (navigator.vibrate) navigator.vibrate(30);
    animationFrame = requestAnimationFrame(tick);
  }

  button.addEventListener('pointerdown', beginHold);
  button.addEventListener('keydown', beginHold);
  ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur'].forEach((eventName) => {
    button.addEventListener(eventName, cancelHold);
  });
  button.addEventListener('contextmenu', (event) => event.preventDefault());
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      return resolve(null);
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  });
}

async function triggerSOS() {
  if (state.activeAlert) return;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  toast('Sending SOS… getting your location');
  const position = await getPosition();

  try {
    const response = await apiFetch('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({
        lat: position ? position.lat : null,
        lng: position ? position.lng : null,
        accuracy: position ? position.accuracy : null,
      }),
    });

    state.activeAlert = response.alert;
    if (position) {
      await apiFetch(`/api/alerts/${state.activeAlert.id}/location`, {
        method: 'POST',
        body: JSON.stringify(position),
      });
    }

    showActive();
    startTracking();

    if (!position) {
      toast('Location unavailable. Allow location access and call 112 now.');
    }
  } catch (error) {
    toast(error.message);
  }
}

async function resumeActiveAlert() {
  try {
    const response = await apiFetch('/api/alerts/active');
    state.activeAlert = response.alert || null;
    if (state.activeAlert) {
      showActive();
      startTracking();
    } else {
      state.activeAlert = null;
      showIdle();
    }
  } catch (error) {
    console.error(error);
    showIdle();
  }
}

function showActive() {
  $('idlePanel').classList.add('hidden');
  $('activePanel').classList.remove('hidden');
  refreshActiveUI();
  renderNotifyList();
}

function showIdle() {
  $('idlePanel').classList.remove('hidden');
  $('activePanel').classList.add('hidden');
}

function mapsUrl(alert) {
  if (!alert || alert.lat == null || alert.lng == null) return null;
  return `https://www.google.com/maps?q=${alert.lat},${alert.lng}`;
}

function sosMessage() {
  const url = mapsUrl(state.activeAlert);
  return `🚨 SOS! I need help. ${url ? `My live location: ${url}` : "I couldn't get my location, please call me now."} (sent ${new Date().toLocaleTimeString()})`;
}

function refreshActiveUI() {
  if (!state.activeAlert) return;

  $('activeInfo').textContent = `Started ${new Date(state.activeAlert.created_at).toLocaleString()}. Your location is saved every few seconds while this is active.`;

  const wrap = $('mapLinkWrap');
  wrap.replaceChildren();
  const url = mapsUrl(state.activeAlert);

  if (url) {
    wrap.append('Current location: ', h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener' }, 'Open in Maps'));
    if (state.activeAlert.accuracy != null) {
      wrap.append(` (±${Math.round(state.activeAlert.accuracy)} m)`);
    }
  } else {
    wrap.append('No location captured.');
  }
}

function renderNotifyList() {
  const notifyList = $('notifyList');
  notifyList.replaceChildren();

  if (!state.contacts.length) {
    notifyList.appendChild(h('p', { class: 'muted' }, 'No contacts saved. Add some in the Contacts tab, or call 112.'));
    return;
  }

  state.contacts.forEach((contact) => {
    const digits = contact.phone.replace(/\D/g, '');
    notifyList.appendChild(
      h(
        'div',
        { class: 'item' },
        h('strong', {}, contact.name),
        h(
          'div',
          { class: 'row' },
          h('a', { class: 'btn small', href: `tel:${contact.phone}`, style: 'text-decoration:none' }, 'Call'),
          h('button', {
            class: 'btn secondary small',
            onclick: () => {
              window.location.href = `sms:${contact.phone}?&body=${encodeURIComponent(sosMessage())}`;
            },
          }, 'SMS'),
          h('button', {
            class: 'btn secondary small',
            onclick: () => {
              window.open(`https://wa.me/${digits}?text=${encodeURIComponent(sosMessage())}`, '_blank', 'noopener');
            },
          }, 'WhatsApp')
        )
      )
    );
  });
}

$('shareBtn').addEventListener('click', async () => {
  const text = sosMessage();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'SOS', text });
      return;
    } catch (_error) {
      // fall through to copy flow
    }
  }

  await copyText(text);
});

$('copyBtn').addEventListener('click', () => copyText(sosMessage()));

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Message copied');
  } catch (_error) {
    prompt('Copy this message:', text);
  }
}

function startTracking() {
  if (!navigator.geolocation || state.watchId !== null || !state.activeAlert) return;

  state.watchId = navigator.geolocation.watchPosition(
    async (position) => {
      if (!state.activeAlert) return;

      const now = Date.now();
      if (now - state.lastSaved < 15000) return;

      state.lastSaved = now;
      const payload = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };

      state.activeAlert = { ...state.activeAlert, ...payload };
      refreshActiveUI();

      try {
        await apiFetch(`/api/alerts/${state.activeAlert.id}/location`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      } catch (error) {
        console.error(error);
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function stopTracking() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

$('safeBtn').addEventListener('click', async () => {
  if (!state.activeAlert) return;
  if (!confirm("Mark this alert as resolved? Tell your contacts you're safe.")) return;

  try {
    await apiFetch(`/api/alerts/${state.activeAlert.id}/resolved`, { method: 'PATCH' });
    stopTracking();
    state.activeAlert = null;
    showIdle();
    loadHistory();
    toast("Alert resolved. Glad you're safe.");
  } catch (error) {
    toast(error.message);
  }
});

async function loadHistory() {
  try {
    const response = await apiFetch('/api/alerts/history');
    const list = $('historyList');
    list.replaceChildren();

    const alerts = response.alerts || [];
    if (!alerts.length) {
      list.appendChild(h('p', { class: 'muted' }, 'No alerts yet.'));
      return;
    }

    alerts.forEach((alert) => {
      const url = mapsUrl(alert);
      list.appendChild(
        h(
          'div',
          { class: 'item' },
          h(
            'div',
            {},
            h('div', {}, new Date(alert.created_at).toLocaleString()),
            url ? h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener' }, 'Last location') : h('span', { class: 'muted' }, 'No location')
          ),
          h('span', { class: `badge ${alert.status}` }, alert.status)
        )
      );
    });
  } catch (error) {
    $('historyList').replaceChildren(h('p', { class: 'err' }, error.message));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setAuthMode();
  setupTabs();
  setupAuthEvents();
  setupHoldButton();

  if (state.token) {
    loadSession();
  } else {
    showAuth();
  }
});
