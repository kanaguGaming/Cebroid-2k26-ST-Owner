/**
 * ============================================================
 * CONTESTANT PORTAL – app.js
 * Cephroid Shark Tank 2K26
 * ============================================================
 *
 * RESPONSIBILITY:
 *  - Login: authenticates contestant teams against the same
 *    Google Apps Script / Google Sheet endpoint used by the
 *    investor portal.
 *  - Dashboard: polls the API at a regular interval to fetch
 *    the team's current Gold and Silver coin totals, animates
 *    the counters, updates the progress bar, shows top
 *    investors, and renders the project's QR code.
 *
 * GOOGLE SHEET SCHEMA
 *   Sheet "Users":
 *     Col A: Email | Col B: Password | Col C: Role | Col D: CoinsBalance | Col E: DisplayName
 *
 *   Sheet "Projects":
 *     Col A: ProjectId | Col B: ProjectName | Col C: TeamId
 *     Col D: LeadEmail | Col E: GoldCoins | Col F: SilverCoins
 *     Col G: FundingGoal | Col H: Category
 *
 *   Sheet "Transactions":
 *     Col A: Timestamp | Col B: InvestorEmail | Col C: InvestorRole
 *     Col D: ProjectId | Col E: Amount | Col F: CoinType
 *
 * APPS SCRIPT ENDPOINTS:
 *   GET  ?action=login&email=...&password=...
 *   GET  ?action=getProjectStats&projectId=...
 *   GET  ?action=getTopInvestors&projectId=...
 * ============================================================
 */

'use strict';

/* ──────────────────────────────────────────
   CONFIGURATION
────────────────────────────────────────── */
/** @type {string} Google Apps Script Web App deployment URL */
const SHEET_API_URL = 'https://script.google.com/macros/s/AKfycbwMAG3ataiZrbQoDaZAWtuU97LfOx3mYUSApIzC0Gz217cT1I_0j4gvaNP8OrSDOU8g/exec';

/**
 * How often (in ms) to poll the API for live funding stats.
 * 10 seconds is a good balance between freshness and quota usage.
 */
const POLL_INTERVAL_MS = 10_000;

/**
 * Default funding goal (coins) shown on the progress bar.
 * Override this from your Google Sheet's Projects data.
 */
const DEFAULT_FUNDING_GOAL = 500;

/* ──────────────────────────────────────────
   PAGE DETECTION
────────────────────────────────────────── */
const PAGE = document.body.classList.contains('dashboard-body') ? 'dashboard' : 'login';


/* ============================================================
   UTILITIES (shared with investor portal conventions)
============================================================ */

/**
 * Show a transient toast notification.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} [duration=3500]
 */
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const icons = { success: '✅', error: '❌', info: 'ℹ️' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'status');
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type]}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
}

/**
 * Store a JSON-serialisable value in sessionStorage under a namespaced key.
 * @param {string} key
 * @param {*} value
 */
function storeSession(key, value) {
  sessionStorage.setItem(`cephroid_c_${key}`, JSON.stringify(value));
}

/**
 * Read and parse a value from sessionStorage.
 * @param {string} key
 * @returns {*|null}
 */
function getSession(key) {
  const raw = sessionStorage.getItem(`cephroid_c_${key}`);
  return raw ? JSON.parse(raw) : null;
}

/** Clear session and navigate back to login. */
function logout() {
  ['user', 'project'].forEach(k => sessionStorage.removeItem(`cephroid_c_${k}`));
  window.location.href = 'index.html';
}

/**
 * Smoothly animate an integer counter element from its current value to a target.
 * @param {HTMLElement} el
 * @param {number} target
 * @param {number} [duration=700]
 */
function animateCounter(el, target, duration = 700) {
  const start  = parseInt(el.textContent.replace(/,/g, ''), 10) || 0;
  const delta  = target - start;
  if (delta === 0) return;

  // Trigger the CSS flip animation
  el.classList.add('animating');
  setTimeout(() => el.classList.remove('animating'), 420);

  const startTs = performance.now();
  const step = (ts) => {
    const progress = Math.min((ts - startTs) / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);       // ease-out cubic
    el.textContent = Math.round(start + delta * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Fetch JSON from a URL with an AbortController timeout.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>}
 */
async function apiFetch(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

/** Format a Date object as HH:MM:SS */
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}


/* ============================================================
   ── LOGIN PAGE LOGIC ──
============================================================ */

/**
 * Authenticate a contestant team against the Apps Script endpoint.
 * Only accounts with role === 'contestant' are allowed in this portal.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ success: boolean, user: Object, project: Object }>}
 */
async function attemptLogin(email, password) {
  /* ------------------------------------------------------------------
   * MOCK DATA – Replace with real apiFetch() when Apps Script is ready.
   * ------------------------------------------------------------------ */
  const MOCK_TEAMS = [
    {
      email: 'team_ecosense@cephroid.in', password: 'eco2026',
      role: 'contestant', displayName: 'EcoSense Team',
      project: {
        projectId:   'P001',
        projectName: 'EcoSense',
        teamId:      'T07',
        category:    'GreenTech',
        goldCoins:   120,
        silverCoins: 85,
        fundingGoal: 500,
        topInvestors: [
          { name: 'Dr. Ramesh',   coins: 80,  coinType: '🥇' },
          { name: 'Prof. Meera',  coins: 40,  coinType: '🥇' },
          { name: 'Arun Kumar',   coins: 50,  coinType: '🥈' },
          { name: 'Priya S.',     coins: 35,  coinType: '🥈' },
        ],
      },
    },
    {
      email: 'team_agribot@cephroid.in', password: 'agri2026',
      role: 'contestant', displayName: 'AgriBot Team',
      project: {
        projectId:   'P002',
        projectName: 'AgriBot',
        teamId:      'T12',
        category:    'AgriTech',
        goldCoins:   200,
        silverCoins: 60,
        fundingGoal: 500,
        topInvestors: [
          { name: 'Dr. Ramesh',   coins: 150, coinType: '🥇' },
          { name: 'Arun Kumar',   coins: 60,  coinType: '🥈' },
        ],
      },
    },
    {
      email: 'team_medlink@cephroid.in', password: 'med2026',
      role: 'contestant', displayName: 'MedLink Team',
      project: {
        projectId:   'P003',
        projectName: 'MedLink',
        teamId:      'T03',
        category:    'HealthTech',
        goldCoins:   50,
        silverCoins: 30,
        fundingGoal: 500,
        topInvestors: [
          { name: 'Prof. Meera',  coins: 50,  coinType: '🥇' },
          { name: 'Priya S.',     coins: 30,  coinType: '🥈' },
        ],
      },
    },
  ];

  // Simulate network latency
  await new Promise(r => setTimeout(r, 800));

  const team = MOCK_TEAMS.find(
    t => t.email.toLowerCase() === email.toLowerCase() && t.password === password
  );

  if (!team) throw new Error('Invalid team credentials. Please try again.');
  if (team.role !== 'contestant') throw new Error('This portal is for contestant teams only.');

  return {
    success: true,
    user:    { email: team.email, displayName: team.displayName, role: team.role },
    project: team.project,
  };

  /* ------------------------------------------------------------------
   * REAL API CALL (uncomment when Apps Script is deployed):
   * ------------------------------------------------------------------
   * const url = `${SHEET_API_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
   * const data = await apiFetch(url);
   * if (!data.success) throw new Error(data.message || 'Login failed.');
   * if (data.user.role !== 'contestant') throw new Error('This portal is for contestant teams only.');
   * return data;
   */
}

/** Initialise the login page: validation, toggle, submission. */
function initLoginPage() {
  const form          = document.getElementById('loginForm');
  const emailInput    = document.getElementById('emailInput');
  const passwordInput = document.getElementById('passwordInput');
  const togglePassBtn = document.getElementById('togglePassword');
  const loginBtn      = document.getElementById('loginBtn');
  const authError     = document.getElementById('authError');
  const authErrorMsg  = document.getElementById('authErrorMsg');

  if (!form) return;

  // Already logged in? Redirect.
  if (getSession('user') && getSession('project')) {
    window.location.href = 'dashboard.html';
    return;
  }

  // Toggle password visibility
  togglePassBtn.addEventListener('click', () => {
    const isPass = passwordInput.type === 'password';
    passwordInput.type = isPass ? 'text' : 'password';
    passwordInput.focus();
  });

  // Clear errors on input
  [emailInput, passwordInput].forEach(input => {
    input.addEventListener('input', () => {
      input.closest('.form-group').classList.remove('has-error');
      const errEl = input.closest('.form-group').querySelector('.field-error');
      if (errEl) errEl.textContent = '';
      authError.hidden = true;
    });
  });

  // Form submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email    = emailInput.value.trim();
    const password = passwordInput.value;
    let hasError   = false;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      markFieldError('emailGroup', 'emailError', 'Enter a valid team email address.');
      hasError = true;
    }
    if (!password || password.length < 4) {
      markFieldError('passwordGroup', 'passwordError', 'Enter your team password or PIN.');
      hasError = true;
    }
    if (hasError) return;

    setLoading(true);
    authError.hidden = true;

    try {
      const data = await attemptLogin(email, password);

      storeSession('user',    data.user);
      storeSession('project', data.project);

      showToast(`Welcome, ${data.user.displayName}! 🚀`, 'success');
      setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);

    } catch (err) {
      authErrorMsg.textContent = err.message || 'Login failed. Please try again.';
      authError.hidden = false;
      authError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      setLoading(false);
    }
  });

  function markFieldError(groupId, errorId, msg) {
    document.getElementById(groupId).classList.add('has-error');
    document.getElementById(errorId).textContent = msg;
  }

  function setLoading(loading) {
    loginBtn.disabled = loading;
    loginBtn.querySelector('.btn-text').textContent = loading ? 'Authenticating…' : 'Access Dashboard';
    loginBtn.querySelector('.btn-spinner').hidden   = !loading;
  }
}


/* ============================================================
   ── DASHBOARD PAGE LOGIC ──
============================================================ */

/** Handle for the polling setInterval. */
let pollTimer = null;

/** Last known project stats (for change detection). */
let lastStats = { goldCoins: -1, silverCoins: -1 };

/** Boot the dashboard. */
function initDashboardPage() {
  // Auth guard
  const user    = getSession('user');
  const project = getSession('project');

  if (!user || !project) {
    window.location.href = 'index.html';
    return;
  }

  // Render initial state from session (fast paint)
  hydrateIdentity(project);
  updateStats(project);
  renderLeaderboard(project.topInvestors || []);
  generateQRCode(project);

  // Wire logout
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    clearInterval(pollTimer);
    logout();
  });

  // Start live polling
  startPolling(project.projectId);
}

/**
 * Populate the Project Identity section.
 * @param {Object} project
 */
function hydrateIdentity(project) {
  document.getElementById('projectName').textContent      = project.projectName || '—';
  document.getElementById('teamIdBadge').textContent      = `Team ID: ${project.teamId || '—'}`;
  document.getElementById('projectCategory').textContent  = `Category: ${project.category || '—'}`;
  document.title = `${project.projectName} | Cephroid Shark Tank`;
}

/**
 * Update all stat elements: counters, progress bar, milestones, total.
 * @param {{ goldCoins, silverCoins, fundingGoal }} stats
 */
function updateStats(stats) {
  const gold   = stats.goldCoins   ?? 0;
  const silver = stats.silverCoins ?? 0;
  const goal   = stats.fundingGoal ?? DEFAULT_FUNDING_GOAL;
  const total  = gold + silver;

  // Animate counters only if values changed
  if (gold !== lastStats.goldCoins) {
    animateCounter(document.getElementById('goldCoinCount'), gold);
  }
  if (silver !== lastStats.silverCoins) {
    animateCounter(document.getElementById('silverCoinCount'), silver);
  }

  lastStats = { goldCoins: gold, silverCoins: silver };

  // Total
  animateCounter(document.getElementById('totalCoins'), total);

  // Progress bar
  const pct = Math.min(Math.round((total / goal) * 100), 100);

  const progressFill = document.getElementById('progressFill');
  const progressGlow = document.getElementById('progressGlow');
  const progressPct  = document.getElementById('progressPct');
  const progressBar  = document.getElementById('progressBarWrap');
  const goalEl       = document.getElementById('fundingGoal');

  progressFill.style.width = `${pct}%`;
  progressGlow.style.left  = `${pct}%`;
  progressPct.textContent  = `${pct}%`;
  goalEl.textContent       = goal.toLocaleString();

  // ARIA
  progressBar.setAttribute('aria-valuenow', pct);

  // Milestone markers
  [
    { id: 'milestone25',  threshold: 25  },
    { id: 'milestone50',  threshold: 50  },
    { id: 'milestone75',  threshold: 75  },
    { id: 'milestone100', threshold: 100 },
  ].forEach(({ id, threshold }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('reached', pct >= threshold);
  });

  // Celebration toast when 100% is first hit
  if (pct >= 100 && lastStats._celebrated !== true) {
    lastStats._celebrated = true;
    showToast('🎉 Funding goal reached! Congratulations!', 'success', 6000);
  }
}

/**
 * Render the top investors leaderboard.
 * @param {Array<{ name, coins, coinType }>} investors
 */
function renderLeaderboard(investors) {
  const list   = document.getElementById('leaderboardList');
  const empty  = document.getElementById('lbEmpty');

  if (!investors || investors.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }

  if (empty) empty.style.display = 'none';

  // Clear and rebuild
  list.innerHTML = '';

  // Sort descending by coins
  const sorted = [...investors].sort((a, b) => b.coins - a.coins);

  sorted.forEach((investor, idx) => {
    const rank    = idx + 1;
    const rankClass = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : '';
    const rankLabel = rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : `#${rank}`;

    const item = document.createElement('div');
    item.className = 'lb-item';
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      <span class="lb-rank ${rankClass}" aria-label="Rank ${rank}">${rankLabel}</span>
      <span class="lb-name">${escapeHtml(investor.name)}</span>
      <span class="lb-coins">${investor.coins.toLocaleString()} <span class="lb-coin-type">${investor.coinType}</span></span>
    `;

    list.appendChild(item);
  });
}

/**
 * Minimal HTML escaping to prevent XSS from API data.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate and display the project's QR code.
 * Uses the free goqr.me API to render a QR from the project JSON payload.
 *
 * The QR encodes:
 *   { projectId, projectName, teamId }
 *
 * Investors scan this QR in the Investor Portal to identify the project.
 *
 * @param {Object} project
 */
function generateQRCode(project) {
  const qrImg     = document.getElementById('qrCodeImg');
  const qrCaption = document.getElementById('qrCaption');

  if (!qrImg) return;

  // Build the QR data payload (same format the investor portal expects)
  const qrData = JSON.stringify({
    projectId:   project.projectId,
    projectName: project.projectName,
    teamId:      project.teamId,
  });

  // goQR.me public API – free, no key required
  // For production, consider self-hosting a QR library like qrcode.js
  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&format=png&data=${encodeURIComponent(qrData)}`;

  qrImg.alt     = `QR Code for ${project.projectName}`;
  qrImg.src     = qrApiUrl;
  qrImg.onload  = () => { qrCaption.textContent = `${project.projectName} – ${project.teamId}`; };
  qrImg.onerror = () => { qrCaption.textContent = 'QR generation failed. Check your connection.'; };
}

/* ──────────────────────────────────────────
   LIVE POLLING
────────────────────────────────────────── */

/**
 * Start polling the Apps Script API for fresh project stats.
 * Updates coin counters, progress bar, and leaderboard on every cycle.
 *
 * @param {string} projectId
 */
function startPolling(projectId) {
  // Run once immediately, then on interval
  pollOnce(projectId);

  pollTimer = setInterval(() => pollOnce(projectId), POLL_INTERVAL_MS);
}

/**
 * Single poll cycle: fetch stats and render them.
 * @param {string} projectId
 */
async function pollOnce(projectId) {
  try {
    const stats = await fetchProjectStats(projectId);

    updateStats(stats);

    if (stats.topInvestors) {
      renderLeaderboard(stats.topInvestors);
    }

    // Persist updated project data
    const currentProject = getSession('project') ?? {};
    storeSession('project', { ...currentProject, ...stats });

    // Update timestamp
    const timeEl = document.getElementById('lastUpdatedTime');
    if (timeEl) timeEl.textContent = formatTime(new Date());

  } catch (err) {
    console.warn('[Poll] Failed to fetch stats:', err.message);
    // Non-fatal: the UI will retain its last values
  }
}

/**
 * Fetch project stats from the Apps Script.
 *
 * @param {string} projectId
 * @returns {Promise<{ goldCoins, silverCoins, fundingGoal, topInvestors }>}
 */
async function fetchProjectStats(projectId) {
  /* ------------------------------------------------------------------
   * MOCK RESPONSE – Simulates random coin increments.
   * Replace with real apiFetch() when Apps Script is deployed.
   * ------------------------------------------------------------------ */
  const current = getSession('project') ?? {};

  // Simulate occasional new investment (+0 to +15 coins per poll)
  const goldDelta   = Math.random() > 0.6 ? Math.floor(Math.random() * 15) : 0;
  const silverDelta = Math.random() > 0.7 ? Math.floor(Math.random() * 10) : 0;

  const newGold   = (current.goldCoins   ?? 0) + goldDelta;
  const newSilver = (current.silverCoins ?? 0) + silverDelta;

  return {
    goldCoins:    newGold,
    silverCoins:  newSilver,
    fundingGoal:  current.fundingGoal ?? DEFAULT_FUNDING_GOAL,
    topInvestors: current.topInvestors ?? [],
  };

  /* ------------------------------------------------------------------
   * REAL API CALL (uncomment when Apps Script is deployed):
   * ------------------------------------------------------------------
   * const statsUrl     = `${SHEET_API_URL}?action=getProjectStats&projectId=${encodeURIComponent(projectId)}`;
   * const investorsUrl = `${SHEET_API_URL}?action=getTopInvestors&projectId=${encodeURIComponent(projectId)}`;
   *
   * const [statsData, investorsData] = await Promise.all([
   *   apiFetch(statsUrl),
   *   apiFetch(investorsUrl),
   * ]);
   *
   * return {
   *   goldCoins:    statsData.goldCoins,
   *   silverCoins:  statsData.silverCoins,
   *   fundingGoal:  statsData.fundingGoal,
   *   topInvestors: investorsData.investors,
   * };
   */
}


/* ============================================================
   BOOTSTRAP
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  if (PAGE === 'login') {
    initLoginPage();
  } else {
    initDashboardPage();
  }
});
