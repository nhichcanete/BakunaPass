const tokenKey = 'bakunapass.operations.token';
const roleKey = 'bakunapass.operations.role';
const usernameKey = 'bakunapass.operations.username';
const roleLabels = {
  facility_user: 'Facility requester',
  health_worker: 'RHU health worker',
  cold_chain_officer: 'RHU cold-chain officer',
  operations_manager: 'Operations manager',
  admin: 'System administrator',
};

const state = {
  role: null,
  token: null,
  username: null,
  batches: [],
  inventory: [],
  requisitions: [],
};

const loginFeedback = document.querySelector('#operations-feedback');
const sessionPanel = document.querySelector('#operations-session');
const workspace = document.querySelector('#operations-workspace');
const accessPanel = document.querySelector('#operations-access');
const navAccount = document.querySelector('#nav-account');
const roleLabel = document.querySelector('#operations-role');
const sessionNote = document.querySelector('#operations-session-note');
const requisitionForm = document.querySelector('#requisition-create');
const telemetryForm = document.querySelector('#telemetry-create');
const riskForm = document.querySelector('#risk-lookup');
const stockForm = document.querySelector('#stock-reserve');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function setFeedback(message, type = '') {
  loginFeedback.textContent = message;
  loginFeedback.classList.toggle('is-success', type === 'success');
  loginFeedback.classList.toggle('is-error', type === 'error');
}

function setData(container, message) {
  container.textContent = message;
}

async function apiRequest(path, { method = 'GET', payload, authenticated = true } = {}) {
  const response = await fetch(`./api/v1${path}`, {
    method,
    headers: {
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(authenticated && state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
      window.location.replace('/auth.html');
    }
    const error = new Error(typeof result === 'object' ? result.message || result.error : result);
    error.status = response.status;
    error.code = typeof result === 'object' ? result.error : undefined;
    error.details = typeof result === 'object' ? result.details : undefined;
    throw error;
  }
  return result;
}

function clearSession() {
  sessionStorage.removeItem(tokenKey);
  sessionStorage.removeItem(roleKey);
  sessionStorage.removeItem(usernameKey);
  state.token = null;
  state.role = null;
  state.username = null;
  state.batches = [];
  state.inventory = [];
  state.requisitions = [];
  updateSessionView();
}

function updateSessionView() {
  const isSignedIn = Boolean(state.role);
  accessPanel.hidden = isSignedIn;
  sessionPanel.hidden = !isSignedIn;
  workspace.hidden = !isSignedIn;
  navAccount.href = isSignedIn ? '#operations' : '/auth.html';
  navAccount.innerHTML = isSignedIn
    ? 'My workspace <span aria-hidden="true">→</span>'
    : 'Sign in <span aria-hidden="true">↗</span>';
  roleLabel.textContent = state.username
    ? `${roleLabels[state.role] || state.role} · ${state.username}`
    : roleLabels[state.role] || state.role || '';
  sessionNote.textContent = 'Signed in with a secure one-hour session.';
  updateRoleControls();
}

function updateRoleControls() {
  const role = state.role;
  document.querySelectorAll('[data-roles]').forEach((element) => {
    element.hidden = !element.dataset.roles.split(',').includes(role);
  });
  document.querySelector('#operations-requisitions').hidden = ![
    'facility_user', 'health_worker', 'operations_manager', 'admin',
  ].includes(role);
  document.querySelector('#operations-telemetry').hidden = ![
    'cold_chain_officer', 'operations_manager', 'admin',
  ].includes(role);
  document.querySelector('#operations-risk').hidden = !['cold_chain_officer', 'operations_manager', 'admin'].includes(role);
  document.querySelector('#operations-stock').hidden = ![
    'facility_user', 'health_worker', 'operations_manager', 'admin',
  ].includes(role);
  document.querySelector('#operations-access-requests').hidden = role !== 'admin';
  requisitionForm.hidden = !['facility_user', 'health_worker'].includes(role);
  telemetryForm.hidden = role !== 'cold_chain_officer';
  stockForm.hidden = role !== 'operations_manager';
}

function renderBatches() {
  const container = document.querySelector('#operations-telemetry-list');
  const rows = state.batches.map((batch) => `
    <tr>
      <td>${escapeHtml(batch.vaccineId)}<br>${escapeHtml(batch.shipmentId || 'No shipment ID')}</td>
      <td>${escapeHtml(batch.vaccineName)}</td>
      <td>${escapeHtml(batch.currentTempCelsius)} °C<br>${escapeHtml(batch.safeRangeCelsius.min)}–${escapeHtml(batch.safeRangeCelsius.max)} °C</td>
      <td><span class="status-badge ${batch.coldChainStatus === 'OK' ? 'status-valid' : 'status-danger'}">${escapeHtml(batch.coldChainStatus)}</span></td>
      <td>${escapeHtml(batch.lastCheckedAt)}</td>
    </tr>
  `).join('');
  container.innerHTML = rows
    ? `<table class="operations-table"><thead><tr><th>Batch / shipment</th><th>Vaccine</th><th>Reading / range</th><th>Cold chain</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No telemetry batches are available.</p>';

  const options = state.batches
    .map((batch) => `<option value="${escapeHtml(batch.vaccineId)}">${escapeHtml(batch.vaccineId)} · ${escapeHtml(batch.vaccineName)} · ${escapeHtml(batch.coldChainStatus)}</option>`)
    .join('');
  document.querySelector('#requisition-batch').innerHTML = '<option value="">No batch assigned yet</option>' + options;
  document.querySelector('#telemetry-batch').innerHTML = '<option value="">Choose a batch</option>' + options;
  document.querySelector('#stock-batch').innerHTML = '<option value="">Choose a batch</option>' + options;
}

function renderInventory() {
  const container = document.querySelector('#operations-stock-list');
  const rows = state.inventory.map((item) => `
    <tr>
      <td>${escapeHtml(item.vaccineId)}<br>${escapeHtml(item.vaccineName)}</td>
      <td>${escapeHtml(item.stockQuantity)}</td>
      <td>${escapeHtml(item.expirationDate)}</td>
      <td>${escapeHtml(item.warehouseCode)}</td>
    </tr>
  `).join('');
  container.innerHTML = rows
    ? `<table class="operations-table"><thead><tr><th>Legacy HIS batch</th><th>Available</th><th>Expires</th><th>Warehouse</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No warehouse inventory is available.</p>';
}

function renderRequisitions() {
  const container = document.querySelector('#operations-requisition-list');
  const canChangeStatus = state.role === 'operations_manager';
  const statusClasses = {
    APPROVED: 'status-valid',
    HOLD: 'status-warning',
    PENDING: 'status-pending',
    REJECTED: 'status-danger',
  };
  document.querySelector('#operations-requisitions h3').textContent = ['health_worker', 'facility_user'].includes(state.role)
    ? 'My clinic requisitions'
    : 'Clinic vaccine requisitions';
  document.querySelector('#requisition-help').textContent = ['health_worker', 'facility_user'].includes(state.role)
    ? 'Only requests submitted by your account are shown here.'
    : 'Track submitted requests and their latest review status.';
  const rows = state.requisitions.map((item) => `
    <tr>
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.clinicId)} · ${escapeHtml(item.vaccineType)}<br>${escapeHtml(item.quantity)} doses${item.vaccineId ? ` · ${escapeHtml(item.vaccineId)}` : ''}</td>
      <td><span class="status-badge ${statusClasses[item.status] || ''}">${escapeHtml(item.status)}</span>${item.telemetryStatus ? `<br>Cold chain: ${escapeHtml(item.telemetryStatus)}` : ''}</td>
      <td>${escapeHtml(new Date(item.createdAt).toLocaleString())}</td>
      ${canChangeStatus ? `<td>
        <label class="visually-hidden" for="status-${escapeHtml(item.id)}">Update ${escapeHtml(item.id)} status</label>
        <select id="status-${escapeHtml(item.id)}" data-status-for="${escapeHtml(item.id)}">
          ${['APPROVED', 'REJECTED', 'HOLD'].map((status) => `<option value="${status}" ${status === item.status ? 'selected' : ''}>${status}</option>`).join('')}
        </select>
        <label class="visually-hidden" for="batch-${escapeHtml(item.id)}">Assign a registered batch to ${escapeHtml(item.id)}</label>
        <select id="batch-${escapeHtml(item.id)}" data-batch-for="${escapeHtml(item.id)}">
          <option value="">${item.vaccineId ? `Keep ${escapeHtml(item.vaccineId)}` : 'Assign a registered batch'}</option>
          ${state.batches.map((batch) => `<option value="${escapeHtml(batch.vaccineId)}" ${batch.vaccineId === item.vaccineId ? 'selected' : ''}>${escapeHtml(batch.vaccineId)} — ${escapeHtml(batch.vaccineName)} (${escapeHtml(batch.coldChainStatus)})</option>`).join('')}
        </select>
        <button class="small" type="button" data-action="update-status" data-id="${escapeHtml(item.id)}">Update</button>
      </td>` : ''}
    </tr>
  `).join('');
  container.innerHTML = rows
    ? `<table class="operations-table"><thead><tr><th>Request</th><th>Clinic / vaccine</th><th>Status</th><th>Submitted</th>${canChangeStatus ? '<th>Review</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`
    : `<p>${['health_worker', 'facility_user'].includes(state.role) ? 'You have not submitted any requisitions yet.' : 'No clinic requisitions have been submitted.'}</p>`;
}

function renderAccessRequests(accounts) {
  const container = document.querySelector('#operations-access-request-list');
  const rows = accounts.map((account) => `
    <tr>
      <td>${escapeHtml(account.fullName)}<br>${escapeHtml(account.email)}</td>
      <td>${escapeHtml(account.staffId)}<br>${escapeHtml(account.jobTitle)}</td>
      <td>${escapeHtml(account.facility)}</td>
      <td>${escapeHtml(account.status)}</td>
      <td>
        ${account.role === 'admin'
    ? '<strong>Protected system administrator</strong>'
    : `
        <label class="visually-hidden" for="account-role-${escapeHtml(account.username)}">Role for ${escapeHtml(account.username)}</label>
        <select id="account-role-${escapeHtml(account.username)}" data-account-role="${escapeHtml(account.username)}" ${account.status === 'SUSPENDED' ? 'disabled' : ''}>
          ${['facility_user', 'health_worker', 'cold_chain_officer', 'operations_manager'].map((role) => `<option value="${role}" ${role === account.role ? 'selected' : ''}>${escapeHtml(roleLabels[role])}</option>`).join('')}
        </select>
        ${account.status === 'PENDING'
    ? `<button class="small" type="button" data-action="approve-account" data-username="${escapeHtml(account.username)}">Approve</button>
        <button class="secondary small" type="button" data-action="reject-account" data-username="${escapeHtml(account.username)}">Reject</button>`
    : account.status === 'SUSPENDED'
      ? `<button class="small" type="button" data-action="activate-account" data-username="${escapeHtml(account.username)}">Restore access</button>`
      : `<button class="small" type="button" data-action="set-role" data-username="${escapeHtml(account.username)}">Save role</button>
        <button class="secondary small" type="button" data-action="suspend-account" data-username="${escapeHtml(account.username)}">Suspend</button>`}
        `}
      </td>
    </tr>
  `).join('');
  container.innerHTML = rows
    ? `<table class="operations-table"><thead><tr><th>Staff member</th><th>Staff ID / job title</th><th>Facility</th><th>Status</th><th>Role</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No self-registered staff accounts are available to manage.</p>';
}

async function refreshServiceStatus() {
  const container = document.querySelector('#operations-service-status');
  const response = await fetch('/api/ready');
  const result = await response.json();
  const rows = result.services.map(({ service, status }) => `
    <li><span>${escapeHtml(service)}</span><span class="status-badge ${status === 'UP' ? 'status-valid' : 'status-danger'}">${escapeHtml(status)}</span></li>
  `).join('');
  container.innerHTML = `
    <p>Gateway status: <span class="status-badge ${result.status === 'ready' ? 'status-valid' : 'status-danger'}">${escapeHtml(result.status)}</span></p>
    <ul class="service-status-list">${rows}</ul>
  `;
}

async function refreshWorkspace({ preserveFeedback = false } = {}) {
  if (!state.role) {
    return;
  }
  if (!preserveFeedback) {
    setFeedback('Refreshing shared service data…');
  }
  const requests = [];
  if (['cold_chain_officer', 'operations_manager', 'admin'].includes(state.role)) {
    requests.push(apiRequest('/telemetry').then((batches) => {
      state.batches = batches;
      renderBatches();
    }));
  }
  if (state.role === 'admin') {
    requests.push(apiRequest('/admin/accounts').then(renderAccessRequests));
    requests.push(refreshServiceStatus());
  }
  if (['facility_user', 'health_worker', 'operations_manager', 'admin'].includes(state.role)) {
    requests.push(apiRequest('/requisitions').then((items) => {
      state.requisitions = items;
      renderRequisitions();
    }));
  }
  if (['facility_user', 'health_worker', 'operations_manager', 'admin'].includes(state.role)) {
    requests.push(apiRequest('/stock/warehouse/WAREHOUSE-MNL').then((result) => {
      state.inventory = result.items;
      renderInventory();
    }));
  }
  const results = await Promise.allSettled(requests);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    const messages = [...new Set(failures.map(({ reason }) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      return message.toLowerCase() === 'failed to fetch'
        ? 'Could not connect to BakunaPass. Check that the server is running, then refresh.'
        : message;
    }))];
    setFeedback(messages.join(' · '), 'error');
  } else if (!preserveFeedback) {
    setFeedback('Connected to the BakunaPass gateway and backend services.', 'success');
  }
}

async function onSubmit(form, action) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await action(new FormData(form));
      form.reset();
      await refreshWorkspace({ preserveFeedback: true });
    } catch (error) {
      const details = error.details?.field ? ` (${error.details.field})` : '';
      setFeedback(`${error.message}${details}`, 'error');
      if (error.code === 'COLD_CHAIN_BREACH') {
        await refreshWorkspace({ preserveFeedback: true });
      }
    } finally {
      button.disabled = false;
    }
  });
}

document.querySelector('#operations-logout').addEventListener('click', async () => {
  try {
    await apiRequest('/auth/logout', { method: 'POST', authenticated: false });
  } catch (error) {
    setFeedback(`Sign-out could not be completed: ${error.message}`, 'error');
    return;
  }
  clearSession();
  setFeedback('Signed out. The browser session token was cleared.', 'success');
  window.location.assign('/auth.html');
});

document.querySelector('#operations-refresh').addEventListener('click', refreshWorkspace);

onSubmit(requisitionForm, async (formData) => {
  const payload = {
    clinicId: formData.get('clinicId').toString().trim(),
    vaccineType: formData.get('vaccineType').toString().trim(),
    quantity: Number(formData.get('quantity')),
  };
  const vaccineId = formData.get('vaccineId').toString();
  if (vaccineId) {
    const batch = state.batches.find((entry) => entry.vaccineId === vaccineId);
    if (!batch) {
      throw new Error('Refresh the batch list and select a currently registered batch.');
    }
    payload.vaccineId = vaccineId;
    payload.vaccineType = batch.vaccineName;
  }
  const result = await apiRequest('/requisitions', { method: 'POST', payload });
  setFeedback(`Requisition ${result.id} created with status ${result.status}.`, 'success');
});

onSubmit(telemetryForm, async (formData) => {
  const vaccineId = formData.get('vaccineId').toString().trim();
  const batch = state.batches.find((entry) => entry.vaccineId === vaccineId);
  if (!batch) {
    throw new Error('Select an existing registered vaccine batch.');
  }
  const humidityValue = formData.get('humidityPercent').toString();
  const result = await apiRequest('/telemetry', {
    method: 'POST',
    payload: {
      vaccineId,
      vaccineName: batch.vaccineName,
      currentTempCelsius: Number(formData.get('currentTempCelsius')),
      ...(humidityValue ? { humidityPercent: Number(humidityValue) } : {}),
    },
  });
  setFeedback(`Reading recorded for ${result.vaccineId}: ${result.coldChainStatus}.`, 'success');
});

onSubmit(riskForm, async (formData) => {
  const shipmentId = formData.get('shipmentId').toString().trim();
  const result = await apiRequest(`/risk-assessment/shipment/${encodeURIComponent(shipmentId)}`);
  const container = document.querySelector('#operations-risk-result');
  const summary = document.createElement('p');
  summary.textContent = `${result.assessment.level}${result.assessment.score === null ? '' : ` · demonstration score ${result.assessment.score}/100`}`;
  const reasons = document.createElement('ul');
  result.assessment.reasons.forEach((reason) => {
    const item = document.createElement('li');
    item.textContent = reason;
    reasons.append(item);
  });
  const sources = document.createElement('pre');
  sources.textContent = JSON.stringify(result.sources, null, 2);
  container.replaceChildren(summary, reasons, sources);
  setFeedback(`Risk assessment completed for ${result.shipmentId}; verify each source status.`, 'success');
});

onSubmit(stockForm, async (formData) => {
  const result = await apiRequest('/stock/reserve', {
    method: 'POST',
    payload: {
      vaccineId: formData.get('vaccineId').toString(),
      quantity: Number(formData.get('quantity')),
    },
  });
  setFeedback(`SOAP inventory reservation completed. ${result.stockQuantity} doses remain.`, 'success');
});

document.querySelector('#operations-requisition-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="update-status"]');
  if (!button) {
    return;
  }
  const status = document.querySelector(`[data-status-for="${CSS.escape(button.dataset.id)}"]`).value;
  const vaccineId = document.querySelector(`[data-batch-for="${CSS.escape(button.dataset.id)}"]`).value;
  button.disabled = true;
  try {
    const result = await apiRequest(`/requisitions/${encodeURIComponent(button.dataset.id)}/status`, {
      method: 'PUT',
      payload: { status, ...(vaccineId ? { vaccineId } : {}) },
    });
    setFeedback(`Requisition ${result.id} status updated to ${result.status}.`, 'success');
    await refreshWorkspace({ preserveFeedback: true });
  } catch (error) {
    setFeedback(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#operations-access-request-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="approve-account"], [data-action="reject-account"], [data-action="set-role"], [data-action="suspend-account"], [data-action="activate-account"]');
  if (!button) {
    return;
  }
  const username = button.dataset.username;
  const action = button.dataset.action;
  const isApproval = action === 'approve-account';
  const isRejection = action === 'reject-account';
  const role = document.querySelector(`[data-account-role="${CSS.escape(username)}"]`).value;
  button.disabled = true;
  try {
    await apiRequest(`/admin/accounts/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      payload: {
        action: isApproval ? 'APPROVE' : isRejection ? 'REJECT' : 'SET_ROLE',
        ...(action === 'suspend-account' ? { action: 'SUSPEND' }
          : action === 'activate-account' ? { action: 'ACTIVATE' }
            : { role }),
      },
    });
    const message = isApproval
      ? `Staff access request for ${username} approved as ${roleLabels[role]}.`
      : isRejection
        ? `Staff access request for ${username} rejected.`
        : action === 'suspend-account'
          ? `Access for ${username} suspended.`
          : action === 'activate-account'
            ? `Access for ${username} restored.`
            : `${username}'s role updated to ${roleLabels[role]}.`;
    setFeedback(message, 'success');
    await refreshWorkspace({ preserveFeedback: true });
  } catch (error) {
    setFeedback(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

async function initializeWorkspace() {
  try {
    const session = await apiRequest('/auth/session', { authenticated: false });
    state.role = session.role;
    state.username = session.fullName || session.username;
  } catch {
    clearSession();
    window.location.replace('/auth.html');
    return;
  }
  updateSessionView();
  await refreshWorkspace();
}

initializeWorkspace().catch((error) => setFeedback(error.message, 'error'));
