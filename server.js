const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_KEY_FILE = path.join(DATA_DIR, '.secret');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Get or generate persistent HMAC secret for tokens
let JWT_SECRET;
if (fs.existsSync(SECRET_KEY_FILE)) {
  JWT_SECRET = fs.readFileSync(SECRET_KEY_FILE, 'utf-8').trim();
} else {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_KEY_FILE, JWT_SECRET, 'utf-8');
}

// Ensure users store exists
function initUsersStore() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
}
initUsersStore();

function readUsers() {
  try {
    initUsersStore();
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch (err) {
    console.error('Error reading users:', err);
    return [];
  }
}

function writeUsers(users) {
  try {
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf-8');
    fs.renameSync(tmp, USERS_FILE);
    return true;
  } catch (err) {
    console.error('Error writing users:', err);
    return false;
  }
}

function getUserDataFile(userId) {
  return path.join(DATA_DIR, `userdata_${userId}.json`);
}

function readUserData(userId) {
  const filePath = getUserDataFile(userId);
  if (!fs.existsSync(filePath)) {
    const defaultData = {
      profile: {
        cycleLength: 28, // typical day gap
        periodDuration: 5, // typical period length in days
        quickPin: null,
        notificationsEnabled: true
      },
      cycles: [], // { id, startDate, startTime, endDate, dayGap, notes, createdAt }
      logs: {}    // key: YYYY-MM-DD -> { id, date, time, cycleDay, flow, padsUsed, painLevel, painAreas, remedies, moods, moodSwingIntensity, meals, notes, updatedAt }
    };
    writeUserData(userId, defaultData);
    return defaultData;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`Error reading user data ${userId}:`, err);
    return { profile: { cycleLength: 28, periodDuration: 5 }, cycles: [], logs: {} };
  }
}

function writeUserData(userId, data) {
  const filePath = getUserDataFile(userId);
  try {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.error(`Error writing user data ${userId}:`, err);
    return false;
  }
}

// Password hashing using Node.js crypto (scrypt)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, key] = (storedHash || '').split(':');
  if (!salt || !key) return false;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(hash, 'hex'));
}

// Session Token Generation & Verification (HMAC-SHA256)
function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60); // 1 year session for mobile convenience
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  let token = null;
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    // Check cookie or query param
    const cookieHeader = req.headers['cookie'] || '';
    const match = cookieHeader.match(/auth_token=([^;]+)/);
    if (match) token = match[1];
  }
  return verifyToken(token);
}

// Helper to parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Network interface discovery for mobile devices
function getNetworkIps() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    if (/virtual|vmnet|vbox|vethernet|hyper-v/i.test(name)) continue;
    for (const net of interfaces[name]) {
      if ((net.family === 'IPv4' || net.family === 4) && !net.internal && !net.address.startsWith('169.254.')) {
        addresses.push({ interface: name, address: net.address });
      }
    }
  }
  addresses.sort((a, b) => {
    const isWifiA = /wi-fi|wifi|wireless|wlan/i.test(a.interface);
    const isWifiB = /wi-fi|wifi|wireless|wlan/i.test(b.interface);
    if (isWifiA && !isWifiB) return -1;
    if (!isWifiA && isWifiB) return 1;
    return 0;
  });
  return addresses;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

// Compute Cycle Analytics
function calculateCycleStats(userData) {
  const cycles = [...(userData.cycles || [])].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const logs = userData.logs || {};
  const userProfile = userData.profile || {};

  // Compute day gap between consecutive cycles
  let totalGap = 0;
  let gapCount = 0;
  const recordedGaps = [];
  for (let i = 1; i < cycles.length; i++) {
    const prevStart = new Date(cycles[i - 1].startDate);
    const currStart = new Date(cycles[i].startDate);
    const diffDays = Math.round((currStart - prevStart) / (1000 * 60 * 60 * 24));
    cycles[i].dayGap = diffDays;
    recordedGaps.push(diffDays);
    if (diffDays >= 15 && diffDays <= 60) {
      totalGap += diffDays;
      gapCount++;
    }
  }

  const avgCycleGap = gapCount > 0 ? Math.round(totalGap / gapCount) : (userProfile.cycleLength || 28);

  // Compute period durations
  let totalDuration = 0;
  let durationCount = 0;
  cycles.forEach(c => {
    if (c.endDate) {
      const dur = Math.max(1, Math.round((new Date(c.endDate) - new Date(c.startDate)) / (1000 * 60 * 60 * 24)) + 1);
      c.duration = dur;
      totalDuration += dur;
      durationCount++;
    }
  });
  const avgPeriodDuration = durationCount > 0 ? Math.round(totalDuration / durationCount) : (userProfile.periodDuration || 5);

  // Latest cycle status
  const latestCycle = cycles.length > 0 ? cycles[cycles.length - 1] : null;
  const previousCycle = cycles.length > 1 ? cycles[cycles.length - 2] : null;
  const todayStr = new Date().toISOString().split('T')[0];
  const today = new Date(todayStr);

  let currentCycleDay = null;
  let isCurrentlyOnPeriod = false;
  let nextPredictedStart = null;
  let daysUntilNextPeriod = null;
  let fertileStart = null;
  let fertileEnd = null;
  let ovulationDate = null;
  let currentPhase = 'unknown';

  if (latestCycle) {
    const latestStart = new Date(latestCycle.startDate);
    const daysSinceStart = Math.floor((today - latestStart) / (1000 * 60 * 60 * 24)) + 1;
    currentCycleDay = Math.max(1, daysSinceStart);

    if (latestCycle.endDate) {
      const latestEnd = new Date(latestCycle.endDate);
      isCurrentlyOnPeriod = today >= latestStart && today <= latestEnd;
    } else {
      isCurrentlyOnPeriod = daysSinceStart >= 1 && daysSinceStart <= avgPeriodDuration;
    }

    // Prediction for next cycle
    const predictedStartDate = new Date(latestStart);
    predictedStartDate.setDate(predictedStartDate.getDate() + avgCycleGap);
    nextPredictedStart = predictedStartDate.toISOString().split('T')[0];
    daysUntilNextPeriod = Math.round((predictedStartDate - today) / (1000 * 60 * 60 * 24));

    // Ovulation is typically 14 days before next period
    const ovDate = new Date(predictedStartDate);
    ovDate.setDate(ovDate.getDate() - 14);
    ovulationDate = ovDate.toISOString().split('T')[0];

    // Fertile window: 5 days before ovulation + ovulation day
    const fStart = new Date(ovDate);
    fStart.setDate(fStart.getDate() - 5);
    fertileStart = fStart.toISOString().split('T')[0];

    const fEnd = new Date(ovDate);
    fEnd.setDate(fEnd.getDate() + 1);
    fertileEnd = fEnd.toISOString().split('T')[0];

    // Determine phase
    if (isCurrentlyOnPeriod) {
      currentPhase = 'menstrual';
    } else if (today < fStart) {
      currentPhase = 'follicular';
    } else if (today >= fStart && today <= fEnd) {
      currentPhase = 'ovulation';
    } else {
      currentPhase = 'luteal';
    }
  }

  // Phase Wellness & Nutrition Advice
  const phaseAdvice = {
    phase: currentPhase,
    title: '',
    foods: '',
    workout: '',
    selfCare: ''
  };

  if (currentPhase === 'menstrual') {
    phaseAdvice.title = '🌸 Menstrual Phase (Rest & Replenish)';
    phaseAdvice.foods = 'Iron & magnesium-rich foods (spinach, lentils, dark chocolate, bone/vegetable broth, pumpkin seeds). Avoid excess caffeine and ultra-processed salty foods.';
    phaseAdvice.workout = 'Gentle restorative yoga, pelvic stretches, slow walking, and resting.';
    phaseAdvice.selfCare = 'Use a warm heating pad, sip warm chamomile or raspberry leaf tea, prioritize 8+ hours of peaceful sleep.';
  } else if (currentPhase === 'follicular') {
    phaseAdvice.title = '🌱 Follicular Phase (Energy & Renewal)';
    phaseAdvice.foods = 'Probiotic foods (yogurt, fermented veggies), lean proteins, complex whole grains, flax seeds, fresh citrus fruits.';
    phaseAdvice.workout = 'Cardio, dancing, swimming, moderate strength training (estrogen is rising, giving you natural energy!).';
    phaseAdvice.selfCare = 'Ideal time for starting new projects, creative planning, and social events.';
  } else if (currentPhase === 'ovulation') {
    phaseAdvice.title = '✨ Ovulation Phase (Peak Vitality & Fertile Window)';
    phaseAdvice.foods = 'Antioxidant-rich berries, leafy green salads, avocado, wild salmon or chia seeds, high-fiber veggies.';
    phaseAdvice.workout = 'High-intensity workouts (HIIT), heavy weight lifting, challenging circuits.';
    phaseAdvice.selfCare = 'Peak communication skills, high confidence. Keep water intake high to support hydration.';
  } else if (currentPhase === 'luteal') {
    phaseAdvice.title = '🌙 Luteal Phase (Nourish & Slow Down - PMS Support)';
    phaseAdvice.foods = 'Magnesium-rich foods (almonds, dark leafy greens, dark chocolate), vitamin B6 (bananas, chickpeas), complex carbs (sweet potatoes). Avoid excess sugar to prevent mood dips.';
    phaseAdvice.workout = 'Pilates, gentle strength training, nature walks, low-impact bodyweight moves.';
    phaseAdvice.selfCare = 'Set boundaries, prepare comfort teas, journal emotions, practice mindful breathing for PMS relief.';
  } else {
    phaseAdvice.title = '🌸 Menstrual Wellness Guide';
    phaseAdvice.foods = 'Balanced whole foods, hydration, magnesium, and fresh vegetables.';
    phaseAdvice.workout = 'Listen to your body and move at your own comfort level.';
    phaseAdvice.selfCare = 'Consistent sleep and daily hydration.';
  }

  // Irregular Cycle & PMS Alerts
  const irregularity = {
    isIrregular: false,
    reason: '',
    talkingPoints: []
  };

  if (recordedGaps.length >= 1) {
    const lastGap = recordedGaps[recordedGaps.length - 1];
    if (lastGap < 21) {
      irregularity.isIrregular = true;
      irregularity.reason = `Short cycle gap detected (${lastGap} days). Typical healthy cycles range from 21 to 35 days.`;
    } else if (lastGap > 35) {
      irregularity.isIrregular = true;
      irregularity.reason = `Long cycle interval detected (${lastGap} days). Typical healthy cycles range from 21 to 35 days.`;
    }

    if (recordedGaps.length >= 2) {
      const minGap = Math.min(...recordedGaps);
      const maxGap = Math.max(...recordedGaps);
      if (maxGap - minGap > 7) {
        irregularity.isIrregular = true;
        irregularity.reason = (irregularity.reason ? irregularity.reason + ' ' : '') + `Cycle length variation is ${maxGap - minGap} days (>7 days difference between cycles).`;
      }
    }

    if (irregularity.isIrregular) {
      irregularity.talkingPoints = [
        `1. Inform your gynecologist about your recent cycle gaps (${recordedGaps.slice(-3).join(', ')} days).`,
        `2. Note whether bleeding is abnormally light or requires >6 pads per day.`,
        `3. Mention any severe pain, sudden weight changes, acne, or fatigue to rule out PCOS, thyroid, or hormonal shifts.`
      ];
    }
  }

  // Cycle-to-Cycle Comparison (Latest vs Previous)
  let cycleComparison = null;
  if (latestCycle && previousCycle) {
    const getCycleMetrics = (c, nextC) => {
      const start = c.startDate;
      const end = nextC ? nextC.startDate : '9999-12-31';
      let pads = 0;
      let painSum = 0;
      let painEntries = 0;
      Object.values(logs).forEach(l => {
        if (l.date >= start && l.date < end) {
          if (l.padsUsed) pads += Number(l.padsUsed);
          if (l.painLevel !== undefined && l.painLevel !== null) {
            painSum += Number(l.painLevel);
            painEntries++;
          }
        }
      });
      return {
        startDate: c.startDate,
        dayGap: c.dayGap || null,
        duration: c.duration || avgPeriodDuration,
        totalPads: pads,
        avgPain: painEntries > 0 ? (painSum / painEntries).toFixed(1) : 0
      };
    };

    const currentMetrics = getCycleMetrics(latestCycle, null);
    const prevMetrics = getCycleMetrics(previousCycle, latestCycle);

    cycleComparison = {
      current: currentMetrics,
      previous: prevMetrics,
      gapDiff: currentMetrics.dayGap && prevMetrics.dayGap ? currentMetrics.dayGap - prevMetrics.dayGap : 0,
      padsDiff: currentMetrics.totalPads - prevMetrics.totalPads,
      painDiff: (Number(currentMetrics.avgPain) - Number(prevMetrics.avgPain)).toFixed(1)
    };
  }

  // Symptom statistics
  let totalPads = 0;
  let padDaysCount = 0;
  let painSum = 0;
  let painCount = 0;
  const moodCounts = {};
  let mealsTracked = 0;
  let fullMealsEaten = 0;
  const bbtList = [];
  const fluidCounts = {};
  let medicationsLoggedCount = 0;

  Object.values(logs).forEach(log => {
    if (log.padsUsed) {
      totalPads += Number(log.padsUsed);
      padDaysCount++;
    }
    if (log.painLevel !== undefined && log.painLevel !== null) {
      painSum += Number(log.painLevel);
      painCount++;
    }
    if (Array.isArray(log.moods)) {
      log.moods.forEach(m => {
        moodCounts[m] = (moodCounts[m] || 0) + 1;
      });
    }
    if (log.meals) {
      mealsTracked++;
      if (log.meals.breakfast && log.meals.lunch && log.meals.dinner) {
        fullMealsEaten++;
      }
    }
    if (log.bbt) {
      bbtList.push({ date: log.date, bbt: Number(log.bbt) });
    }
    if (log.cervicalFluid && log.cervicalFluid !== 'none') {
      fluidCounts[log.cervicalFluid] = (fluidCounts[log.cervicalFluid] || 0) + 1;
    }
    if (Array.isArray(log.medications) && log.medications.length > 0) {
      medicationsLoggedCount += log.medications.length;
    }
  });

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
    phaseAdvice,
    irregularity,
    cycleComparison,
    pads: {
      total: totalPads,
      avgPerDay: padDaysCount > 0 ? (totalPads / padDaysCount).toFixed(1) : 0
    },
    pain: {
      avgLevel: painCount > 0 ? (painSum / painCount).toFixed(1) : 0,
      totalEntries: painCount
    },
    moodCounts,
    nutrition: {
      mealsTracked,
      fullMealsEaten,
      regularityPercentage: mealsTracked > 0 ? Math.round((fullMealsEaten / mealsTracked) * 100) : 100
    },
    biomarkers: {
      bbtRecent: bbtList.slice(-10),
      fluidCounts,
      medicationsLoggedCount
    }
  };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // -------------------------------------------------------------------------
  // PUBLIC API ENDPOINTS
  // -------------------------------------------------------------------------

  // Network Info endpoint (for mobile QR & IP display)
  if (pathname === '/api/network-info' && req.method === 'GET') {
    const ips = getNetworkIps();
    sendJson(res, 200, {
      port: PORT,
      localUrl: `http://localhost:${PORT}`,
      networkUrls: ips.map(i => ({ interface: i.interface, url: `http://${i.address}:${PORT}` }))
    });
    return;
  }

  // Register
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { username, password, name } = body;
      if (!username || !password) {
        sendJson(res, 400, { error: 'Username and password are required' });
        return;
      }
      const users = readUsers();
      const cleanUsername = username.trim().toLowerCase();
      if (users.find(u => u.username.toLowerCase() === cleanUsername)) {
        sendJson(res, 409, { error: 'Username or email already exists' });
        return;
      }

      const userId = 'u_' + crypto.randomBytes(6).toString('hex');
      const newUser = {
        id: userId,
        username: cleanUsername,
        name: (name || cleanUsername).trim(),
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString()
      };
      users.push(newUser);
      writeUsers(users);

      // Create default user data store
      readUserData(userId);

      const token = generateToken({ userId, username: cleanUsername, name: newUser.name });
      sendJson(res, 201, {
        message: 'Account created successfully',
        token,
        user: { id: userId, username: cleanUsername, name: newUser.name }
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { username, password } = body;
      if (!username || !password) {
        sendJson(res, 400, { error: 'Username and password are required' });
        return;
      }
      const users = readUsers();
      const cleanUsername = username.trim().toLowerCase();
      const user = users.find(u => u.username.toLowerCase() === cleanUsername);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        sendJson(res, 401, { error: 'Invalid username or password' });
        return;
      }

      const userData = readUserData(user.id);
      const hasPin = Boolean(userData.profile && userData.profile.quickPin);

      const token = generateToken({ userId: user.id, username: user.username, name: user.name });
      sendJson(res, 200, {
        message: 'Login successful',
        token,
        hasPin,
        user: { id: user.id, username: user.username, name: user.name }
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Quick PIN Verify
  if (pathname === '/api/auth/verify-pin' && req.method === 'POST') {
    const auth = authenticate(req);
    if (!auth) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    const body = await parseBody(req);
    const { pin } = body;
    const userData = readUserData(auth.userId);
    if (!userData.profile || !userData.profile.quickPin) {
      sendJson(res, 200, { success: true, message: 'No PIN set' });
      return;
    }
    if (userData.profile.quickPin === String(pin).trim()) {
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 403, { success: false, error: 'Incorrect 4-digit PIN' });
    }
    return;
  }

  // -------------------------------------------------------------------------
  // PROTECTED API ENDPOINTS (Require Authorization: Bearer <token>)
  // -------------------------------------------------------------------------
  if (pathname.startsWith('/api/')) {
    const auth = authenticate(req);
    if (!auth) {
      sendJson(res, 401, { error: 'Authentication required. Please log in.' });
      return;
    }
    const userId = auth.userId;
    const userData = readUserData(userId);

    // Current User Profile / Status
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const stats = calculateCycleStats(userData);
      sendJson(res, 200, {
        user: { id: userId, username: auth.username, name: auth.name },
        profile: userData.profile,
        stats
      });
      return;
    }

    // Set or Update Quick PIN
    if (pathname === '/api/profile/pin' && req.method === 'POST') {
      const body = await parseBody(req);
      const { pin } = body;
      if (!userData.profile) userData.profile = {};
      userData.profile.quickPin = pin ? String(pin).trim() : null;
      writeUserData(userId, userData);
      sendJson(res, 200, { success: true, message: pin ? 'Quick PIN activated' : 'PIN removed' });
      return;
    }

    // Update Profile Settings (Cycle length, period duration defaults)
    if (pathname === '/api/profile' && req.method === 'PUT') {
      const body = await parseBody(req);
      userData.profile = { ...(userData.profile || {}), ...body };
      writeUserData(userId, userData);
      sendJson(res, 200, { success: true, profile: userData.profile });
      return;
    }

    // CYCLES: Get all cycles
    if (pathname === '/api/cycles' && req.method === 'GET') {
      const stats = calculateCycleStats(userData);
      sendJson(res, 200, {
        cycles: userData.cycles || [],
        stats
      });
      return;
    }

    // CYCLES: Add or Start New Period Cycle
    if (pathname === '/api/cycles' && req.method === 'POST') {
      const body = await parseBody(req);
      const { startDate, startTime, endDate, notes } = body;
      if (!startDate) {
        sendJson(res, 400, { error: 'startDate is required (YYYY-MM-DD)' });
        return;
      }

      if (!userData.cycles) userData.cycles = [];

      // Sort existing cycles to compute Day Gap from the previous cycle
      userData.cycles.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
      let dayGap = null;
      if (userData.cycles.length > 0) {
        const lastCycle = userData.cycles[userData.cycles.length - 1];
        const prevDate = new Date(lastCycle.startDate);
        const newDate = new Date(startDate);
        dayGap = Math.round((newDate - prevDate) / (1000 * 60 * 60 * 24));
      }

      const cycleId = 'c_' + Date.now();
      const newCycle = {
        id: cycleId,
        startDate,
        startTime: startTime || '09:00',
        endDate: endDate || null,
        dayGap: dayGap,
        notes: notes || '',
        createdAt: new Date().toISOString()
      };

      userData.cycles.push(newCycle);
      writeUserData(userId, userData);
      const stats = calculateCycleStats(userData);

      sendJson(res, 201, {
        message: 'Period cycle recorded successfully',
        cycle: newCycle,
        stats
      });
      return;
    }

    // CYCLES: Update cycle (e.g. mark period ended, update dates)
    if (pathname.startsWith('/api/cycles/') && req.method === 'PUT') {
      const cycleId = pathname.split('/')[3];
      const body = await parseBody(req);
      const cycle = (userData.cycles || []).find(c => c.id === cycleId);
      if (!cycle) {
        sendJson(res, 404, { error: 'Cycle not found' });
        return;
      }
      if (body.startDate !== undefined) cycle.startDate = body.startDate;
      if (body.startTime !== undefined) cycle.startTime = body.startTime;
      if (body.endDate !== undefined) cycle.endDate = body.endDate;
      if (body.notes !== undefined) cycle.notes = body.notes;

      writeUserData(userId, userData);
      const stats = calculateCycleStats(userData);
      sendJson(res, 200, { message: 'Cycle updated', cycle, stats });
      return;
    }

    // CYCLES: Delete cycle
    if (pathname.startsWith('/api/cycles/') && req.method === 'DELETE') {
      const cycleId = pathname.split('/')[3];
      userData.cycles = (userData.cycles || []).filter(c => c.id !== cycleId);
      writeUserData(userId, userData);
      const stats = calculateCycleStats(userData);
      sendJson(res, 200, { message: 'Cycle removed', stats });
      return;
    }

    // LOGS: Get Daily Logs
    if (pathname === '/api/logs' && req.method === 'GET') {
      const month = parsedUrl.searchParams.get('month'); // optional YYYY-MM
      let result = userData.logs || {};
      if (month) {
        result = Object.fromEntries(
          Object.entries(result).filter(([date]) => date.startsWith(month))
        );
      }
      sendJson(res, 200, { logs: result });
      return;
    }

    // LOGS: Create / Update Daily Log (Flow, Pads, Pain, Moods, Meals eaten or not)
    if (pathname === '/api/logs' && req.method === 'POST') {
      const body = await parseBody(req);
      const {
        date,
        time,
        flow,
        padsUsed,
        painLevel,
        painAreas,
        remedies,
        moods,
        moodSwingIntensity,
        meals,
        pmsSymptoms,
        waterLitres,
        medications,
        bbt,
        cervicalFluid,
        notes
      } = body;

      if (!date) {
        sendJson(res, 400, { error: 'Date is required (YYYY-MM-DD)' });
        return;
      }

      if (!userData.logs) userData.logs = {};

      // Determine cycle day for this date if a cycle exists
      let cycleDay = null;
      if (userData.cycles && userData.cycles.length > 0) {
        const sorted = [...userData.cycles].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        // Find most recent cycle on or before this log date
        const logDateObj = new Date(date);
        for (let i = sorted.length - 1; i >= 0; i--) {
          const cStart = new Date(sorted[i].startDate);
          if (logDateObj >= cStart) {
            cycleDay = Math.floor((logDateObj - cStart) / (1000 * 60 * 60 * 24)) + 1;
            break;
          }
        }
      }

      const existingLog = userData.logs[date] || {};
      const updatedLog = {
        id: existingLog.id || 'log_' + Date.now(),
        date,
        time: time || existingLog.time || '12:00',
        cycleDay: cycleDay || existingLog.cycleDay || 1,
        flow: flow !== undefined ? flow : (existingLog.flow || 'none'), // none, spotting, light, medium, heavy
        padsUsed: padsUsed !== undefined ? Number(padsUsed) : (existingLog.padsUsed || 0),
        painLevel: painLevel !== undefined ? Number(painLevel) : (existingLog.painLevel || 0),
        painAreas: painAreas !== undefined ? painAreas : (existingLog.painAreas || []),
        remedies: remedies !== undefined ? remedies : (existingLog.remedies || []),
        moods: moods !== undefined ? moods : (existingLog.moods || []),
        moodSwingIntensity: moodSwingIntensity || existingLog.moodSwingIntensity || 'mild',
        pmsSymptoms: pmsSymptoms !== undefined ? pmsSymptoms : (existingLog.pmsSymptoms || []),
        waterLitres: waterLitres !== undefined ? Number(waterLitres) : (existingLog.waterLitres !== undefined ? existingLog.waterLitres : (meals && meals.waterGlasses ? Number((meals.waterGlasses * 0.25).toFixed(1)) : 1.5)),
        meals: meals || existingLog.meals || {
          breakfast: true,
          lunch: true,
          dinner: true,
          waterGlasses: 6,
          appetite: 'normal',
          cravingsNote: ''
        },
        medications: medications !== undefined ? medications : (existingLog.medications || []),
        bbt: bbt !== undefined ? (bbt ? Number(bbt) : null) : (existingLog.bbt || null),
        cervicalFluid: cervicalFluid !== undefined ? cervicalFluid : (existingLog.cervicalFluid || 'none'),
        notes: notes !== undefined ? notes : (existingLog.notes || ''),
        updatedAt: new Date().toISOString()
      };

      userData.logs[date] = updatedLog;
      writeUserData(userId, userData);
      const stats = calculateCycleStats(userData);

      sendJson(res, 200, {
        message: 'Daily health log saved',
        log: updatedLog,
        stats
      });
      return;
    }

    // LOGS: Delete Daily Log
    if (pathname.startsWith('/api/logs/') && req.method === 'DELETE') {
      const date = pathname.split('/')[3];
      if (userData.logs && userData.logs[date]) {
        delete userData.logs[date];
        writeUserData(userId, userData);
      }
      const stats = calculateCycleStats(userData);
      sendJson(res, 200, { message: 'Log deleted', stats });
      return;
    }

    // STATS & PREDICTIONS
    if (pathname === '/api/stats' && req.method === 'GET') {
      const stats = calculateCycleStats(userData);
      sendJson(res, 200, { stats });
      return;
    }

    // EXPORT: Doctor's CSV Report
    if (pathname === '/api/export/csv' && req.method === 'GET') {
      const logs = Object.values(userData.logs || {}).sort((a, b) => new Date(a.date) - new Date(b.date));
      let csv = 'Date,Time,Cycle Day,Flow,Pads Used,Pain Level (0-10),Pain Areas,Remedies,Moods,Mood Swings,Before-Day PMS Symptoms,Breakfast,Lunch,Dinner,Water (Litres),Water (Glasses),Appetite,Medications,BBT Temp,Cervical Fluid,Notes\n';
      logs.forEach(l => {
        const row = [
          `"${l.date}"`,
          `"${l.time || ''}"`,
          l.cycleDay || '',
          `"${l.flow || 'none'}"`,
          l.padsUsed || 0,
          l.painLevel || 0,
          `"${(l.painAreas || []).join('; ')}"`,
          `"${(l.remedies || []).join('; ')}"`,
          `"${(l.moods || []).join('; ')}"`,
          `"${l.moodSwingIntensity || ''}"`,
          `"${(l.pmsSymptoms || []).join('; ')}"`,
          l.meals ? (l.meals.breakfast ? 'Eaten' : 'Skipped') : '',
          l.meals ? (l.meals.lunch ? 'Eaten' : 'Skipped') : '',
          l.meals ? (l.meals.dinner ? 'Eaten' : 'Skipped') : '',
          l.waterLitres !== undefined ? l.waterLitres : (l.meals ? Number((l.meals.waterGlasses * 0.25).toFixed(1)) : ''),
          l.meals ? (l.meals.waterGlasses || 0) : '',
          `"${l.meals ? (l.meals.appetite || 'normal') : ''}"`,
          `"${(l.medications || []).join('; ')}"`,
          l.bbt || '',
          `"${l.cervicalFluid || 'none'}"`,
          `"${(l.notes || '').replace(/"/g, '""')}"`
        ];
        csv += row.join(',') + '\n';
      });

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="lunacare_health_report_${new Date().toISOString().split('T')[0]}.csv"`
      });
      res.end(csv);
      return;
    }

    // BACKUP: JSON Full Export
    if (pathname === '/api/export/json' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="lunacare_backup_${new Date().toISOString().split('T')[0]}.json"`
      });
      res.end(JSON.stringify(userData, null, 2));
      return;
    }

    // RESTORE: JSON Import
    if (pathname === '/api/import/json' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body && (body.cycles || body.logs)) {
        userData.cycles = body.cycles || userData.cycles;
        userData.logs = body.logs || userData.logs;
        userData.profile = body.profile || userData.profile;
        writeUserData(userId, userData);
        sendJson(res, 200, { message: 'Data imported successfully' });
      } else {
        sendJson(res, 400, { error: 'Invalid backup file structure' });
      }
      return;
    }
  }

  // -------------------------------------------------------------------------
  // STATIC ASSETS SERVING (PWA, HTML, CSS, JS)
  // -------------------------------------------------------------------------
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File Not Found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(content);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getNetworkIps();
  console.log('\n======================================================');
  console.log('🌸 LUNACARE - WOMEN\'S PERIOD & CYCLE TRACKER ACTIVE 🌸');
  console.log('======================================================');
  console.log(`💻 PC / Browser:        http://localhost:${PORT}`);
  ips.forEach(({ interface: iface, address }) => {
    console.log(`📱 Phone (iPhone/Android): http://${address}:${PORT}  (${iface})`);
  });
  console.log('------------------------------------------------------');
  console.log('🔒 100% Free, Private, Safe Local & Wi-Fi Sync Ready');
  console.log('✨ Data stays secure on your machine with zero cloud fees');
  console.log('======================================================\n');
});
