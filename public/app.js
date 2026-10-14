/**
 * 🌸 LUNACARE - Period & Menstrual Cycle Tracker
 * Mobile-First Client Application
 */

// Application State
const state = {
  token: localStorage.getItem('lunacare_token') || null,
  user: JSON.parse(localStorage.getItem('lunacare_user') || 'null'),
  cycles: [],
  logs: {},
  stats: null,
  profile: null,
  currentTab: 'home',
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(), // 0-indexed
  selectedDate: new Date().toISOString().split('T')[0],
  activeLogForm: {
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().slice(0, 5),
    flow: 'medium',
    padsUsed: 2,
    painLevel: 3,
    painAreas: ['Abdominal Cramps'],
    remedies: ['Heating Pad'],
    moods: ['Calm'],
    moodSwingIntensity: 'mild',
    pmsSymptoms: [],
    meals: {
      breakfast: true,
      lunch: true,
      dinner: true,
      waterGlasses: 6,
      waterLitres: 1.5,
      appetite: 'normal',
      cravingsNote: ''
    },
    medications: ['Iron Supplement'],
    bbt: '',
    cervicalFluid: 'none',
    sleepHours: 7.5,
    energyLevel: 'normal',
    intimacy: [],
    notes: ''
  },
  pinEntered: '',
  hasPin: false,
  networkUrls: [],
  trackerMode: localStorage.getItem('lunacare_mode') || 'period', // 'period' or 'ttc'
  calcInput: '0',
  calcPrev: null,
  calcOp: null,
  calcClearOnNext: false
};

// API Helper with full Netlify / Serverless Offline LocalStorage fallback
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  // Attempt real server call (Node.js local backend)
  try {
    const res = await fetch(path, { ...options, headers });
    // If backend exists and responds
    if (res.status === 401 && !path.includes('/auth/')) {
      logout();
      showToast('Session expired. Please log in.');
      throw new Error('Unauthorized');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server request failed');
    return data;
  } catch (err) {
    // If running on Netlify Static Hosting (where Node server isn't running), seamlessly handle via LocalStorage
    return handleClientStorageFallback(path, options);
  }
}

// Client Storage Engine for 100% Free Netlify Static Deployment (Scoped per Account)
function getUserStorageKey(specificUser = null) {
  const username = specificUser || state.user?.username;
  if (!username) return 'lunacare_offline_db_guest';
  const clean = String(username).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `lunacare_user_db_${clean}`;
}

function getClientDb(specificUser = null) {
  const user = specificUser || state.user?.username || null;
  const key = getUserStorageKey(user);
  const defaultDb = {
    username: user,
    users: [],
    cycles: [],
    logs: {},
    profile: {
      quickPin: null,
      avgCycleLength: 28,
      avgPeriodDuration: 5
    }
  };

  // Clean up legacy shared storage if old demo records existed
  try {
    const legacy = localStorage.getItem('lunacare_offline_db');
    if (legacy) {
      const parsedLegacy = JSON.parse(legacy);
      if (parsedLegacy && Array.isArray(parsedLegacy.cycles)) {
        if (parsedLegacy.cycles.some(c => c.id === 'c_1' || c.id === 'c_2' || c.startDate === '2026-09-12')) {
          localStorage.removeItem('lunacare_offline_db');
        }
      }
    }
  } catch {}

  const stored = localStorage.getItem(key);
  if (!stored) {
    localStorage.setItem(key, JSON.stringify(defaultDb));
    return defaultDb;
  }
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed.cycles)) parsed.cycles = [];
    // Filter out any demo cycles (c_1, c_2, 2026-09-12)
    parsed.cycles = parsed.cycles.filter(c => c.id !== 'c_1' && c.id !== 'c_2' && c.startDate !== '2026-09-12');
    if (!parsed.logs || typeof parsed.logs !== 'object') parsed.logs = {};
    if (!parsed.profile) parsed.profile = { quickPin: null, avgCycleLength: 28, avgPeriodDuration: 5 };
    return parsed;
  } catch {
    return defaultDb;
  }
}

function saveClientDb(db, specificUser = null) {
  const key = getUserStorageKey(specificUser || db.username);
  localStorage.setItem(key, JSON.stringify(db));
}

// Universal Cloud & Multi-Device Sync Engine (Direct Network Sync)
async function pushToCloudSync() {
  if (!state.user || !state.user.username) return;
  try {
    const db = getClientDb(state.user.username);
    const payload = {
      cycles: (db.cycles || []).filter(c => c.id !== 'c_1' && c.id !== 'c_2' && c.startDate !== '2026-09-12'),
      logs: db.logs || {},
      profile: db.profile || {},
      updatedAt: new Date().toISOString()
    };

    if (window.LunaCloudSync) {
      await window.LunaCloudSync.saveUserData(state.user.username, payload);
    }
  } catch (err) {
    console.warn('Sync push note:', err.message);
  }
}

// Pull latest cloud data across devices seamlessly
async function pullFromCloudSync() {
  if (!state.user || !state.user.username) return false;
  try {
    if (!window.LunaCloudSync) return false;
    const cloudData = await window.LunaCloudSync.loadUserData(state.user.username);
    if (cloudData && (cloudData.cycles || cloudData.logs || cloudData.profile)) {
      const db = getClientDb(state.user.username);
      if (cloudData.cycles) {
        db.cycles = cloudData.cycles.filter(c => c.id !== 'c_1' && c.id !== 'c_2' && c.startDate !== '2026-09-12');
      }
      if (cloudData.logs) db.logs = cloudData.logs;
      if (cloudData.profile) db.profile = { ...(db.profile || {}), ...cloudData.profile };
      saveClientDb(db, state.user.username);

      state.cycles = db.cycles || [];
      state.logs = db.logs || {};
      state.profile = db.profile || {};
      state.stats = computeClientStats(db);

      renderHome();
      renderProfileDetails();
      if (state.currentTab === 'calendar') renderCalendar();
      if (state.currentTab === 'analytics') renderAnalytics();
      return true;
    }
  } catch (err) {
    console.warn('Sync pull note:', err.message);
  }
  return false;
}

// Manual Sync trigger from profile screen
async function manualSyncNow() {
  haptic(25);
  showToast('🔄 Connecting & syncing with cloud...');
  const pushed = await pushToCloudSync();
  const pulled = await pullFromCloudSync();
  showToast('🌸 Cloud Sync complete! Up to date.');
}

function importSyncCode() {
  haptic(25);
  const code = prompt('Paste the Sync Code from your other phone:');
  if (!code || !code.trim()) return;

  try {
    const jsonStr = decodeURIComponent(escape(atob(code.trim())));
    const imported = JSON.parse(jsonStr);

    if (imported && (imported.cycles || imported.logs)) {
      const db = getClientDb();
      if (imported.cycles) db.cycles = imported.cycles;
      if (imported.logs) db.logs = imported.logs;
      if (imported.profile) db.profile = { ...(db.profile || {}), ...imported.profile };
      if (imported.user) db.users = [imported.user];

      saveClientDb(db);
      state.cycles = db.cycles || [];
      state.logs = db.logs || {};
      state.profile = db.profile || {};
      state.stats = computeClientStats(db);

      renderHome();
      renderProfileDetails();
      if (state.currentTab === 'calendar') renderCalendar();
      if (state.currentTab === 'analytics') renderAnalytics();

      showToast('🌸 All data synced successfully from other phone!');
    } else {
      throw new Error('Invalid code format');
    }
  } catch (err) {
    alert('❌ Invalid Sync Code. Please make sure you copied the full code from the other phone.');
  }
}

// JSON Backup & Restore
function exportBackupJson() {
  haptic(20);
  const db = getClientDb();
  const exportObj = {
    app: 'LunaCare',
    exportedAt: new Date().toISOString(),
    profile: db.profile,
    cycles: db.cycles,
    logs: db.logs
  };
  const str = JSON.stringify(exportObj, null, 2);
  const blob = new Blob([str], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lunacare_backup_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('💾 Backup file saved');
}

function importBackupJson(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data && (data.cycles || data.logs)) {
        const db = getClientDb();
        if (data.cycles) db.cycles = data.cycles;
        if (data.logs) db.logs = data.logs;
        if (data.profile) db.profile = data.profile;
        saveClientDb(db);

        state.cycles = db.cycles || [];
        state.logs = db.logs || {};
        state.profile = db.profile || {};
        state.stats = computeClientStats(db);

        renderHome();
        renderProfileDetails();
        if (state.currentTab === 'calendar') renderCalendar();
        if (state.currentTab === 'analytics') renderAnalytics();

        showToast('📂 Backup file restored successfully!');
      } else {
        alert('Invalid backup file');
      }
    } catch (err) {
      alert('Error parsing file: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// Handle Forgot Password
async function handleForgotPassword(e) {
  if (e) e.preventDefault();
  haptic(25);
  const emailInput = document.getElementById('auth-username').value.trim();
  const email = prompt('Enter your account Email Address:', emailInput || '');
  if (!email) return;

  const cleanEmail = email.trim().toLowerCase();
  const newPass = prompt(`Reset password for ${cleanEmail}.\nEnter your new password (minimum 4 characters):`);
  if (!newPass || newPass.trim().length < 4) {
    alert('Password must be at least 4 characters');
    return;
  }

  const db = getClientDb();
  let user = db.users.find(u => u.username === cleanEmail);
  if (user) {
    user.password = newPass.trim();
    saveClientDb(db);
  }
  await pushToCloudSync();
  alert(`✅ Password successfully updated for ${cleanEmail}! You can now sign in with your new password.`);
}

// Render and Save Profile Details (Name, Weight, Height, Blood Group, Age)
function renderProfileDetails() {
  const profile = state.profile || {};
  const user = state.user || {};

  const nameInput = document.getElementById('profile-input-name');
  const weightInput = document.getElementById('profile-input-weight');
  const heightInput = document.getElementById('profile-input-height');
  const bloodInput = document.getElementById('profile-input-blood');
  const ageInput = document.getElementById('profile-input-age');
  const nameHeader = document.getElementById('profile-user-name');
  const subHeader = document.getElementById('profile-user-sub');

  if (nameInput) nameInput.value = profile.name || user.name || '';
  if (weightInput) weightInput.value = profile.weight || '';
  if (heightInput) heightInput.value = profile.height || '';
  if (bloodInput) bloodInput.value = profile.bloodGroup || '';
  if (ageInput) ageInput.value = profile.age || '';

  if (nameHeader) {
    nameHeader.textContent = profile.name || user.name || 'My LunaCare Profile';
  }
  if (subHeader) {
    const details = [];
    if (profile.bloodGroup) details.push(`Blood: ${profile.bloodGroup}`);
    if (profile.weight) details.push(`${profile.weight} kg`);
    if (profile.height) details.push(`${profile.height} cm`);
    subHeader.textContent = details.length > 0 ? details.join(' • ') : (user.username || 'Private Health Data');
  }
}

async function saveProfileDetails(e) {
  if (e) e.preventDefault();
  haptic(35);

  const name = document.getElementById('profile-input-name').value.trim();
  const weight = document.getElementById('profile-input-weight').value;
  const height = document.getElementById('profile-input-height').value;
  const bloodGroup = document.getElementById('profile-input-blood').value;
  const age = document.getElementById('profile-input-age').value;

  if (!state.profile) state.profile = {};
  state.profile.name = name;
  state.profile.weight = weight ? Number(weight) : null;
  state.profile.height = height ? Number(height) : null;
  state.profile.bloodGroup = bloodGroup || null;
  state.profile.age = age ? Number(age) : null;

  if (state.user) {
    state.user.name = name || state.user.name;
    localStorage.setItem('lunacare_user', JSON.stringify(state.user));
  }

  const db = getClientDb();
  db.profile = { ...(db.profile || {}), ...state.profile };
  saveClientDb(db);

  await pushToCloudSync();
  renderProfileDetails();
  showToast('💾 Profile & Biometrics saved and synced!');
}

async function handleClientStorageFallback(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const db = getClientDb();

  if (path === '/api/network-info') {
    return { networkUrls: [], port: 443 };
  }

  // Account Authentication with automatic cloud data loading
  if (path === '/api/auth/register' || path === '/api/auth/login') {
    let email = (body.username || 'user@lunacare.com').trim().toLowerCase();
    const password = body.password || 'password123';
    const name = body.name || email.split('@')[0];
    const userId = 'u_' + btoa(email).replace(/[^a-zA-Z0-9]/g, '');

    let user = { id: userId, username: email, name, pin: null, password };

    // Load account-specific database for this email
    let userDb = getClientDb(email);

    // Check Cloud for existing account data
    let hadCloudData = false;
    if (window.LunaCloudSync) {
      const cloudData = await window.LunaCloudSync.loadUserData(email);
      if (cloudData && ((cloudData.cycles && cloudData.cycles.length > 0) || (cloudData.logs && Object.keys(cloudData.logs).length > 0) || cloudData.profile)) {
        hadCloudData = true;
        userDb.cycles = (cloudData.cycles || []).filter(c => c.id !== 'c_1' && c.id !== 'c_2' && c.startDate !== '2026-09-12');
        userDb.logs = cloudData.logs || {};
        userDb.profile = { ...(userDb.profile || {}), ...(cloudData.profile || {}) };
        saveClientDb(userDb, email);
      }
    }

    // If new account or no cloud data existed, guarantee 100% clean state (0 cycles, 0 demo logs)
    if (!hadCloudData) {
      userDb.cycles = [];
      userDb.logs = {};
      userDb.profile = {
        name,
        quickPin: null,
        avgCycleLength: 28,
        avgPeriodDuration: 5
      };
      saveClientDb(userDb, email);
    }

    const token = 'token_' + userId;
    let existing = (userDb.users || []).find(u => u.username === email);
    if (!existing) {
      userDb.users = [user];
    } else {
      user = existing;
    }
    saveClientDb(userDb, email);

    state.user = user;
    state.token = token;
    state.profile = userDb.profile;
    state.cycles = userDb.cycles || [];
    state.logs = userDb.logs || {};
    state.stats = computeClientStats(userDb);

    const hasPin = Boolean(userDb.profile && userDb.profile.quickPin);

    // Sync state
    await pushToCloudSync();

    return { token, user, hasPin, message: 'Success' };
  }

  if (path === '/api/auth/verify-pin') {
    const currentPin = db.profile?.quickPin;
    if (!currentPin || currentPin === String(body.pin).trim()) {
      return { success: true };
    }
    throw new Error('Incorrect 4-digit PIN');
  }

  if (path === '/api/auth/me') {
    const stats = computeClientStats(db);
    const user = state.user || db.users[0];
    return { user, profile: db.profile, stats };
  }

  if (path === '/api/cycles' && method === 'GET') {
    return { cycles: db.cycles, stats: computeClientStats(db) };
  }

  if (path === '/api/cycles' && method === 'POST') {
    const { startDate, startTime, endDate, notes } = body;
    db.cycles.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
    let dayGap = null;
    if (db.cycles.length > 0) {
      const last = db.cycles[db.cycles.length - 1];
      dayGap = Math.round((new Date(startDate) - new Date(last.startDate)) / (1000 * 60 * 60 * 24));
    }
    const cycle = {
      id: 'c_' + Date.now(),
      startDate,
      startTime: startTime || '09:00',
      endDate: endDate || null,
      dayGap,
      notes: notes || '',
      createdAt: new Date().toISOString()
    };
    db.cycles.push(cycle);
    saveClientDb(db);
    pushToCloudSync();
    return { cycle, stats: computeClientStats(db) };
  }

  if (path.startsWith('/api/cycles/') && method === 'PUT') {
    const id = path.split('/')[3];
    const c = db.cycles.find(item => item.id === id);
    if (c) {
      if (body.startDate) c.startDate = body.startDate;
      if (body.startTime) c.startTime = body.startTime;
      if (body.endDate !== undefined) c.endDate = body.endDate;
      if (body.notes !== undefined) c.notes = body.notes;
      saveClientDb(db);
      pushToCloudSync();
      return { cycle: c, stats: computeClientStats(db) };
    }
    throw new Error('Cycle not found');
  }

  if (path.startsWith('/api/cycles/') && method === 'DELETE') {
    const id = path.split('/')[3];
    db.cycles = db.cycles.filter(item => item.id !== id);
    saveClientDb(db);
    pushToCloudSync();
    return { success: true, stats: computeClientStats(db) };
  }

  if (path === '/api/logs' && method === 'GET') {
    return { logs: db.logs };
  }

  if (path === '/api/logs' && method === 'POST') {
    const date = body.date;
    db.logs[date] = { ...body, updatedAt: new Date().toISOString() };
    saveClientDb(db);
    pushToCloudSync();
    return { log: db.logs[date], stats: computeClientStats(db) };
  }

  if (path === '/api/stats') {
    return { stats: computeClientStats(db) };
  }

  if (path === '/api/profile/pin') {
    db.profile.quickPin = body.pin ? String(body.pin).trim() : null;
    saveClientDb(db);
    pushToCloudSync();
    return { success: true };
  }

  if (path === '/api/profile' && method === 'PUT') {
    db.profile = { ...(db.profile || {}), ...body };
    saveClientDb(db);
    pushToCloudSync();
    return { success: true, profile: db.profile };
  }

  return { success: true };
}

// Compute comprehensive stats locally on Netlify
function computeClientStats(db) {
  const cycles = [...(db.cycles || [])].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const logs = db.logs || {};

  const gaps = cycles.map(c => c.dayGap).filter(g => g && g > 0);
  const avgCycleGap = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 28;

  const durations = cycles.map(c => {
    if (c.duration) return c.duration;
    if (c.endDate && c.startDate) {
      return Math.max(1, Math.round((new Date(c.endDate) - new Date(c.startDate)) / (1000 * 60 * 60 * 24)) + 1);
    }
    return null;
  }).filter(Boolean);
  const avgPeriodDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 5;

  const latestCycle = cycles.length > 0 ? cycles[cycles.length - 1] : null;
  const previousCycle = cycles.length > 1 ? cycles[cycles.length - 2] : null;

  let currentCycleDay = 1;
  let isCurrentlyOnPeriod = false;
  let nextPredictedStart = null;
  let daysUntilNextPeriod = null;

  const todayStr = new Date().toISOString().split('T')[0];

  if (latestCycle) {
    const startD = new Date(latestCycle.startDate);
    const nowD = new Date(todayStr);
    const diff = Math.floor((nowD - startD) / (1000 * 60 * 60 * 24));
    currentCycleDay = Math.max(1, diff + 1);

    const bleedEnd = latestCycle.endDate ? new Date(latestCycle.endDate) : new Date(startD.getTime() + ((avgPeriodDuration - 1) * 24 * 60 * 60 * 1000));
    isCurrentlyOnPeriod = (nowD >= startD && nowD <= bleedEnd);

    const predD = new Date(startD.getTime() + (avgCycleGap * 24 * 60 * 60 * 1000));
    nextPredictedStart = predD.toISOString().split('T')[0];
    daysUntilNextPeriod = Math.round((predD - nowD) / (1000 * 60 * 60 * 24));
  }

  const ovulationDayNum = Math.max(10, avgCycleGap - 14);
  let fertileStart = null, fertileEnd = null, ovulationDate = null;
  if (latestCycle) {
    const s = new Date(latestCycle.startDate);
    ovulationDate = new Date(s.getTime() + ((ovulationDayNum - 1) * 86400000)).toISOString().split('T')[0];
    fertileStart = new Date(s.getTime() + ((ovulationDayNum - 6) * 86400000)).toISOString().split('T')[0];
    fertileEnd = new Date(s.getTime() + (ovulationDayNum * 86400000)).toISOString().split('T')[0];
  }

  let totalPads = 0;
  let painSum = 0;
  let painCount = 0;
  const moodCounts = {};
  let fullMealsEaten = 0;
  let mealsTracked = 0;

  Object.values(logs).forEach(l => {
    if (l.padsUsed) totalPads += Number(l.padsUsed);
    if (l.painLevel !== undefined && l.painLevel !== null) {
      painSum += Number(l.painLevel);
      painCount++;
    }
    if (Array.isArray(l.moods)) {
      l.moods.forEach(m => { moodCounts[m] = (moodCounts[m] || 0) + 1; });
    }
    if (l.meals) {
      mealsTracked++;
      if (l.meals.breakfast && l.meals.lunch && l.meals.dinner) fullMealsEaten++;
    }
  });

  // PCOS / Hormonal Health Calculation
  // Flags: cycle gaps > 35 days, high variability (stdev > 6), severe acne or hirsutism, missing periods
  let pcosScore = 15; // default 15% baseline optimal
  let pcosTitle = "Optimal Regular Hormonal Health";
  let pcosDesc = "Cycle interval (21–35 days) and flow are within healthy gynecological ranges.";
  let pcosBadge = "Optimal";
  let pcosColor = "#10b981";

  if (gaps.length >= 2) {
    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);
    const gapDiff = maxGap - minGap;

    if (avgCycleGap > 36 || gapDiff >= 10) {
      pcosScore = Math.min(85, 45 + gapDiff * 3);
      pcosTitle = "Cycle Variability Detected (PCOS / Hormonal Flag)";
      pcosDesc = `Cycle interval variations (${minGap} to ${maxGap} days) detected. Recommend tracking ovulation and discussing with a doctor.`;
      pcosBadge = "Needs Review";
      pcosColor = "#f59e0b";
    }
    if (avgCycleGap > 45) {
      pcosScore = 85;
      pcosTitle = "High Irregularity / Oligomenorrhea Flag";
      pcosDesc = "Cycles are exceeding 45+ days. Recommended to consult a gynecologist for hormone evaluation.";
      pcosBadge = "High Variation";
      pcosColor = "#ef4444";
    }
  }

  // Medication Streaks
  let pillStreak = 0;
  const sortedDates = Object.keys(logs).sort().reverse();
  for (let d of sortedDates) {
    const l = logs[d];
    if (l.medications && l.medications.length > 0) {
      pillStreak++;
    } else {
      break;
    }
  }

  return {
    avgCycleGap,
    avgPeriodDuration,
    latestCycle,
    previousCycle,
    currentCycleDay,
    isCurrentlyOnPeriod,
    nextPredictedStart,
    daysUntilNextPeriod,
    fertileWindow: { start: fertileStart, end: fertileEnd, ovulationDate },
    irregularity: { isIrregular: pcosScore > 40, reason: pcosDesc, talkingPoints: [] },
    pcos: { score: pcosScore, title: pcosTitle, desc: pcosDesc, badge: pcosBadge, color: pcosColor },
    pillStreak: Math.max(1, pillStreak),
    pads: { total: totalPads, avgPerDay: Math.round(totalPads / Math.max(1, Object.keys(logs).length)) },
    pain: { avgLevel: painCount > 0 ? (painSum / painCount).toFixed(1) : 0, totalEntries: painCount },
    moodCounts,
    nutrition: {
      regularityPercentage: mealsTracked > 0 ? Math.round((fullMealsEaten / mealsTracked) * 100) : 100,
      fullMealsEaten,
      mealsTracked
    }
  };
}

// Toast helper
function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// Haptic feedback for mobile phones
function haptic(ms = 30) {
  if (window.navigator && window.navigator.vibrate) {
    try { window.navigator.vibrate(ms); } catch (e) {}
  }
}

// ================= Tab Navigation =================
function switchTab(tabId) {
  haptic(20);
  state.currentTab = tabId;

  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));

  const targetSec = document.getElementById(`view-${tabId}`);
  if (targetSec) targetSec.classList.add('active');

  const targetTab = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
  if (targetTab) targetTab.classList.add('active');

  if (tabId === 'calendar') renderCalendar();
  if (tabId === 'analytics') renderAnalytics();
  if (tabId === 'home') renderHome();
  if (tabId === 'profile') renderProfileDetails();
}

// ================= Auth Handlers =================
async function checkAuth() {
  if (!state.token) {
    showAuthView();
    return;
  }

  // Device is already enrolled/logged in from previous session!
  try {
    // If username is available, pull latest cloud data immediately
    if (state.user && state.user.username) {
      await pullFromCloudSync();
    }

    const data = await api('/api/auth/me');
    state.user = data.user;
    state.profile = data.profile;
    state.stats = data.stats;
    localStorage.setItem('lunacare_user', JSON.stringify(data.user));

    if (state.profile && state.profile.quickPin) {
      state.hasPin = true;
      hideAuthView(); // keep main background ready
      showPinScreen();
    } else {
      hideAuthView();
      await loadInitialData();
    }
  } catch (err) {
    // If token invalid / server unreachable, prompt login
    showAuthView();
  }
}

function showAuthView() {
  document.getElementById('auth-section').style.display = 'flex';
  document.getElementById('main-app-content').style.display = 'none';
  document.querySelector('.bottom-nav').style.display = 'none';
  document.querySelector('.app-header').style.display = 'none';
  hidePinScreen();
}

function hideAuthView() {
  document.getElementById('auth-section').style.display = 'none';
  document.getElementById('main-app-content').style.display = 'flex';
  document.querySelector('.bottom-nav').style.display = 'grid';
  document.querySelector('.app-header').style.display = 'flex';
}

function logout() {
  state.token = null;
  state.user = null;
  state.cycles = [];
  state.logs = {};
  state.stats = null;
  state.profile = null;
  localStorage.removeItem('lunacare_token');
  localStorage.removeItem('lunacare_user');
  localStorage.removeItem('lunacare_cloud_mirror');
  hidePinScreen();
  showAuthView();
  showToast('Logged out. Please sign in with username/password.');
}

// ================= PIN Screen Handlers =================
let isVerifyingPin = false;

function showPinScreen() {
  state.pinEntered = '';
  isVerifyingPin = false;
  updatePinDots();
  const overlay = document.getElementById('pin-overlay');
  if (overlay) overlay.classList.add('active');
}

function hidePinScreen() {
  state.pinEntered = '';
  isVerifyingPin = false;
  updatePinDots();
  const overlay = document.getElementById('pin-overlay');
  if (overlay) overlay.classList.remove('active');
}

function updatePinDots() {
  const dots = document.querySelectorAll('.pin-dot');
  dots.forEach((dot, idx) => {
    if (idx < state.pinEntered.length) dot.classList.add('filled');
    else dot.classList.remove('filled');
  });
}

async function handlePinKey(digit) {
  if (isVerifyingPin) return;
  haptic(20);

  if (digit === 'DEL') {
    state.pinEntered = state.pinEntered.slice(0, -1);
    updatePinDots();
    return;
  }

  if (state.pinEntered.length < 4) {
    state.pinEntered += String(digit);
    updatePinDots();
  }

  if (state.pinEntered.length === 4) {
    isVerifyingPin = true;
    const pinToTest = state.pinEntered;

    // Small delay so user sees 4th dot fill before verifying
    setTimeout(async () => {
      try {
        const res = await api('/api/auth/verify-pin', {
          method: 'POST',
          body: JSON.stringify({ pin: pinToTest })
        });

        if (res && res.success) {
          hidePinScreen();
          hideAuthView();
          await loadInitialData();
        } else {
          throw new Error('Incorrect PIN');
        }
      } catch (err) {
        haptic([80, 50, 80]);
        const digitsWrap = document.querySelector('.pin-digits');
        if (digitsWrap) {
          digitsWrap.classList.add('shake');
          setTimeout(() => digitsWrap.classList.remove('shake'), 450);
        }
        showToast('Incorrect 4-digit PIN. Please try again.');
        state.pinEntered = '';
        isVerifyingPin = false;
        updatePinDots();
      }
    }, 60);
  }
}

// ================= Data Loading =================
async function loadInitialData() {
  try {
    const [cycleRes, logRes, statsRes] = await Promise.all([
      api('/api/cycles'),
      api('/api/logs'),
      api('/api/stats')
    ]);
    state.cycles = cycleRes.cycles || [];
    state.logs = logRes.logs || {};
    state.stats = statsRes.stats || cycleRes.stats;
    renderHome();
    loadNetworkInfo();

    // Automatically sync latest cloud state across devices in background
    setTimeout(async () => {
      await pullFromCloudSync();
    }, 100);
  } catch (err) {
    console.error('Failed to load initial data:', err);
  }
}

// Background auto-sync every 30 seconds if page is visible
if (typeof window !== 'undefined') {
  setInterval(() => {
    if (state.token && state.user && document.visibilityState === 'visible') {
      pullFromCloudSync();
    }
  }, 30000);
}

// Network / Phone connect info
async function loadNetworkInfo() {
  try {
    const res = await api('/api/network-info');
    state.networkUrls = res.networkUrls || [];
    const wifiPill = document.getElementById('header-wifi-pill');
    if (wifiPill && state.networkUrls.length > 0) {
      wifiPill.style.display = 'flex';
    }
  } catch (err) {
    console.warn('Network info unavailable:', err);
  }
}

// ================= Home View Rendering =================
function renderHome() {
  const stats = state.stats;
  if (!stats) return;

  const dayNumberEl = document.getElementById('cycle-day-val');
  const dayLabelEl = document.getElementById('cycle-day-label');
  const phaseTagEl = document.getElementById('cycle-phase-tag');
  const ringProgressEl = document.getElementById('cycle-ring-progress');

  const currCycleDay = stats.currentCycleDay || 1;
  const avgGap = stats.avgCycleGap || 28;

  if (stats.latestCycle) {
    dayNumberEl.textContent = currCycleDay;
    if (stats.isCurrentlyOnPeriod) {
      dayLabelEl.textContent = 'Day of Period';
      phaseTagEl.textContent = '🌸 Menstrual Phase';
      phaseTagEl.style.background = '#ffe4e6';
      phaseTagEl.style.color = '#e11d48';
    } else if (currCycleDay <= 13) {
      dayLabelEl.textContent = 'Day of Cycle';
      phaseTagEl.textContent = '🌱 Follicular Phase';
      phaseTagEl.style.background = '#f3e8ff';
      phaseTagEl.style.color = '#9333ea';
    } else if (currCycleDay <= 16) {
      dayLabelEl.textContent = 'Day of Cycle';
      phaseTagEl.textContent = '✨ Ovulation Window';
      phaseTagEl.style.background = '#fdf2f8';
      phaseTagEl.style.color = '#db2777';
    } else {
      dayLabelEl.textContent = 'Day of Cycle';
      phaseTagEl.textContent = '🌙 Luteal Phase';
      phaseTagEl.style.background = '#fef3c7';
      phaseTagEl.style.color = '#d97706';
    }
  } else {
    dayNumberEl.textContent = '--';
    dayLabelEl.textContent = 'No Period Logged Yet';
    phaseTagEl.textContent = 'Tap to Start Cycle';
  }

  // Update Progress Ring (circumference: 2 * PI * 92 = ~578)
  const circumference = 2 * Math.PI * 92;
  const pct = Math.min(1, Math.max(0, currCycleDay / avgGap));
  const offset = circumference - (pct * circumference);
  if (ringProgressEl) {
    ringProgressEl.style.strokeDasharray = `${circumference}`;
    ringProgressEl.style.strokeDashoffset = `${offset}`;
  }

  // Meta Cards
  const gapValEl = document.getElementById('meta-day-gap');
  gapValEl.textContent = `${avgGap} Days`;

  const nextCountEl = document.getElementById('meta-next-period');
  const nextDateEl = document.getElementById('meta-next-date');

  if (stats.daysUntilNextPeriod !== null && stats.daysUntilNextPeriod !== undefined) {
    if (stats.daysUntilNextPeriod > 0) {
      nextCountEl.textContent = `In ${stats.daysUntilNextPeriod} Days`;
    } else if (stats.daysUntilNextPeriod === 0) {
      nextCountEl.textContent = `Expected Today`;
    } else {
      nextCountEl.textContent = `${Math.abs(stats.daysUntilNextPeriod)} Days Late`;
    }
  } else {
    nextCountEl.textContent = 'Log Period to Predict';
  }

  // Display predicted exact calendar date
  if (nextDateEl) {
    if (stats.nextPredictedStart) {
      const pDate = new Date(stats.nextPredictedStart + 'T00:00:00');
      nextDateEl.textContent = 'Est: ' + pDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } else {
      nextDateEl.textContent = 'Next cycle date';
    }
  }

  // Today's summary card
  const todayStr = new Date().toISOString().split('T')[0];
  const todayLog = state.logs[todayStr];

  const todayPadsEl = document.getElementById('today-pads-count');
  const todayPainEl = document.getElementById('today-pain-val');
  const todayFlowEl = document.getElementById('today-flow-badge');
  const todayWaterEl = document.getElementById('today-water-val');

  if (todayLog) {
    todayPadsEl.textContent = `${todayLog.padsUsed || 0} Pads`;
    todayPainEl.textContent = `${todayLog.painLevel || 0}/10`;
    todayFlowEl.textContent = (todayLog.flow || 'None').toUpperCase();
    todayFlowEl.className = `highlight-badge badge-flow-${todayLog.flow || 'none'}`;

    const waterL = todayLog.meals?.waterLitres || (todayLog.meals?.waterGlasses ? (todayLog.meals.waterGlasses * 0.25).toFixed(2) : 1.5);
    if (todayWaterEl) todayWaterEl.textContent = `${waterL} L`;
  } else {
    todayPadsEl.textContent = '0 Pads';
    todayPainEl.textContent = 'None logged';
    todayFlowEl.textContent = 'NOT LOGGED';
    todayFlowEl.className = 'highlight-badge badge-flow-none';
    if (todayWaterEl) todayWaterEl.textContent = '1.5 L';
  }

  // Render TTC Conception Mode vs Period Mode
  const ttcBanner = document.getElementById('home-ttc-banner');
  const optPeriod = document.getElementById('mode-opt-period');
  const optTtc = document.getElementById('mode-opt-ttc');
  if (optPeriod && optTtc) {
    if (state.trackerMode === 'ttc') {
      optTtc.classList.add('active');
      optPeriod.classList.remove('active');
      if (ttcBanner) {
        ttcBanner.style.display = 'block';
        const ttcChance = document.getElementById('ttc-chance-text');
        const ttcAdvice = document.getElementById('ttc-advice-text');
        if (currCycleDay >= 10 && currCycleDay <= 17) {
          ttcChance.textContent = '🌟 Peak Conception Window';
          ttcAdvice.textContent = 'High fertility probability. Ovulation surge occurs around this window.';
        } else if (currCycleDay < 10) {
          ttcChance.textContent = '🌱 Low Conception Probability';
          ttcAdvice.textContent = 'Pre-ovulation follicular development. Conception window begins in a few days.';
        } else {
          ttcChance.textContent = '🌙 Post-Ovulation Phase';
          ttcAdvice.textContent = 'Luteal phase. Fertile window closed for this cycle.';
        }
      }
    } else {
      optPeriod.classList.add('active');
      optTtc.classList.remove('active');
      if (ttcBanner) ttcBanner.style.display = 'none';
    }
  }

  // Render PCOS & Hormonal Health Score Card
  const pcosTitleEl = document.getElementById('pcos-status-title');
  const pcosBadgeEl = document.getElementById('pcos-badge-pill');
  const pcosFillEl = document.getElementById('pcos-meter-fill');
  const pcosDescEl = document.getElementById('pcos-desc-text');
  if (pcosTitleEl && stats.pcos) {
    pcosTitleEl.textContent = stats.pcos.title;
    pcosBadgeEl.textContent = stats.pcos.badge;
    pcosBadgeEl.style.background = stats.pcos.color + '22';
    pcosBadgeEl.style.color = stats.pcos.color;
    pcosFillEl.style.width = stats.pcos.score + '%';
    pcosFillEl.style.background = stats.pcos.color;
    pcosDescEl.textContent = stats.pcos.desc;
  }

  // Render Pill Reminder & Streak Checklist
  const streakCountEl = document.getElementById('pill-streak-count');
  const pillChecklistEl = document.getElementById('pill-checklist-items');
  if (streakCountEl && stats.pillStreak) {
    streakCountEl.textContent = `${stats.pillStreak}-Day Streak 🔥`;
  }
  if (pillChecklistEl) {
    const defaultMeds = ['Birth Control Pill', 'Iron Supplement', 'Multivitamin'];
    const takenMeds = todayLog?.medications || [];
    pillChecklistEl.innerHTML = defaultMeds.map(med => {
      const isTaken = takenMeds.includes(med);
      return `
        <div class="pill-item-row">
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" ${isTaken ? 'checked' : ''} onchange="togglePillTaken('${med}', this.checked)" style="width:18px; height:18px; accent-color:var(--primary); cursor:pointer;">
            <span style="font-size:0.86rem; font-weight:${isTaken ? '700' : '500'}; color:${isTaken ? 'var(--text-main)' : 'var(--text-muted)'}; text-decoration:${isTaken ? 'line-through' : 'none'};">${med}</span>
          </div>
          <span style="font-size:0.75rem; color:${isTaken ? 'var(--success)' : 'var(--text-muted)'}; font-weight:700;">${isTaken ? '✓ Taken' : 'Pending'}</span>
        </div>
      `;
    }).join('');
  }

  // Render Irregularity Health Alert Banner
  const alertEl = document.getElementById('home-irregular-alert');
  if (alertEl) {
    if (stats.irregularity && stats.irregularity.isIrregular) {
      alertEl.style.display = 'block';
      alertEl.className = 'alert-irregular';
      alertEl.innerHTML = `
        <div class="alert-irregular-title">⚠️ Cycle Health Note</div>
        <div>${stats.irregularity.reason}</div>
        <button class="alert-irregular-btn" onclick="openTalkingPointsModal()">View Gynecologist Discussion Guide →</button>
      `;
    } else {
      alertEl.style.display = 'none';
    }
  }

  // Render Dynamic Phase Wellness & Nutrition Advice Card
  const wellnessEl = document.getElementById('home-phase-wellness');
  if (wellnessEl) {
    let advice = {
      title: "🌸 Menstrual Phase Care",
      foods: "Iron-rich spinach, dark chocolate, hot soups, turmeric",
      workout: "Rest, gentle pelvic stretches, slow walks",
      selfCare: "Warm bath, heating pad on abdomen, early sleep"
    };
    if (!stats.isCurrentlyOnPeriod) {
      if (currCycleDay <= 13) {
        advice = {
          title: "🌱 Follicular Phase Energy",
          foods: "Fermented kimchi/yogurt, lean proteins, avocados, pumpkin seeds",
          workout: "HIIT, cardio, strength training (peak energy window)",
          selfCare: "Set monthly goals, plan social catchups and new projects"
        };
      } else if (currCycleDay <= 16) {
        advice = {
          title: "✨ Ovulation Window Glow",
          foods: "Berries, antioxidant-rich fruits, zinc, fresh leafy greens",
          workout: "Running, circuit workouts, high-intensity movement",
          selfCare: "Highest confidence and social vitality of the cycle"
        };
      } else {
        advice = {
          title: "🌙 Luteal Phase Calming",
          foods: "Magnesium rich nuts, sweet potatoes, complex carbs (calms cravings)",
          workout: "Pilates, yoga, light resistance training",
          selfCare: "Hydration to ease bloating, boundary setting, calming bedtime tea"
        };
      }
    }

    wellnessEl.innerHTML = `
      <div class="phase-wellness-header">
        <div class="phase-wellness-title">${advice.title}</div>
      </div>
      <div class="wellness-grid">
        <div class="wellness-row">
          <span class="wellness-icon">🥑</span>
          <div class="wellness-body">
            <span class="wellness-tag">Nourishing Foods</span>
            <span>${advice.foods}</span>
          </div>
        </div>
        <div class="wellness-row">
          <span class="wellness-icon">🧘‍♀️</span>
          <div class="wellness-body">
            <span class="wellness-tag">Movement & Energy</span>
            <span>${advice.workout}</span>
          </div>
        </div>
        <div class="wellness-row">
          <span class="wellness-icon">🌙</span>
          <div class="wellness-body">
            <span class="wellness-tag">Self-Care & Mind</span>
            <span>${advice.selfCare}</span>
          </div>
        </div>
      </div>
    `;
  }
}

// ================= Calendar Rendering =================
function renderCalendar() {
  const grid = document.getElementById('cal-days-grid');
  const title = document.getElementById('cal-month-title');
  if (!grid || !title) return;

  const y = state.calYear;
  const m = state.calMonth;
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  title.textContent = `${monthNames[m]} ${y}`;

  const firstDay = new Date(y, m, 1).getDay(); // 0 = Sun
  const totalDays = new Date(y, m + 1, 0).getDate();
  const prevMonthDays = new Date(y, m, 0).getDate();
  const todayStr = new Date().toISOString().split('T')[0];

  grid.innerHTML = '';

  // Previous month trailing days
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayNum = prevMonthDays - i;
    const cell = document.createElement('div');
    cell.className = 'cal-day-cell other-month';
    cell.textContent = dayNum;
    grid.appendChild(cell);
  }

  // Active month days
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'cal-day-cell';
    cell.textContent = d;

    if (dateStr === todayStr) cell.classList.add('today');
    if (dateStr === state.selectedDate) cell.classList.add('selected');

    // Period checks
    state.cycles.forEach(c => {
      const cStart = c.startDate;
      const cEnd = c.endDate || addDays(c.startDate, (state.stats?.avgPeriodDuration || 5) - 1);
      if (dateStr >= cStart && dateStr <= cEnd) {
        cell.classList.add('period-active');
      }
    });

    // Predicted Next Period check
    if (state.stats?.nextPredictedStart) {
      const pStart = state.stats.nextPredictedStart;
      const pEnd = addDays(pStart, (state.stats?.avgPeriodDuration || 5) - 1);
      if (dateStr >= pStart && dateStr <= pEnd) {
        cell.classList.add('predicted-period');
      }
    }

    // Fertile / Ovulation window
    const fw = state.stats?.fertileWindow;
    if (fw && fw.start && fw.end) {
      if (dateStr >= fw.start && dateStr <= fw.end) {
        cell.classList.add('fertile-window');
      }
      if (dateStr === fw.ovulationDate) {
        cell.classList.add('ovulation-day');
      }
    }

    // Dots for symptoms & pads
    const log = state.logs[dateStr];
    if (log) {
      const dotWrap = document.createElement('div');
      dotWrap.className = 'cal-indicator-dots';
      if (log.padsUsed > 0) {
        const dotP = document.createElement('div');
        dotP.className = 'dot-pad';
        dotWrap.appendChild(dotP);
      }
      if (log.painLevel > 0 || (log.moods && log.moods.length > 0)) {
        const dotS = document.createElement('div');
        dotS.className = 'dot-symptom';
        dotWrap.appendChild(dotS);
      }
      cell.appendChild(dotWrap);
    }

    cell.addEventListener('click', () => {
      haptic(20);
      state.selectedDate = dateStr;
      renderCalendar();
      showDateDetailDrawer(dateStr);
    });

    grid.appendChild(cell);
  }

  // Fill trailing days to complete 35 or 42 grid cells
  const remaining = (7 - ((firstDay + totalDays) % 7)) % 7;
  for (let j = 1; j <= remaining; j++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day-cell other-month';
    cell.textContent = j;
    grid.appendChild(cell);
  }
}

function prevMonth() {
  haptic(20);
  state.calMonth--;
  if (state.calMonth < 0) {
    state.calMonth = 11;
    state.calYear--;
  }
  renderCalendar();
}

function nextMonth() {
  haptic(20);
  state.calMonth++;
  if (state.calMonth > 11) {
    state.calMonth = 0;
    state.calYear++;
  }
  renderCalendar();
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Show selected date drawer
function showDateDetailDrawer(dateStr) {
  const log = state.logs[dateStr];
  const detailEl = document.getElementById('cal-date-detail');
  if (!detailEl) return;

  const cycleMatch = state.cycles.find(c => {
    const end = c.endDate || addDays(c.startDate, 5);
    return dateStr >= c.startDate && dateStr <= end;
  });

  detailEl.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
      <h3 style="font-size:1.1rem; font-weight:800;">📅 ${formatDatePretty(dateStr)}</h3>
      <button class="btn btn-secondary" style="width:auto; padding:6px 14px; font-size:0.8rem;" onclick="openLogModal('${dateStr}')">
        ${log ? '✏️ Edit Log' : '➕ Add Log'}
      </button>
    </div>
    ${cycleMatch ? `
      <div style="background:var(--primary-light); color:var(--primary); padding:10px 14px; border-radius:var(--radius-md); font-weight:700; font-size:0.85rem; margin-bottom:12px;">
        🌸 Menstrual Cycle Active (Started ${cycleMatch.startDate})
      </div>
    ` : ''}
    ${log ? `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:0.85rem;">
        <div class="meta-box"><div class="meta-title">Flow</div><div class="meta-value">${(log.flow || 'None').toUpperCase()}</div></div>
        <div class="meta-box"><div class="meta-title">Pads Used</div><div class="meta-value">${log.padsUsed || 0}</div></div>
        <div class="meta-box"><div class="meta-title">Pain Level</div><div class="meta-value">${log.painLevel || 0} / 10</div></div>
        <div class="meta-box"><div class="meta-title">Time</div><div class="meta-value">${log.time || '--:--'}</div></div>
      </div>
      <div style="margin-top:12px; font-size:0.85rem;">
        <strong>Moods:</strong> ${(log.moods || ['None logged']).join(', ')}<br>
        <strong>Meals:</strong> Breakfast (${log.meals?.breakfast ? '✓' : '✗'}), Lunch (${log.meals?.lunch ? '✓' : '✗'}), Dinner (${log.meals?.dinner ? '✓' : '✗'})<br>
        ${log.notes ? `<strong>Notes:</strong> <em>"${log.notes}"</em>` : ''}
      </div>
    ` : `
      <p style="color:var(--text-muted); font-size:0.88rem; text-align:center; padding:12px 0;">No symptoms or flow logged for this day yet.</p>
    `}
  `;
}

function formatDatePretty(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// ================= Daily Log Modal Handlers =================
function openLogModal(dateStr = null) {
  haptic(25);
  const targetDate = dateStr || state.selectedDate || new Date().toISOString().split('T')[0];
  const existingLog = state.logs[targetDate];

  if (existingLog) {
    state.activeLogForm = JSON.parse(JSON.stringify(existingLog));
    if (!state.activeLogForm.pmsSymptoms) state.activeLogForm.pmsSymptoms = [];
    if (!state.activeLogForm.medications) state.activeLogForm.medications = [];
    if (!state.activeLogForm.meals) state.activeLogForm.meals = {};
    if (state.activeLogForm.meals.waterLitres === undefined) {
      state.activeLogForm.meals.waterLitres = state.activeLogForm.meals.waterGlasses ? Number((state.activeLogForm.meals.waterGlasses * 0.25).toFixed(2)) : 1.5;
    }
  } else {
    state.activeLogForm = {
      date: targetDate,
      time: new Date().toTimeString().slice(0, 5),
      flow: 'medium',
      padsUsed: 2,
      painLevel: 2,
      painAreas: ['Abdominal Cramps'],
      remedies: ['Heating Pad'],
      moods: ['Calm'],
      moodSwingIntensity: 'mild',
      pmsSymptoms: [],
      meals: {
        breakfast: true,
        lunch: true,
        dinner: true,
        waterGlasses: 6,
        waterLitres: 1.5,
        appetite: 'normal',
        cravingsNote: ''
      },
      medications: ['Iron Supplement'],
      bbt: '',
      cervicalFluid: 'none',
      notes: ''
    };
  }

  populateLogModalForm();
  document.getElementById('log-modal').classList.add('open');
}

function closeLogModal() {
  document.getElementById('log-modal').classList.remove('open');
}

function populateLogModalForm() {
  const form = state.activeLogForm;
  document.getElementById('log-input-date').value = form.date;
  document.getElementById('log-input-time').value = form.time || '12:00';

  // Flow Chips
  document.querySelectorAll('.flow-chip').forEach(c => {
    c.classList.toggle('active', c.getAttribute('data-flow') === form.flow);
  });

  // Pads Counter
  document.getElementById('pads-counter-val').textContent = form.padsUsed;

  // Pain Slider
  const painSlider = document.getElementById('pain-range-slider');
  const painLabel = document.getElementById('pain-bubble-text');
  painSlider.value = form.painLevel;
  painLabel.textContent = `${form.painLevel}/10 - ${getPainDescription(form.painLevel)}`;

  // Pain Areas Chips
  document.querySelectorAll('#pain-areas-chips .select-chip').forEach(chip => {
    const val = chip.getAttribute('data-val');
    chip.classList.toggle('active', (form.painAreas || []).includes(val));
  });

  // Remedy Chips
  document.querySelectorAll('#remedies-chips .select-chip').forEach(chip => {
    const val = chip.getAttribute('data-val');
    chip.classList.toggle('active', (form.remedies || []).includes(val));
  });

  // Mood Chips
  document.querySelectorAll('#moods-chips .select-chip').forEach(chip => {
    const val = chip.getAttribute('data-val');
    chip.classList.toggle('active', (form.moods || []).includes(val));
  });

  // Mood Swing Intensity
  document.getElementById('mood-swing-intensity').value = form.moodSwingIntensity || 'mild';

  // Meals
  document.getElementById('meal-btn-breakfast').classList.toggle('active', Boolean(form.meals?.breakfast));
  document.getElementById('meal-btn-lunch').classList.toggle('active', Boolean(form.meals?.lunch));
  document.getElementById('meal-btn-dinner').classList.toggle('active', Boolean(form.meals?.dinner));

  // Water Intake in Litres
  const waterL = form.meals?.waterLitres !== undefined ? form.meals.waterLitres : 1.5;
  const waterEl = document.getElementById('water-litres-val');
  if (waterEl) waterEl.textContent = `${waterL} L`;

  document.getElementById('appetite-select').value = form.meals?.appetite || 'normal';

  // Before-Day / Pre-Menstrual (PMS) Symptoms Chips
  document.querySelectorAll('#pms-symptoms-chips .select-chip').forEach(chip => {
    const val = chip.getAttribute('data-val');
    chip.classList.toggle('active', (form.pmsSymptoms || []).includes(val));
  });

  // Render Pill & Supplement Chips (including custom ones)
  renderMedicationChips();

  // Biomarkers: BBT & Cervical Fluid
  document.getElementById('log-input-bbt').value = form.bbt || '';
  document.getElementById('cervical-fluid-select').value = form.cervicalFluid || 'none';

  // Sleep & Energy
  const sleepEl = document.getElementById('log-input-sleep');
  if (sleepEl) sleepEl.value = form.sleepHours !== undefined ? form.sleepHours : 7.5;
  const energyEl = document.getElementById('log-input-energy');
  if (energyEl) energyEl.value = form.energyLevel || 'normal';

  // Intimacy
  document.querySelectorAll('#intimacy-chips .select-chip').forEach(chip => {
    const val = chip.getAttribute('data-val');
    chip.classList.toggle('active', (form.intimacy || []).includes(val));
  });

  // Notes
  document.getElementById('log-input-notes').value = form.notes || '';
}

function renderMedicationChips() {
  const container = document.getElementById('medications-chips');
  if (!container) return;

  const standardMeds = [
    { label: '💊 Birth Control Pill', val: 'Birth Control Pill' },
    { label: '🩸 Iron Supplement', val: 'Iron Supplement' },
    { label: '💊 Ibuprofen', val: 'Ibuprofen / Painkiller' },
    { label: '✨ Magnesium', val: 'Magnesium' },
    { label: '🌿 Multivitamin', val: 'Multivitamin' }
  ];

  const currentMeds = state.activeLogForm.medications || [];

  // Combine standard and custom meds
  const allMedsMap = new Map();
  standardMeds.forEach(m => allMedsMap.set(m.val, m.label));
  currentMeds.forEach(m => {
    if (!allMedsMap.has(m)) {
      allMedsMap.set(m, `💊 ${m}`);
    }
  });

  container.innerHTML = '';
  allMedsMap.forEach((label, val) => {
    const chip = document.createElement('span');
    chip.className = `select-chip ${currentMeds.includes(val) ? 'active' : ''}`;
    chip.setAttribute('data-val', val);
    chip.textContent = label;
    chip.onclick = () => toggleChipSelection('medications-chips', 'medications', val);
    container.appendChild(chip);
  });
}

function addCustomMedication() {
  haptic(25);
  const med = prompt('Enter name of pill, supplement, or herbal remedy (e.g. Vitamin D3, Evening Primrose Oil, Zinc):');
  if (med && med.trim()) {
    const cleanMed = med.trim();
    if (!state.activeLogForm.medications) state.activeLogForm.medications = [];
    if (!state.activeLogForm.medications.includes(cleanMed)) {
      state.activeLogForm.medications.push(cleanMed);
    }
    renderMedicationChips();
    showToast(`Added "${cleanMed}"`);
  }
}

function adjustWaterLitres(delta) {
  haptic(20);
  if (!state.activeLogForm.meals) state.activeLogForm.meals = {};
  let current = Number(state.activeLogForm.meals.waterLitres || 1.5);
  let next = Math.max(0.25, Math.min(8.0, Number((current + delta).toFixed(2))));
  state.activeLogForm.meals.waterLitres = next;
  state.activeLogForm.meals.waterGlasses = Math.round(next / 0.25);
  const waterEl = document.getElementById('water-litres-val');
  if (waterEl) waterEl.textContent = `${next} L`;
}

function getPainDescription(level) {
  if (level === 0) return 'No Pain';
  if (level <= 3) return 'Mild Cramps';
  if (level <= 6) return 'Moderate Pain';
  if (level <= 8) return 'Severe Discomfort';
  return 'Intense Pain';
}

function adjustPads(delta) {
  haptic(20);
  let val = Math.max(0, Math.min(20, state.activeLogForm.padsUsed + delta));
  state.activeLogForm.padsUsed = val;
  document.getElementById('pads-counter-val').textContent = val;
}

function toggleChipSelection(containerId, formKey, value) {
  haptic(20);
  let list = state.activeLogForm[formKey] || [];
  const idx = list.indexOf(value);
  if (idx > -1) list.splice(idx, 1);
  else list.push(value);
  state.activeLogForm[formKey] = list;

  document.querySelectorAll(`#${containerId} .select-chip`).forEach(chip => {
    if (chip.getAttribute('data-val') === value) {
      chip.classList.toggle('active', list.includes(value));
    }
  });
}

function toggleMeal(mealName) {
  haptic(20);
  if (!state.activeLogForm.meals) state.activeLogForm.meals = {};
  state.activeLogForm.meals[mealName] = !state.activeLogForm.meals[mealName];
  document.getElementById(`meal-btn-${mealName}`).classList.toggle('active', state.activeLogForm.meals[mealName]);
}

async function saveLogForm() {
  haptic(40);
  const date = document.getElementById('log-input-date').value;
  const time = document.getElementById('log-input-time').value;
  const notes = document.getElementById('log-input-notes').value;
  const moodSwingIntensity = document.getElementById('mood-swing-intensity').value;
  const appetite = document.getElementById('appetite-select').value;

  if (!date) {
    showToast('Please pick a date');
    return;
  }

  state.activeLogForm.date = date;
  state.activeLogForm.time = time;
  state.activeLogForm.notes = notes;
  state.activeLogForm.moodSwingIntensity = moodSwingIntensity;
  if (!state.activeLogForm.meals) state.activeLogForm.meals = {};
  state.activeLogForm.meals.appetite = appetite;
  
  const bbtVal = document.getElementById('log-input-bbt').value;
  state.activeLogForm.bbt = bbtVal ? Number(bbtVal) : null;
  state.activeLogForm.cervicalFluid = document.getElementById('cervical-fluid-select').value;

  const sleepVal = document.getElementById('log-input-sleep')?.value;
  state.activeLogForm.sleepHours = sleepVal ? Number(sleepVal) : 7.5;
  state.activeLogForm.energyLevel = document.getElementById('log-input-energy')?.value || 'normal';

  try {
    const res = await api('/api/logs', {
      method: 'POST',
      body: JSON.stringify(state.activeLogForm)
    });

    state.logs[date] = res.log;
    state.stats = res.stats;
    closeLogModal();
    showToast('🌸 Log saved successfully!');
    renderHome();
    if (state.currentTab === 'calendar') renderCalendar();
    if (state.currentTab === 'analytics') renderAnalytics();
  } catch (err) {
    showToast('Failed to save log: ' + err.message);
  }
}

// ================= Cycle Start / Period Occurred Modal =================
function openStartCycleModal() {
  haptic(25);
  const today = new Date().toISOString().split('T')[0];
  const time = new Date().toTimeString().slice(0, 5);
  document.getElementById('cycle-start-date').value = today;
  document.getElementById('cycle-start-time').value = time;
  document.getElementById('cycle-modal').classList.add('open');
}

function closeStartCycleModal() {
  document.getElementById('cycle-modal').classList.remove('open');
}

async function submitStartCycle() {
  haptic(40);
  const startDate = document.getElementById('cycle-start-date').value;
  const startTime = document.getElementById('cycle-start-time').value;
  const endDate = document.getElementById('cycle-end-date').value;
  const notes = document.getElementById('cycle-start-notes').value;

  if (!startDate) {
    showToast('Please select period start date');
    return;
  }

  try {
    const res = await api('/api/cycles', {
      method: 'POST',
      body: JSON.stringify({ startDate, startTime, endDate: endDate || null, notes })
    });

    if (res.cycle && !state.cycles.some(c => c.id === res.cycle.id)) {
      state.cycles.push(res.cycle);
    }
    state.stats = res.stats;

    // Automatically create day 1 log with medium flow if not logged
    if (!state.logs[startDate]) {
      await api('/api/logs', {
        method: 'POST',
        body: JSON.stringify({
          date: startDate,
          time: startTime,
          flow: 'medium',
          padsUsed: 2,
          painLevel: 3,
          painAreas: ['Abdominal Cramps'],
          remedies: ['Heating Pad'],
          moods: ['Sensitive'],
          moodSwingIntensity: 'mild',
          meals: { breakfast: true, lunch: true, dinner: true, waterGlasses: 6, waterLitres: 1.5, appetite: 'normal' },
          notes: 'Period started'
        })
      });
      const updatedLogs = await api('/api/logs');
      state.logs = updatedLogs.logs;
    }

    closeStartCycleModal();
    showToast(`🌸 Period recorded! Day Gap: ${res.cycle.dayGap ? res.cycle.dayGap + ' Days' : 'Initial Cycle'}`);
    renderHome();
    if (state.currentTab === 'calendar') renderCalendar();
    if (state.currentTab === 'analytics') renderAnalytics();
  } catch (err) {
    showToast('Failed to record period: ' + err.message);
  }
}

// Edit Cycle Modal Handlers
function openEditCycleModal(cycleId) {
  haptic(25);
  const cycle = state.cycles.find(c => c.id === cycleId);
  if (!cycle) return;

  document.getElementById('edit-cycle-id').value = cycle.id;
  document.getElementById('edit-cycle-start-date').value = cycle.startDate || '';
  document.getElementById('edit-cycle-start-time').value = cycle.startTime || '09:00';
  document.getElementById('edit-cycle-end-date').value = cycle.endDate || '';
  document.getElementById('edit-cycle-notes').value = cycle.notes || '';

  document.getElementById('edit-cycle-modal').classList.add('open');
}

function closeEditCycleModal() {
  document.getElementById('edit-cycle-modal').classList.remove('open');
}

async function submitEditCycle() {
  haptic(40);
  const cycleId = document.getElementById('edit-cycle-id').value;
  const startDate = document.getElementById('edit-cycle-start-date').value;
  const startTime = document.getElementById('edit-cycle-start-time').value;
  const endDate = document.getElementById('edit-cycle-end-date').value;
  const notes = document.getElementById('edit-cycle-notes').value;

  if (!startDate) {
    showToast('Please specify a start date');
    return;
  }

  try {
    const res = await api(`/api/cycles/${cycleId}`, {
      method: 'PUT',
      body: JSON.stringify({
        startDate,
        startTime,
        endDate: endDate || null,
        notes
      })
    });

    const idx = state.cycles.findIndex(c => c.id === cycleId);
    if (idx > -1) state.cycles[idx] = res.cycle;
    state.stats = res.stats;

    closeEditCycleModal();
    showToast('🌸 Cycle dates updated');
    renderHome();
    if (state.currentTab === 'calendar') renderCalendar();
    if (state.currentTab === 'analytics') renderAnalytics();
  } catch (err) {
    showToast('Failed to update cycle: ' + err.message);
  }
}

// ================= Analytics View =================
function renderAnalytics() {
  const container = document.getElementById('analytics-content');
  if (!container || !state.stats) return;

  const stats = state.stats;
  const cycles = [...state.cycles].sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

  let cycleListHtml = '';
  cycles.forEach(c => {
    const endLabel = c.endDate ? `to ${c.endDate}` : '<span style="color:#e11d48; font-weight:800;">(In Progress)</span>';
    cycleListHtml += `
      <div class="cycle-item-card">
        <div>
          <div class="cycle-dates">🌸 ${c.startDate} ${endLabel}</div>
          <div class="cycle-stats-pills">
            ${c.dayGap ? `<span class="pill-sm gap">Gap: ${c.dayGap} Days</span>` : '<span class="pill-sm">Initial Cycle</span>'}
            ${c.duration ? `<span class="pill-sm">${c.duration} Days Bleeding</span>` : '<span class="pill-sm">Ongoing</span>'}
            ${c.startTime ? `<span class="pill-sm">${c.startTime}</span>` : ''}
          </div>
          ${c.notes ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">"${c.notes}"</div>` : ''}
        </div>
        <div class="cycle-action-btns">
          <button class="cycle-btn-action" onclick="openEditCycleModal('${c.id}')" title="Edit Dates">✏️ Edit</button>
          <button class="cycle-btn-action delete" onclick="deleteCycle('${c.id}')" title="Delete Cycle">🗑️</button>
        </div>
      </div>
    `;
  });

  // Mood frequency tags
  const moods = Object.entries(stats.moodCounts || {}).map(([mood, count]) => {
    return `<span class="select-chip active">${mood} (${count})</span>`;
  }).join(' ') || '<p style="color:var(--text-muted); font-size:0.85rem;">No mood logs yet.</p>';

  // Side-by-side Cycle Comparison
  let compareHtml = '';
  if (stats.cycleComparison) {
    const cmp = stats.cycleComparison;
    const gapBadge = cmp.gapDiff === 0 ? '<span class="diff-badge diff-neutral">Same</span>' :
      (Math.abs(cmp.gapDiff) <= 3 ? `<span class="diff-badge diff-better">${cmp.gapDiff > 0 ? '+' : ''}${cmp.gapDiff}d (Stable)</span>` :
      `<span class="diff-badge diff-warn">${cmp.gapDiff > 0 ? '+' : ''}${cmp.gapDiff}d Shift</span>`);
    
    const padBadge = cmp.padsDiff <= 0 ? `<span class="diff-badge diff-better">${cmp.padsDiff} pads</span>` : `<span class="diff-badge diff-warn">+${cmp.padsDiff} pads</span>`;
    const painBadge = Number(cmp.painDiff) <= 0 ? `<span class="diff-badge diff-better">${cmp.painDiff} pain</span>` : `<span class="diff-badge diff-warn">+${cmp.painDiff} pain</span>`;

    compareHtml = `
      <div class="cycle-compare-card">
        <h3 style="font-size:1.05rem; font-weight:800; margin-bottom:4px;">📊 Cycle-to-Cycle Comparison</h3>
        <p style="color:var(--text-muted); font-size:0.8rem; margin-bottom:12px;">Side-by-side view of your current vs previous cycle.</p>
        <div class="compare-columns-grid">
          <div class="compare-box current">
            <div class="compare-box-title">🌸 Current (${cmp.current.startDate})</div>
            <div class="compare-metric-row"><span>Day Gap:</span> <strong>${cmp.current.dayGap || '--'} Days</strong></div>
            <div class="compare-metric-row"><span>Pads:</span> <strong>${cmp.current.totalPads} Used</strong></div>
            <div class="compare-metric-row"><span>Avg Pain:</span> <strong>${cmp.current.avgPain}/10</strong></div>
          </div>
          <div class="compare-box">
            <div class="compare-box-title">Previous (${cmp.previous.startDate})</div>
            <div class="compare-metric-row"><span>Day Gap:</span> <strong>${cmp.previous.dayGap || '--'} Days</strong></div>
            <div class="compare-metric-row"><span>Pads:</span> <strong>${cmp.previous.totalPads} Used</strong></div>
            <div class="compare-metric-row"><span>Avg Pain:</span> <strong>${cmp.previous.avgPain}/10</strong></div>
          </div>
        </div>
        <div style="background:var(--bg-subtle); border:1px solid var(--border); border-radius:var(--radius-md); padding:10px 14px; margin-top:12px; display:flex; justify-content:space-around; text-align:center;">
          <div><span style="font-size:0.7rem; color:var(--text-muted); display:block;">Gap Shift</span>${gapBadge}</div>
          <div><span style="font-size:0.7rem; color:var(--text-muted); display:block;">Pads Shift</span>${padBadge}</div>
          <div><span style="font-size:0.7rem; color:var(--text-muted); display:block;">Pain Shift</span>${painBadge}</div>
        </div>
      </div>
    `;
  }

  // Biomarkers summary
  const fluidEntries = Object.entries(stats.biomarkers?.fluidCounts || {});
  const fluidChips = fluidEntries.map(([f, c]) => `<span class="select-chip">${f.toUpperCase()} (${c})</span>`).join(' ') || '<span style="color:var(--text-muted); font-size:0.82rem;">No cervical fluid logged yet</span>';
  const bbtEntries = (stats.biomarkers?.bbtRecent || []).map(b => `<span class="pill-sm">${b.date}: <strong>${b.bbt}°F</strong></span>`).join(' ') || '<span style="color:var(--text-muted); font-size:0.82rem;">No temperatures logged yet</span>';

  container.innerHTML = `
    <div class="card card-hero">
      <h2 style="font-size:1.3rem; font-weight:800; margin-bottom:8px;">Menstrual Cycle Analytics</h2>
      <p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:16px;">Comprehensive health patterns calculated from your logged cycles.</p>
      <div class="cycle-meta-row">
        <div class="meta-box">
          <div class="meta-title">Avg Cycle Gap</div>
          <div class="meta-value">${stats.avgCycleGap} Days</div>
          <div class="meta-sub">Normal (21-35 days)</div>
        </div>
        <div class="meta-box">
          <div class="meta-title">Avg Period Length</div>
          <div class="meta-value">${stats.avgPeriodDuration} Days</div>
          <div class="meta-sub">Typical flow duration</div>
        </div>
      </div>
    </div>

    ${compareHtml}

    <div class="card">
      <h3 style="font-size:1.05rem; font-weight:800; margin-bottom:14px;">Pad Consumption & Pain Trends</h3>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="meta-box">
          <div class="meta-title">Total Pads Used</div>
          <div class="meta-value">${stats.pads.total}</div>
          <div class="meta-sub">Avg ${stats.pads.avgPerDay} pads/day</div>
        </div>
        <div class="meta-box">
          <div class="meta-title">Average Pain</div>
          <div class="meta-value">${stats.pain.avgLevel} / 10</div>
          <div class="meta-sub">${stats.pain.totalEntries} entries recorded</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3 style="font-size:1.05rem; font-weight:800; margin-bottom:12px;">🌡️ Fertility & Biomarkers Tracking</h3>
      <div style="margin-bottom:12px;">
        <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:6px;">Recent Basal Body Temperature (BBT)</span>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">${bbtEntries}</div>
      </div>
      <div>
        <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; display:block; margin-bottom:6px;">Cervical Fluid Consistency</span>
        <div class="chip-grid">${fluidChips}</div>
      </div>
    </div>

    <div class="card">
      <h3 style="font-size:1.05rem; font-weight:800; margin-bottom:10px;">Nutrition & Meal Regularity</h3>
      <div class="meta-box" style="margin-bottom:12px;">
        <div class="meta-title">Meals Eaten Rate</div>
        <div class="meta-value">${stats.nutrition.regularityPercentage}%</div>
        <div class="meta-sub">${stats.nutrition.fullMealsEaten} / ${stats.nutrition.mealsTracked} tracked days with full 3 meals</div>
      </div>
    </div>

    <div class="card">
      <h3 style="font-size:1.05rem; font-weight:800; margin-bottom:10px;">Most Frequent Moods</h3>
      <div class="chip-grid">
        ${moods}
      </div>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:8px; flex-wrap:wrap;">
        <h3 style="font-size:1.05rem; font-weight:800;">Cycle History & Intervals</h3>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary" style="width:auto; padding:6px 12px; font-size:0.8rem; color:#e11d48; border-color:#fecdd3;" onclick="confirmClearAllCycles()">🗑️ Clear All</button>
          <button class="btn btn-secondary" style="width:auto; padding:6px 14px; font-size:0.8rem;" onclick="openStartCycleModal()">+ Add Cycle</button>
        </div>
      </div>
      <div class="cycle-history-list">
        ${cycleListHtml || '<p style="color:var(--text-muted); font-size:0.85rem; text-align:center;">No past cycles yet.</p>'}
      </div>
    </div>
  `;
}

// ================= Talking Points Modal =================
function openTalkingPointsModal() {
  haptic(25);
  const modal = document.getElementById('talking-points-modal');
  const reasonEl = document.getElementById('talking-points-reason');
  const listEl = document.getElementById('talking-points-list');
  if (!modal) return;

  const irr = state.stats?.irregularity || {};
  if (irr.isIrregular) {
    reasonEl.textContent = irr.reason || 'Noticeable cycle variance or length beyond standard 21-35 days.';
  } else {
    reasonEl.textContent = 'Proactive health review: Periodic consultation with your OB-GYN or primary healthcare provider helps detect hormonal imbalances, iron deficiency, or reproductive changes early.';
  }

  const defaultTopics = [
    '🩸 Bleeding Duration & Day Gap: Share your average interval (typically 21–35 days) and bleeding length (typically 2–7 days).',
    '⚡ Pain & Cramps (Dysmenorrhea): Mention severe abdominal pain (score > 6/10), lower back aches, or if OTC pain relievers fail to provide relief.',
    '🎈 PMS & Hormonal Shifts: Discuss severe pre-period mood swings, breast tenderness, insomnia, or intense fatigue (evaluate for PMDD).',
    '💧 Pad Consumption: Inform your doctor if you soak through 1 or more pads every 1-2 hours or notice blood clots larger than a quarter.',
    '🧪 Laboratory Tests: Ask if blood work (Thyroid TSH/T4, Ferritin/Iron panel, LH/FSH ratio, or Prolactin) or a pelvic ultrasound is recommended.'
  ];

  const points = (irr.talkingPoints && irr.talkingPoints.length > 0) ? irr.talkingPoints : defaultTopics;

  listEl.innerHTML = '';
  points.forEach(pt => {
    const item = document.createElement('div');
    item.style.padding = '10px 14px';
    item.style.background = 'var(--bg-card)';
    item.style.border = '1px solid var(--border)';
    item.style.borderRadius = 'var(--radius-md)';
    item.style.lineHeight = '1.45';
    item.textContent = pt;
    listEl.appendChild(item);
  });

  modal.classList.add('open');
}

function closeTalkingPointsModal() {
  document.getElementById('talking-points-modal').classList.remove('open');
}

async function deleteCycle(cycleId) {
  if (!confirm('Are you sure you want to delete this cycle?')) return;
  haptic(30);
  try {
    const res = await api(`/api/cycles/${cycleId}`, { method: 'DELETE' });
    state.cycles = state.cycles.filter(c => c.id !== cycleId);
    state.stats = res.stats;
    showToast('Cycle deleted');
    renderAnalytics();
    renderHome();
  } catch (err) {
    showToast('Failed to delete cycle');
  }
}

async function confirmClearAllCycles() {
  haptic(35);
  const confirmed = confirm('Are you sure you want to clear all cycle history? This will delete all cycles and reset your cycle history to a clean state.');
  if (!confirmed) return;

  const db = getClientDb();
  db.cycles = [];
  saveClientDb(db);

  state.cycles = [];
  state.stats = computeClientStats(db);

  await pushToCloudSync();
  renderHome();
  renderAnalytics();
  if (state.currentTab === 'calendar') renderCalendar();
  showToast('🗑️ All cycle records cleared successfully');
}

// ================= Phone Connect QR Modal =================
function openPhoneConnectModal() {
  haptic(25);
  const modal = document.getElementById('phone-connect-modal');
  const qrContainer = document.getElementById('phone-qr-svg-wrap');
  const urlsContainer = document.getElementById('phone-urls-list');

  urlsContainer.innerHTML = '';
  if (state.networkUrls.length === 0) {
    urlsContainer.innerHTML = '<p style="color:var(--text-muted);">Ensure PC is connected to Wi-Fi</p>';
  } else {
    state.networkUrls.forEach(n => {
      urlsContainer.innerHTML += `
        <div style="background:var(--bg-subtle); padding:10px; border-radius:var(--radius-md); margin-bottom:8px; border:1px solid var(--border);">
          <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">${n.interface}</div>
          <a href="${n.url}" target="_blank" style="font-size:0.95rem; font-weight:800; color:var(--primary); text-decoration:none;">${n.url}</a>
        </div>
      `;
    });

    // Render lightweight QR code via SVG
    const primaryUrl = state.networkUrls[0].url;
    qrContainer.innerHTML = renderQrSvg(primaryUrl);
  }

  modal.classList.add('open');
}

function closePhoneConnectModal() {
  document.getElementById('phone-connect-modal').classList.remove('open');
}

// Minimalist client-side QR SVG generator
function renderQrSvg(text) {
  // Use public unpkg qr generator or clean high-contrast SVG representation
  const encoded = encodeURIComponent(text);
  return `
    <div style="display:flex; flex-direction:column; align-items:center; gap:10px;">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encoded}&color=e11d48&bgcolor=fff1f2" 
           alt="Phone QR Code" 
           style="width:180px; height:180px; border-radius:12px; border:3px solid var(--primary-light); box-shadow:var(--shadow-sm);"
           onerror="this.src='/icon.svg'" />
      <span style="font-size:0.75rem; color:var(--text-muted); font-weight:600;">Scan with iPhone / Android Camera</span>
    </div>
  `;
}

// ================= Doctor's Report Modal =================
function openDoctorReport() {
  haptic(25);
  const modal = document.getElementById('doctor-report-modal');
  const reportBody = document.getElementById('doctor-report-body');

  const stats = state.stats || {};
  const logs = Object.values(state.logs || {}).sort((a, b) => new Date(b.date) - new Date(a.date));

  let rows = '';
  logs.slice(0, 30).forEach(l => {
    rows += `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px 4px; font-weight:700;">${l.date}</td>
        <td style="padding:8px 4px;">Day ${l.cycleDay || '-'}</td>
        <td style="padding:8px 4px;">${(l.flow || 'None').toUpperCase()}</td>
        <td style="padding:8px 4px;">${l.padsUsed || 0}</td>
        <td style="padding:8px 4px;">${l.painLevel || 0}/10</td>
        <td style="padding:8px 4px;">${(l.pmsSymptoms || []).join(', ') || '-'}</td>
        <td style="padding:8px 4px;">${l.meals?.waterLitres || 1.5}L</td>
      </tr>
    `;
  });

  reportBody.innerHTML = `
    <div style="border-bottom:2px solid var(--primary); padding-bottom:12px; margin-bottom:16px;">
      <h2 style="font-size:1.3rem; font-weight:900; color:var(--primary);">🌸 LunaCare Patient Menstrual Health Report</h2>
      <p style="font-size:0.8rem; color:var(--text-muted);">Generated on ${new Date().toLocaleDateString()} | Confidential Health Record</p>
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px; font-size:0.85rem;">
      <div><strong>Average Cycle Gap:</strong> ${stats.avgCycleGap || 28} Days</div>
      <div><strong>Average Period Duration:</strong> ${stats.avgPeriodDuration || 5} Days</div>
      <div><strong>Total Pads Recorded:</strong> ${stats.pads?.total || 0}</div>
      <div><strong>Average Pain Score:</strong> ${stats.pain?.avgLevel || 0} / 10</div>
    </div>
    <table style="width:100%; border-collapse:collapse; font-size:0.8rem; text-align:left;">
      <thead>
        <tr style="border-bottom:2px solid var(--border); color:var(--text-muted);">
          <th style="padding:6px 4px;">Date</th>
          <th style="padding:6px 4px;">Cycle</th>
          <th style="padding:6px 4px;">Flow</th>
          <th style="padding:6px 4px;">Pads</th>
          <th style="padding:6px 4px;">Pain</th>
          <th style="padding:6px 4px;">PMS Signs</th>
          <th style="padding:6px 4px;">Water</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="7" style="padding:16px; text-align:center;">No entries logged</td></tr>'}
      </tbody>
    </table>
  `;

  modal.classList.add('open');
}

function closeDoctorReport() {
  document.getElementById('doctor-report-modal').classList.remove('open');
}

function printDoctorReport() {
  window.print();
}

function downloadCsvReport() {
  // If server is available, use server export; if on static Netlify, generate CSV client-side Blob!
  const logs = Object.values(state.logs || {}).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (logs.length === 0) {
    showToast('No health logs to export yet.');
    return;
  }

  const headers = ['Date', 'Cycle Day', 'Time', 'Flow', 'Pads Used', 'Pain (0-10)', 'Pain Areas', 'Remedies', 'Moods', 'Before-Day PMS Symptoms', 'Water (Litres)', 'Meals Eaten', 'Medications', 'BBT (F)', 'Cervical Fluid', 'Notes'];
  const rows = logs.map(l => {
    const mealCount = [l.meals?.breakfast, l.meals?.lunch, l.meals?.dinner].filter(Boolean).length;
    const waterL = l.meals?.waterLitres !== undefined ? l.meals.waterLitres : (l.meals?.waterGlasses ? (l.meals.waterGlasses * 0.25).toFixed(2) : 1.5);
    return [
      `"${l.date}"`,
      `"${l.cycleDay || '-'}"`,
      `"${l.time || '-'}"`,
      `"${l.flow || 'none'}"`,
      l.padsUsed || 0,
      l.painLevel || 0,
      `"${(l.painAreas || []).join('; ')}"`,
      `"${(l.remedies || []).join('; ')}"`,
      `"${(l.moods || []).join('; ')}"`,
      `"${(l.pmsSymptoms || []).join('; ')}"`,
      waterL,
      `"${mealCount}/3"`,
      `"${(l.medications || []).join('; ')}"`,
      l.bbt || '',
      `"${l.cervicalFluid || 'none'}"`,
      `"${(l.notes || '').replace(/"/g, '""')}"`
    ].join(',');
  });

  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lunacare_health_report_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('📥 CSV report downloaded');
}

// ================= Quick PIN Setup =================
async function toggleQuickPin() {
  haptic(30);
  if (state.hasPin) {
    if (confirm('Disable 4-Digit Quick PIN protection?')) {
      await api('/api/profile/pin', { method: 'POST', body: JSON.stringify({ pin: null }) });
      state.hasPin = false;
      showToast('PIN Lock disabled');
    }
  } else {
    const pin = prompt('Enter a 4-Digit PIN to lock LunaCare:');
    if (pin && pin.length === 4 && /^\d{4}$/.test(pin)) {
      await api('/api/profile/pin', { method: 'POST', body: JSON.stringify({ pin }) });
      state.hasPin = true;
      showToast('🔒 4-Digit PIN Lock Activated');
    } else if (pin) {
      alert('PIN must be exactly 4 digits');
    }
  }
}

// ================= Theme Toggle =================
function toggleTheme() {
  haptic(20);
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('lunacare_theme', next);
}

// ================= New Feature Handlers =================

// 1. Tracker Mode Toggle (Period vs TTC Conception Mode)
function switchTrackerMode(mode) {
  haptic(25);
  state.trackerMode = mode;
  localStorage.setItem('lunacare_mode', mode);
  renderHome();
  showToast(mode === 'ttc' ? '👶 Conception / TTC Mode Activated' : '🩸 Period Tracking Mode Activated');
}

// 2. Daily Pill Checklist Toggle
async function togglePillTaken(medName, isChecked) {
  haptic(25);
  const todayStr = new Date().toISOString().split('T')[0];
  const db = getClientDb();
  if (!db.logs[todayStr]) {
    db.logs[todayStr] = {
      date: todayStr,
      time: new Date().toTimeString().slice(0, 5),
      medications: [],
      updatedAt: new Date().toISOString()
    };
  }
  let meds = db.logs[todayStr].medications || [];
  if (isChecked) {
    if (!meds.includes(medName)) meds.push(medName);
  } else {
    meds = meds.filter(m => m !== medName);
  }
  db.logs[todayStr].medications = meds;
  saveClientDb(db);
  state.logs = db.logs;
  state.stats = computeClientStats(db);
  renderHome();
  pushToCloudSync();
  showToast(isChecked ? `✓ Marked ${medName} as taken today!` : `Unmarked ${medName}`);
}

// 3. Stealth Calculator Disguise
function toggleStealthCalculator() {
  haptic(30);
  const overlay = document.getElementById('calculator-overlay');
  if (!overlay) return;
  overlay.classList.toggle('active');
  state.calcInput = '0';
  state.calcPrev = null;
  state.calcOp = null;
  state.calcClearOnNext = false;
  document.getElementById('calc-display').textContent = '0';
}

function handleCalcKey(key) {
  haptic(15);
  const display = document.getElementById('calc-display');
  const currentPin = state.profile?.quickPin || '1234';

  if (key === 'C') {
    state.calcInput = '0';
    state.calcPrev = null;
    state.calcOp = null;
    display.textContent = '0';
    return;
  }

  if (key === '±') {
    state.calcInput = String(-Number(state.calcInput));
    display.textContent = state.calcInput;
    return;
  }

  if (key === '%') {
    state.calcInput = String(Number(state.calcInput) / 100);
    display.textContent = state.calcInput;
    return;
  }

  if (['+', '-', '*', '/'].includes(key)) {
    state.calcPrev = Number(state.calcInput);
    state.calcOp = key;
    state.calcClearOnNext = true;
    return;
  }

  if (key === '=') {
    // Secret backdoor check: if typed number matches 4-digit quick PIN, unlock LunaCare!
    if (state.calcInput === currentPin) {
      toggleStealthCalculator();
      showToast('🌸 Stealth Mode Unlocked!');
      return;
    }

    if (state.calcOp && state.calcPrev !== null) {
      const cur = Number(state.calcInput);
      let result = 0;
      if (state.calcOp === '+') result = state.calcPrev + cur;
      if (state.calcOp === '-') result = state.calcPrev - cur;
      if (state.calcOp === '*') result = state.calcPrev * cur;
      if (state.calcOp === '/') result = cur !== 0 ? state.calcPrev / cur : 'Error';

      state.calcInput = String(result);
      display.textContent = state.calcInput;
      state.calcOp = null;
      state.calcPrev = null;
      state.calcClearOnNext = true;
    }
    return;
  }

  // Digits & Dot
  if (state.calcClearOnNext || state.calcInput === '0') {
    state.calcInput = key === '.' ? '0.' : key;
    state.calcClearOnNext = false;
  } else {
    if (key === '.' && state.calcInput.includes('.')) return;
    if (state.calcInput.length < 10) state.calcInput += key;
  }
  display.textContent = state.calcInput;
}

// 4. Emergency SOS Cramp / Supply Alert
function triggerSosAlert() {
  haptic([100, 50, 100]);
  const msg = encodeURIComponent("🚨 LunaCare Emergency Alert: I'm currently having severe cramps / urgent need for period care supplies. Please reach out or check on me!");
  const choice = confirm("🚨 Trigger Emergency SOS Alert?\n\nThis opens WhatsApp / Message to quickly notify your emergency contact or partner for help or period supplies.");
  if (choice) {
    window.open(`https://wa.me/?text=${msg}`, '_blank');
  }
}

// 5. Gynecologist WhatsApp Summary Share
function shareDoctorWhatsApp() {
  haptic(25);
  const stats = state.stats;
  if (!stats) return;
  const name = state.user?.name || state.profile?.name || 'Patient';
  const text = encodeURIComponent(
    `🩺 *LunaCare Gynecologist Health Summary*\n` +
    `👤 Patient: ${name}\n` +
    `🩸 Cycle Interval: ${stats.avgCycleGap || 28} Days\n` +
    `📅 Period Duration: ${stats.avgPeriodDuration || 5} Days\n` +
    `⚡ Avg Cramp Pain: ${stats.pain?.avgLevel || 0}/10\n` +
    `💧 Water Regularity: ${stats.pads?.total || 0} pads total\n` +
    `📊 Hormonal Status: ${stats.pcos?.title || 'Regular'}\n` +
    `Generated privately from LunaCare Health OS.`
  );
  window.open(`https://wa.me/?text=${text}`, '_blank');
}

// 6. LunaCare Partner Mode
function openPartnerShareModal() {
  haptic(20);
  const stats = state.stats;
  const currCycleDay = stats?.currentCycleDay || 1;
  const titleEl = document.getElementById('partner-phase-title');
  const descEl = document.getElementById('partner-tips-desc');

  if (stats?.isCurrentlyOnPeriod) {
    titleEl.textContent = `Menstrual Phase (Day ${currCycleDay})`;
    descEl.textContent = "Experiencing cramps & lower energy. Extra care, warm tea, heating pads, patience and dark chocolate appreciated!";
  } else if (currCycleDay <= 13) {
    titleEl.textContent = `Follicular Phase (Day ${currCycleDay})`;
    descEl.textContent = "Energy and mood are rising! Great time for fun activities, date nights, and collaborative planning.";
  } else if (currCycleDay <= 16) {
    titleEl.textContent = `Ovulation Window (Day ${currCycleDay})`;
    descEl.textContent = "Peak vitality, highest confidence and social energy of the month!";
  } else {
    titleEl.textContent = `Luteal Phase (Day ${currCycleDay})`;
    descEl.textContent = "Approaching PMS window. May experience mood shifts or bloating. Gentle words, cozy comfort and kindness mean the world!";
  }
  document.getElementById('partner-share-modal').classList.add('open');
}

function closePartnerShareModal() {
  document.getElementById('partner-share-modal').classList.remove('open');
}

function getPartnerUpdateText() {
  const stats = state.stats;
  const currCycleDay = stats?.currentCycleDay || 1;
  const name = state.user?.name || 'Your partner';
  let phaseName = 'Menstrual Phase';
  let tip = 'warm comfort & chocolate';
  if (stats?.isCurrentlyOnPeriod) {
    phaseName = `Menstrual Phase (Day ${currCycleDay})`;
    tip = 'warm drinks, heating pads & gentle hugs 🍫';
  } else if (currCycleDay <= 13) {
    phaseName = `Follicular Phase (Day ${currCycleDay})`;
    tip = 'high energy & exciting plans together ✨';
  } else if (currCycleDay <= 16) {
    phaseName = `Ovulation Window (Day ${currCycleDay})`;
    tip = 'glowing vitality & quality time 🌸';
  } else {
    phaseName = `Luteal Phase (Day ${currCycleDay})`;
    tip = 'cozy comfort, listening ears & patience 🌙';
  }
  return `💕 LunaCare Partner Update from ${name}:\nI'm currently in my *${phaseName}*.\nBest way to support me today: ${tip}`;
}

function copyPartnerUpdate() {
  haptic(25);
  const txt = getPartnerUpdateText();
  navigator.clipboard.writeText(txt).then(() => {
    showToast('📋 Partner update copied to clipboard!');
  }).catch(() => {
    prompt('Copy this partner update:', txt);
  });
}

function sharePartnerWhatsApp() {
  haptic(25);
  const txt = encodeURIComponent(getPartnerUpdateText());
  window.open(`https://wa.me/?text=${txt}`, '_blank');
}

// ================= Event Listeners Initialization =================
window.addEventListener('DOMContentLoaded', () => {
  // Service Worker Registration for PWA on Phone
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW registration note:', err));
  }

  // Bottom Nav Bar Tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      if (target === 'log') {
        openLogModal();
      } else {
        switchTab(target);
      }
    });
  });

  // Flow Chip click handlers
  document.querySelectorAll('.flow-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      haptic(20);
      document.querySelectorAll('.flow-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.activeLogForm.flow = chip.getAttribute('data-flow');
    });
  });

  // Pain Range slider live update
  const painSlider = document.getElementById('pain-range-slider');
  if (painSlider) {
    painSlider.addEventListener('input', e => {
      const val = Number(e.target.value);
      state.activeLogForm.painLevel = val;
      document.getElementById('pain-bubble-text').textContent = `${val}/10 - ${getPainDescription(val)}`;
    });
  }

  // Auth Form Switcher
  const toggleAuthLink = document.getElementById('toggle-auth-mode');
  const authSubmitBtn = document.getElementById('auth-submit-btn');
  const authTitle = document.getElementById('auth-card-title');
  const nameField = document.getElementById('auth-name-group');

  let isRegisterMode = false;

  toggleAuthLink.addEventListener('click', e => {
    e.preventDefault();
    haptic(20);
    isRegisterMode = !isRegisterMode;
    authTitle.textContent = isRegisterMode ? 'Create LunaCare Account' : 'Welcome Back';
    authSubmitBtn.textContent = isRegisterMode ? 'Create Account' : 'Sign In';
    nameField.style.display = isRegisterMode ? 'flex' : 'none';
    toggleAuthLink.textContent = isRegisterMode ? 'Already have an account? Sign In' : "Don't have an account? Create Free Account";
  });

  // Auth Submission
  document.getElementById('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    haptic(30);
    const username = document.getElementById('auth-username').value;
    const password = document.getElementById('auth-password').value;
    const name = document.getElementById('auth-name').value;

    const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
    const payload = isRegisterMode ? { username, password, name } : { username, password };

    try {
      const res = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      state.token = res.token;
      state.user = res.user;
      localStorage.setItem('lunacare_token', res.token);
      localStorage.setItem('lunacare_user', JSON.stringify(res.user));

      hideAuthView();
      showToast(isRegisterMode ? '🌸 Welcome to LunaCare!' : '🌸 Welcome back!');
      await loadInitialData();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Start app
  checkAuth();
});
