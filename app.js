import {
  buildPatientNotification,
  calculateVaccinationStatus,
  deleteEntry,
  exportRecordsToCsv,
  getPassExpiryDate,
  summarizeEntries,
  updateEntry,
} from './vaccination.js';

const STORAGE_KEY = 'bakunapass.entries';

const seedRecords = [
  {
    name: 'Maria Santos',
    doses: 2,
    lastDoseDate: '2026-06-15',
    boosterReceived: false,
  },
  {
    name: 'John Smith',
    doses: 1,
    lastDoseDate: '2026-09-10',
    boosterReceived: false,
  },
  {
    name: 'Aisha Khan',
    doses: 3,
    lastDoseDate: '2026-08-20',
    boosterReceived: true,
  },
];

const state = {
  entries: loadEntries(),
};

let editingIndex = null;
let selectedNotificationIndex = null;

const form = document.querySelector('#person-form');
const submitButton = document.querySelector('#submit-record');
const cancelButton = document.querySelector('#cancel-edit');
const summary = document.querySelector('#summary');
const recordList = document.querySelector('#record-list');
const searchInput = document.querySelector('#search-input');
const statusFilter = document.querySelector('#status-filter');
const sortSelect = document.querySelector('#sort-select');
const clearAllButton = document.querySelector('#clear-records');
const exportButton = document.querySelector('#export-csv');
const printButton = document.querySelector('#print-report');
const chart = document.querySelector('#status-chart');
const notificationList = document.querySelector('#notification-list');
const notificationFeedback = document.querySelector('#notification-feedback');

function loadEntries() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      return [...seedRecords];
    }

    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) && parsed.length ? parsed : [...seedRecords];
  } catch {
    return [...seedRecords];
  }
}

function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
}

function resetForm() {
  form.reset();
  editingIndex = null;
  submitButton.textContent = 'Submit record';
  cancelButton.hidden = true;
}

function populateForm(entry) {
  document.querySelector('#name').value = entry.name || '';
  document.querySelector('#doses').value = entry.doses ?? 0;
  document.querySelector('#lastDoseDate').value = entry.lastDoseDate || '';
  document.querySelector('#address').value = entry.address || '';
  document.querySelector('#phone').value = entry.phone || '';
  document.querySelector('#email').value = entry.email || '';
  document.querySelector('#boosterReceived').checked = Boolean(entry.boosterReceived);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function renderNotifications() {
  if (selectedNotificationIndex !== null && !state.entries[selectedNotificationIndex]) {
    selectedNotificationIndex = null;
  }

  if (state.entries.length === 0) {
    notificationList.innerHTML = '<p class="empty-state">Add a patient record before composing a notification.</p>';
    return;
  }

  const options = state.entries
    .map((entry, index) => `
      <option value="${index}" ${index === selectedNotificationIndex ? 'selected' : ''}>
        ${escapeHtml(entry.name)}${entry.email ? ` — ${escapeHtml(entry.email)}` : ' — no email on file'}
      </option>
    `)
    .join('');

  notificationList.innerHTML = `
    <label class="patient-picker">
      Choose patient
      <select id="notification-patient" aria-label="Choose patient">
        <option value="">Select a patient...</option>
        ${options}
      </select>
    </label>
    <div class="notification-item" id="notification-composer" ${selectedNotificationIndex === null ? 'hidden' : ''}>
      <div class="notification-title">
        <strong id="notification-patient-name"></strong>
        <span class="status-badge status-pending" id="notification-patient-status"></span>
      </div>
      <form class="notification-form">
        <label>
          Email recipient
          <input type="email" name="to" placeholder="patient@example.com" autocomplete="email" required />
        </label>
        <label>
          Email subject
          <input type="text" name="subject" value="BakunaPass Health Notification" maxlength="120" required />
        </label>
        <label>
          Message
          <textarea name="message" rows="5" maxlength="4000" required></textarea>
        </label>
        <div class="notification-actions">
          <button type="submit" class="small" data-action="notify">Send email</button>
        </div>
      </form>
    </div>
  `;

  if (selectedNotificationIndex !== null) {
    populateNotificationComposer(selectedNotificationIndex);
  }
}

function populateNotificationComposer(index) {
  const entry = state.entries[index];
  const composer = document.querySelector('#notification-composer');
  if (!entry || !composer) {
    return;
  }

  const status = calculateVaccinationStatus({
    doses: entry.doses,
    lastDoseDate: entry.lastDoseDate,
    boosterReceived: entry.boosterReceived,
    referenceDate: new Date(),
  }).status;

  composer.querySelector('[name="to"]').value = entry.email || '';
  composer.querySelector('[name="subject"]').value = 'BakunaPass Health Notification';
  composer.querySelector('[name="message"]').value = buildPatientNotification(entry, new Date());
  document.querySelector('#notification-patient-name').textContent = entry.name;
  document.querySelector('#notification-patient-status').textContent = status;
}

async function sendNotificationEmail({ to, subject, message }, button) {
  notificationFeedback.textContent = `Sending email to ${to}...`;
  button.disabled = true;

  try {
    const response = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'email',
        to,
        subject,
        message,
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Notification could not be sent.');
    }

    notificationFeedback.textContent = `Email sent to ${to}.`;
  } catch (error) {
    notificationFeedback.textContent = error.message || 'Could not reach the notification server.';
  } finally {
    button.disabled = false;
  }
}

function renderSummary() {
  const totals = summarizeEntries(state.entries, new Date('2026-09-30'));

  const cards = [
    { label: 'Total records', value: totals.total },
    { label: 'Verified', value: totals.valid },
    { label: 'Pending review', value: totals.pending },
  ];

  summary.innerHTML = cards
    .map(
      (card) => `
        <article class="summary-card">
          <span class="label">${card.label}</span>
          <strong>${card.value}</strong>
        </article>
      `,
    )
    .join('');

  const statusOrder = ['Not vaccinated', 'Partially vaccinated', 'Fully vaccinated', 'Booster due', 'Booster complete'];
  const counts = statusOrder.reduce((accumulator, status) => {
    accumulator[status] = state.entries.filter((entry) => {
      const result = calculateVaccinationStatus({
        doses: entry.doses,
        lastDoseDate: entry.lastDoseDate,
        boosterReceived: entry.boosterReceived,
        referenceDate: new Date('2026-09-30'),
      });
      return result.status === status;
    }).length;
    return accumulator;
  }, {});

  const maxCount = Math.max(1, ...Object.values(counts));

  chart.innerHTML = statusOrder
    .map((status) => {
      const value = counts[status] || 0;
      const width = (value / maxCount) * 100;
      return `
        <div class="chart-item">
          <div class="chart-label">
            <span>${status}</span>
            <strong>${value}</strong>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width: ${width}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function getBadgeClass(status) {
  if (status === 'Booster due' || status === 'Partially vaccinated' || status === 'Not vaccinated') {
    return 'status-pending';
  }

  if (status === 'Booster complete' || status === 'Fully vaccinated') {
    return 'status-valid';
  }

  return 'status-danger';
}

function getFilteredEntries() {
  const query = searchInput.value.trim().toLowerCase();
  const selectedStatus = statusFilter.value;

  let filtered = [...state.entries];

  if (query) {
    filtered = filtered.filter((entry) => entry.name.toLowerCase().includes(query));
  }

  if (selectedStatus !== 'all') {
    filtered = filtered.filter((entry) => {
      const result = calculateVaccinationStatus({
        doses: entry.doses,
        lastDoseDate: entry.lastDoseDate,
        boosterReceived: entry.boosterReceived,
        referenceDate: new Date('2026-09-30'),
      });
      return result.status === selectedStatus;
    });
  }

  const sortMode = sortSelect.value;
  if (sortMode === 'status') {
    filtered.sort((a, b) => {
      const statusA = calculateVaccinationStatus({
        doses: a.doses,
        lastDoseDate: a.lastDoseDate,
        boosterReceived: a.boosterReceived,
        referenceDate: new Date('2026-09-30'),
      }).status;
      const statusB = calculateVaccinationStatus({
        doses: b.doses,
        lastDoseDate: b.lastDoseDate,
        boosterReceived: b.boosterReceived,
        referenceDate: new Date('2026-09-30'),
      }).status;
      return statusA.localeCompare(statusB);
    });
  } else if (sortMode === 'date') {
    filtered.sort((a, b) => {
      const dateA = new Date(a.lastDoseDate || '1970-01-01').getTime();
      const dateB = new Date(b.lastDoseDate || '1970-01-01').getTime();
      return dateB - dateA;
    });
  } else {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  return filtered;
}

function renderRecords() {
  const filteredEntries = getFilteredEntries();

  if (filteredEntries.length === 0) {
    recordList.innerHTML = '<p class="empty-state">No vaccination records match the current filter.</p>';
    return;
  }

  recordList.innerHTML = filteredEntries
    .map((entry) => {
      const result = calculateVaccinationStatus({
        doses: entry.doses,
        lastDoseDate: entry.lastDoseDate,
        boosterReceived: entry.boosterReceived,
        referenceDate: new Date('2026-09-30'),
      });
      const passExpiry = getPassExpiryDate(entry.lastDoseDate, entry.boosterReceived);

      return `
        <article class="record-item">
          <div>
            <h3>${entry.name}</h3>
            <div class="record-meta">${entry.doses} dose(s) · Last dose: ${entry.lastDoseDate || 'Not supplied'}</div>
            <div class="record-detail">
              ${entry.address ? `Address: ${entry.address}` : 'Address: not provided'}
              ${entry.phone ? ` · Phone: ${entry.phone}` : ''}
              ${entry.email ? ` · Email: ${entry.email}` : ''}
            </div>
            <div class="record-detail">
              ${result.message}
              ${passExpiry ? ` · Pass review due: ${passExpiry}` : ''}
            </div>
          </div>

          <div class="record-actions">
            <span class="status-badge ${getBadgeClass(result.status)}">${result.status}</span>
            <div class="button-row">
              <button type="button" class="secondary" data-action="edit" data-name="${entry.name}">Update</button>
              <button type="button" class="danger" data-action="delete" data-name="${entry.name}">Delete</button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

recordList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) {
    return;
  }

  const name = button.dataset.name;
  const index = state.entries.findIndex((entry) => entry.name === name);

  if (index === -1) {
    return;
  }

  if (button.dataset.action === 'delete') {
    state.entries = deleteEntry(state.entries, index);
    saveEntries();
    if (selectedNotificationIndex === index) {
      selectedNotificationIndex = null;
    } else if (selectedNotificationIndex !== null && selectedNotificationIndex > index) {
      selectedNotificationIndex -= 1;
    }
    if (editingIndex === index) {
      resetForm();
    } else if (editingIndex !== null && editingIndex > index) {
      editingIndex -= 1;
    }
    renderSummary();
    renderNotifications();
    renderRecords();
    return;
  }

  if (button.dataset.action === 'edit') {
    editingIndex = index;
    populateForm(state.entries[index]);
    submitButton.textContent = 'Update record';
    cancelButton.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

notificationList.addEventListener('change', (event) => {
  if (event.target.id !== 'notification-patient') {
    return;
  }

  selectedNotificationIndex = event.target.value === '' ? null : Number(event.target.value);
  const composer = document.querySelector('#notification-composer');
  if (composer) {
    composer.hidden = selectedNotificationIndex === null;
  }
  if (selectedNotificationIndex !== null) {
    populateNotificationComposer(selectedNotificationIndex);
  }
  notificationFeedback.textContent = '';
});

notificationList.addEventListener('submit', (event) => {
  const notificationForm = event.target.closest('.notification-form');
  if (!notificationForm) {
    return;
  }

  event.preventDefault();
  const formData = new FormData(notificationForm);
  const button = notificationForm.querySelector('[data-action="notify"]');
  sendNotificationEmail({
    to: formData.get('to').toString().trim(),
    subject: formData.get('subject').toString().trim(),
    message: formData.get('message').toString().trim(),
  }, button);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const nextEntry = {
    name: formData.get('name').toString().trim(),
    doses: Number(formData.get('doses')),
    lastDoseDate: formData.get('lastDoseDate').toString(),
    address: formData.get('address').toString().trim(),
    phone: formData.get('phone').toString().trim(),
    email: formData.get('email').toString().trim(),
    boosterReceived: formData.get('boosterReceived') === 'on',
  };

  if (!nextEntry.name) {
    return;
  }

  if (editingIndex === null) {
    state.entries.push(nextEntry);
  } else {
    state.entries = updateEntry(state.entries, editingIndex, nextEntry);
  }

  saveEntries();
  resetForm();
  renderSummary();
  renderNotifications();
  renderRecords();
});

cancelButton.addEventListener('click', () => {
  resetForm();
});

searchInput.addEventListener('input', renderRecords);
statusFilter.addEventListener('change', renderRecords);
sortSelect.addEventListener('change', renderRecords);
clearAllButton.addEventListener('click', () => {
  state.entries = [];
  selectedNotificationIndex = null;
  saveEntries();
  renderSummary();
  renderNotifications();
  renderRecords();
});

exportButton.addEventListener('click', () => {
  const csv = exportRecordsToCsv(state.entries);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bakunapass-report.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
});

printButton.addEventListener('click', () => {
  window.print();
});

resetForm();
renderSummary();
renderNotifications();
renderRecords();
