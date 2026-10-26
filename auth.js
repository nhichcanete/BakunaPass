
const loginTab = document.querySelector('#login-tab');
const registerTab = document.querySelector('#register-tab');
const loginPanel = document.querySelector('#login-panel');
const registerPanel = document.querySelector('#register-panel');
const loginForm = document.querySelector('#login-form');
const registerForm = document.querySelector('#register-form');
const feedback = document.querySelector('#auth-feedback');
const registrationUnavailable = document.querySelector('#registration-unavailable');
const mfaSetupPanel = document.querySelector('#mfa-setup-panel');
const mfaChallengePanel = document.querySelector('#mfa-challenge-panel');
const mfaRecoveryPanel = document.querySelector('#mfa-recovery-panel');
const mfaSetupForm = document.querySelector('#mfa-setup-form');
const mfaChallengeForm = document.querySelector('#mfa-challenge-form');
let pendingRecoveryCodes = false;

function setFeedback(message, type = '') {
  feedback.textContent = message;
  feedback.classList.toggle('is-success', type === 'success');
  feedback.classList.toggle('is-error', type === 'error');
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.classList.toggle('is-loading', busy);
}

async function request(path, payload) {
  const response = await fetch(`./api/v1/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.message || 'The request could not be completed.');
    error.code = result.error;
    throw error;
  }
  return result;
}

function selectPanel(panel) {
  const isLogin = panel === 'login';
  loginTab.classList.toggle('is-active', isLogin);
  registerTab.classList.toggle('is-active', !isLogin);
  loginTab.setAttribute('aria-selected', String(isLogin));
  registerTab.setAttribute('aria-selected', String(!isLogin));
  loginPanel.hidden = !isLogin;
  registerPanel.hidden = isLogin;
  setFeedback('');
}

function showMfaPanel(panel) {
  loginForm.hidden = true;
  mfaSetupPanel.hidden = panel !== 'setup';
  mfaChallengePanel.hidden = panel !== 'challenge';
  mfaRecoveryPanel.hidden = panel !== 'recovery';
  loginTab.hidden = true;
  registerTab.hidden = true;
  if (panel === 'setup') {
    setFeedback('Two-factor authentication is required to finish setting up your account.');
  } else if (panel === 'challenge') {
    setFeedback('Verify your identity with your authenticator app.');
    document.querySelector('#mfa-challenge-code').focus();
  }
}

async function beginMfaSetup() {
  const setup = await request('mfa/setup', {});
  const link = document.querySelector('#mfa-authenticator-link');
  link.href = setup.otpauthUrl;
  document.querySelector('#mfa-secret').textContent = setup.secret;
  showMfaPanel('setup');
  document.querySelector('#mfa-setup-code').focus();
}

async function verifyMfa(form, enrollment) {
  setBusy(form, true);
  try {
    const result = await request('mfa/verify', {
      code: form.elements.code.value.trim(),
    });
    if (enrollment && result.recoveryCodes) {
      document.querySelector('#mfa-recovery-codes').textContent = result.recoveryCodes.join('\n');
      pendingRecoveryCodes = true;
      showMfaPanel('recovery');
      return;
    }
    window.location.assign('/workspace');
  } catch (error) {
    setFeedback(error.message, 'error');
    form.elements.code.focus();
  } finally {
    setBusy(form, false);
  }
}

loginTab.addEventListener('click', () => selectPanel('login'));
registerTab.addEventListener('click', () => selectPanel('register'));

for (const [tab, panel] of [[loginTab, 'login'], [registerTab, 'register']]) {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextTab = event.key === 'Home' || event.key === 'ArrowLeft' ? loginTab : registerTab;
    if (nextTab.disabled) return;
    nextTab.focus();
    selectPanel(nextTab === loginTab ? 'login' : 'register');
  });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(loginForm, true);
  try {
    const result = await request('token', {
      username: loginForm.elements.username.value.trim(),
      password: loginForm.elements.password.value,
    });
    sessionStorage.removeItem('bakunapass.operations.token');
    sessionStorage.removeItem('bakunapass.operations.role');
    sessionStorage.removeItem('bakunapass.operations.username');
    if (result.enrollmentRequired) {
      await beginMfaSetup();
      return;
    }
    if (result.mfaRequired) {
      showMfaPanel('challenge');
      return;
    }
    window.location.assign('/workspace');
  } catch (error) {
    setFeedback(error.message, 'error');
  } finally {
    setBusy(loginForm, false);
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = registerForm.elements.password.value;
  const confirmation = registerForm.elements.confirmPassword.value;
  if (password !== confirmation) {
    setFeedback('The passwords do not match. Please check and try again.', 'error');
    registerForm.elements.confirmPassword.focus();
    return;
  }
  setBusy(registerForm, true);
  try {
    const result = await request('register', {
      password,
      fullName: registerForm.elements.fullName.value.trim(),
      email: registerForm.elements.email.value.trim(),
      facility: registerForm.elements.facility.value.trim(),
      staffId: registerForm.elements.staffId.value.trim(),
      jobTitle: registerForm.elements.jobTitle.value.trim(),
    });
    registerForm.reset();
    setFeedback(result.message, 'success');
  } catch (error) {
    setFeedback(error.message, 'error');
  } finally {
    setBusy(registerForm, false);
  }
});

mfaSetupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  verifyMfa(mfaSetupForm, true);
});

mfaChallengeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  verifyMfa(mfaChallengeForm, false);
});

document.querySelector('#mfa-continue').addEventListener('click', () => {
  if (!pendingRecoveryCodes) {
    return;
  }
  pendingRecoveryCodes = false;
  window.location.assign('/workspace');
});

fetch('./api/v1/auth/config')
  .then(async (response) => {
    if (!response.ok) throw new Error('Authentication settings could not be loaded.');
    return response.json();
  })
  .then((configuration) => {
    registerForm.hidden = !configuration.registrationEnabled;
    registrationUnavailable.hidden = configuration.registrationEnabled;
    if (!configuration.loginEnabled) {
      setFeedback('Staff sign-in is not configured. Contact your system administrator.', 'error');
    }
  })
  .catch((error) => {
    registerForm.hidden = true;
    registrationUnavailable.hidden = false;
    setFeedback(error.message, 'error');
  });
