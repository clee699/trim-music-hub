import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurations via Environment Variables
const PORT = parseInt(process.env.PORT || '4175', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_USER = process.env.DEFAULT_USER || 'admin';
const MUSIC_DIR = process.env.MUSIC_DIR || (fs.existsSync('/media/music') ? '/media/music' : '');
const FNOS_DB_PATH = process.env.FNOS_DB_PATH || (fs.existsSync('/app/db/music.db') ? '/app/db/music.db' : '/usr/local/apps/@appdata/trim.music/db/music.db');
const FNOS_COVER_DIR = process.env.FNOS_COVER_DIR || (fs.existsSync('/app/cover') ? '/app/cover' : '/var/apps/trim.music/meta/cover');
const PUID = process.env.PUID || '1000';
const PGID = process.env.PGID || '1000';
const GATEWAY_SOCKET = (process.env.GATEWAY_SOCKET || '').trim();
const GATEWAY_PREFIX = (process.env.GATEWAY_PREFIX || '/app/trim-music-hub').trim().replace(/\/+$/, '');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FALLBACK_COVER_DIR = path.join(DATA_DIR, 'covers');
const CURRENT_TASK_FILE = path.join(DATA_DIR, 'current_task.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const LOG_FILE = path.join(DATA_DIR, 'live.log');
const DIST_DIR = path.join(__dirname, 'frontend', 'dist');

const DB_OPS_SCRIPT = path.join(__dirname, 'db_ops.py');
const MUSIC_MANAGER_SCRIPT = path.join(__dirname, 'scripts', 'music_manager.py');
const PLAYLIST_SYNC_SCRIPT = path.join(__dirname, 'scripts', 'playlist_sync.py');
const NCM_AUTH_SCRIPT = path.join(__dirname, 'scripts', 'ncm_auth.cjs');
const AUTH_SECRET_FILE = path.join(DATA_DIR, 'auth_secret.key');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MUSIC_ACCOUNTS_FILE = path.join(DATA_DIR, 'music_accounts.json');
const MUSIC_ACCOUNT_SCRIPT = path.join(__dirname, 'scripts', 'music_account.py');
const TASK_QUEUE_FILE = path.join(DATA_DIR, 'task_queue.json');

const VALID_QUALITIES = ['flac24bit', 'flac', '320k', '128k'];
const INTERNAL_API_TOKEN = crypto.randomBytes(32).toString('hex');

const DEFAULT_SETTINGS = {
  download_source: 'kw',
  download_dir: MUSIC_DIR,
  concurrent_downloads: 5,
  force_transcode: false,
  transcode_quality: '320k',
  is_configured: Boolean(MUSIC_DIR),
  available_sources: [
    { id: 'kw', name: '酷我音乐', desc: '高品质FLAC专线 · 推荐默认', default: true },
    { id: 'kg', name: '酷狗音乐', desc: '海棠/星海SVIP线路', default: false },
    { id: 'tx', name: 'QQ音乐', desc: '长青/溯音专线', default: false },
    { id: 'wy', name: '网易云音乐', desc: '163云音乐线路', default: false },
    { id: 'auto', name: '智能多源聚合', desc: '酷我优先，故障自动回退', default: false },
    { id: 'custom', name: '自定义音源', desc: '自建 API 端点 / 远程源脚本解析', default: false }
  ],
  custom_source: { name: '自建音乐解析服务', api_url: '', api_key: '', script_url: '' }
};

function getSettings() {
  let saved = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (e) {
    console.error('Failed to load settings:', e.message);
  }
  const merged = {
    ...DEFAULT_SETTINGS,
    ...saved,
    force_transcode: Boolean(saved.force_transcode),
    transcode_quality: VALID_QUALITIES.includes(saved.transcode_quality) ? saved.transcode_quality : '320k',
    concurrent_downloads: Math.max(1, Math.min(10, parseInt(saved.concurrent_downloads || 5, 10))),
    available_sources: DEFAULT_SETTINGS.available_sources.map(source => ({ ...source })),
    custom_source: { ...DEFAULT_SETTINGS.custom_source, ...(saved.custom_source || {}) }
  };
  merged.is_configured = Boolean(merged.download_dir && merged.download_dir.trim());
  return merged;
}

function sanitizeSettingsForUser(settings, sessionUser) {
  const copy = {
    ...settings,
    custom_source: { ...(settings.custom_source || {}) }
  };
  if (!sessionUser?.isAdmin && copy.custom_source.api_key) {
    copy.custom_source.api_key = '********';
  }
  return copy;
}

function getEffectiveMusicDir() {
  const downloadDir = getSettings().download_dir;
  return typeof downloadDir === 'string' && downloadDir.trim() ? downloadDir.trim() : MUSIC_DIR;
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Persistent HMAC Secret Key for session tokens
let AUTH_SECRET = '';
try {
  if (fs.existsSync(AUTH_SECRET_FILE)) {
    AUTH_SECRET = fs.readFileSync(AUTH_SECRET_FILE, 'utf-8').trim();
  }
} catch (e) {}
if (!AUTH_SECRET || AUTH_SECRET.length < 32) {
  AUTH_SECRET = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(AUTH_SECRET_FILE, AUTH_SECRET, { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {}
}

function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signToken(payload) {
  const dataStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(dataStr).digest('base64url');
  return `${dataStr}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [dataStr, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(dataStr).digest('base64url');
  if (!safeEqualStrings(signature, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(dataStr, 'base64url').toString('utf-8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc && typeof rc === 'string') {
    for (const cookie of rc.split(';')) {
      const eqIdx = cookie.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = cookie.slice(0, eqIdx).trim();
      const rawVal = cookie.slice(eqIdx + 1).trim();
      if (!key) continue;
      try {
        list[key] = decodeURIComponent(rawVal);
      } catch {
        list[key] = rawVal;
      }
    }
  }
  return list;
}

function getSessionUser(req, reqUrl = null) {
  const cookies = parseCookies(req);
  const bearer = req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim() : '';
  const headerToken = typeof req.headers['x-auth-token'] === 'string' ? req.headers['x-auth-token'].trim() : '';
  const queryToken = reqUrl && reqUrl.pathname === '/api/stream' ? (reqUrl.searchParams.get('token') || '').trim() : '';
  const token = cookies.fn_music_token || bearer || headerToken || queryToken;
  if (!token) return null;
  return verifyToken(token);
}

let cachedMusicUsers = { at: 0, list: [] };

async function getCachedMusicUsers() {
  const now = Date.now();
  if (now - cachedMusicUsers.at < 60_000 && Array.isArray(cachedMusicUsers.list) && cachedMusicUsers.list.length > 0) {
    return cachedMusicUsers.list;
  }
  try {
    const users = await callDbOps('list_users');
    if (Array.isArray(users)) {
      cachedMusicUsers = { at: now, list: users };
      return users;
    }
  } catch (e) {
    console.error('Failed to query users from music.db for gateway SSO:', e.message);
  }
  return cachedMusicUsers.list || [];
}

async function resolveGatewayUser(req, res, existingSession, cookieSecureFlag) {
  if (!req.__fromFnGateway) return existingSession;
  const gwUsername = String(req.headers['x-trim-username'] || '').trim();
  if (!gwUsername) return existingSession;
  const gwIsAdmin = String(req.headers['x-trim-isadmin'] || '').trim().toLowerCase() === 'true';

  if (
    existingSession &&
    String(existingSession.username || '').toLowerCase() === gwUsername.toLowerCase() &&
    Boolean(existingSession.isAdmin) === Boolean(existingSession.role === 'admin' || gwIsAdmin)
  ) {
    return existingSession;
  }

  let userId = parseInt(String(req.headers['x-trim-userid'] || '1000'), 10) || 1000;
  let role = gwIsAdmin ? 'admin' : 'member';
  const users = await getCachedMusicUsers();
  const matched = users.find(u => u.name && u.name.toLowerCase() === gwUsername.toLowerCase());
  if (matched) {
    userId = matched.id;
    role = (matched.role === 'admin' || gwIsAdmin) ? 'admin' : (matched.role || 'member');
  }

  const isAdmin = role === 'admin' || gwIsAdmin;
  const sessionData = {
    username: gwUsername,
    userId,
    role: isAdmin ? 'admin' : role,
    isAdmin,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  };
  const token = signToken(sessionData);
  const cookiePath = GATEWAY_PREFIX || '/';
  res.setHeader('Set-Cookie', `fn_music_token=${token}; Path=${cookiePath}; Max-Age=${30 * 24 * 3600}; SameSite=Lax; HttpOnly${cookieSecureFlag}`);
  return sessionData;
}

// Login brute-force protection (protects fnOS NAS account from lockout)
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttemptMap = new Map();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttemptMap.get(ip);
  if (!entry) return { allowed: true };
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttemptMap.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retrySec = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - entry.firstAt)) / 1000));
    return { allowed: false, retrySec };
  }
  return { allowed: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttemptMap.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttemptMap.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(ip) {
  loginAttemptMap.delete(ip);
}

const defaultWsHost = fs.existsSync('/.dockerenv') ? '172.17.0.1' : '127.0.0.1';
const FNOS_WS_URL = process.env.FNOS_WS_URL || `ws://${defaultWsHost}:5666/websocket?type=main`;

async function authenticateWithFnOS(username, password) {
  return new Promise((resolve) => {
    let resolved = false;
    let ws;
    try {
      ws = new WebSocket(FNOS_WS_URL);
    } catch (e) {
      return resolve({ ok: false, error: `无法连接飞牛系统认证网关: ${e.message}` });
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        resolve({ ok: false, error: '连接飞牛认证网关超时，请检查 NAS 状态' });
      }
    }, 6000);

    ws.onopen = () => {
      const reqid = Date.now().toString(16) + '00000001';
      ws.send(JSON.stringify({
        req: 'user.login',
        reqid,
        user: String(username || '').trim(),
        password: String(password || ''),
        stay: 1,
        deviceName: 'TRIM Music Hub',
        deviceType: 'Web'
      }));
    };

    ws.onmessage = (event) => {
      if (resolved) return;
      try {
        const data = JSON.parse(event.data);
        if (data.result === 'succ') {
          resolved = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          resolve({ ok: true, data });
        } else {
          resolved = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          const errorMsg = data.errmsg || (data.errno === 131072 ? '飞牛账号或密码错误（若连续输错5次将被系统临时锁定1小时）' : `登录失败 (${data.errno || '未知错误'})`);
          resolve({ ok: false, error: errorMsg, errno: data.errno });
        }
      } catch (e) {
        resolved = true;
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        resolve({ ok: false, error: '解析飞牛网关返回数据失败' });
      }
    };

    ws.onerror = (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: false, error: '连接飞牛网关失败: ' + (err.message || '网络异常') });
    };
  });
}

const MUSIC_PROVIDER_META = {
  netease: { id: 'netease', name: '网易云音乐', available: true, login_method: 'all', hint: '支持手机网易云扫码或 Cookie 连接' },
  qq: { id: 'qq', name: 'QQ音乐', available: true, login_method: 'cookie', hint: '支持粘贴网页版 Cookie 连接' },
  bodian: { id: 'bodian', name: '波点音乐', available: false, login_method: 'unavailable', hint: '暂未开放' }
};

function readJsonFile(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {}
  return fallback;
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (e) {}
}

function encryptionKey() {
  return crypto.createHash('sha256').update(AUTH_SECRET).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

function decryptSecret(payload) {
  if (!payload?.iv || !payload?.tag || !payload?.data) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
}

function loadMusicAccounts() {
  const raw = readJsonFile(MUSIC_ACCOUNTS_FILE, {});
  if (!raw || typeof raw !== 'object') return { accounts: [] };
  if (Array.isArray(raw.accounts)) return raw;

  const accounts = [];
  for (const [provider, item] of Object.entries(raw)) {
    if (item && typeof item === 'object' && item.secret) {
      accounts.push({
        id: `acc_${provider}_admin`,
        provider,
        owner_user: 'admin',
        ...item
      });
    }
  }
  return { accounts };
}

function saveMusicAccounts(data) {
  writePrivateJson(MUSIC_ACCOUNTS_FILE, data);
}

function resolveDecryptedCookieByAccountId(accountId, fallbackOwner = '') {
  if (!accountId) return '';
  const store = loadMusicAccounts();
  const accounts = store.accounts || [];
  let acc = accounts.find(a => a.id === accountId);
  if (!acc && fallbackOwner) {
    acc = accounts.find(a => a.provider === accountId && a.owner_user === fallbackOwner);
  }
  if (!acc || !acc.secret) return '';
  try {
    return decryptSecret(acc.secret);
  } catch {
    return '';
  }
}

function publicMusicAccount(item, currentUser) {
  const meta = MUSIC_PROVIDER_META[item.provider] || { id: item.provider, name: item.provider, available: true, login_method: 'cookie', hint: '' };
  return {
    id: item.id || item.provider,
    provider: item.provider,
    name: meta.name,
    owner_user: item.owner_user || 'admin',
    is_self: !item.owner_user || item.owner_user === currentUser.username,
    available: meta.available !== false,
    login_method: meta.login_method || 'cookie',
    hint: meta.hint || '',
    connected: !!item.connected,
    nickname: item.nickname || '',
    avatar: item.avatar || '',
    user_id: item.user_id || '',
    connected_at: item.connected_at || null,
    daily_sync_enabled: Boolean(item.daily_sync_enabled),
    daily_sync_time: item.daily_sync_time || '04:00',
    daily_sync_target: item.daily_sync_target || 'user',
    daily_sync_user: item.daily_sync_user || item.owner_user || currentUser.username,
    daily_sync_quality: item.daily_sync_quality || 'flac',
    daily_sync_playlist_name: item.daily_sync_playlist_name || '',
    last_daily_sync_at: item.last_daily_sync_at || null,
    last_daily_sync_status: item.last_daily_sync_status || null,
    last_daily_sync_message: item.last_daily_sync_message || null
  };
}

async function runMusicAccountHelper(provider, action, cookie) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [MUSIC_ACCOUNT_SCRIPT, provider, action], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      try {
        const result = JSON.parse(stdout.trim() || '{}');
        if (code !== 0 && !result.error) result.error = stderr.trim() || '账号服务请求失败';
        resolve(result);
      } catch (e) {
        reject(new Error(stderr.trim() || '账号服务返回了无效数据'));
      }
    });
    child.stdin.end(JSON.stringify({ cookie }));
  });
}

function readRequestJson(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const hardDestroyBytes = maxBytes + 512 * 1024;
    req.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (settled) {
        if (totalBytes > hardDestroyBytes) {
          try { req.destroy(); } catch (e) {}
        }
        return;
      }
      if (totalBytes > maxBytes) {
        settled = true;
        chunks.length = 0;
        const err = new Error('请求内容过大');
        err.statusCode = 413;
        reject(err);
        if (totalBytes > hardDestroyBytes) {
          setImmediate(() => { try { req.destroy(); } catch (e) {} });
        }
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        const err = new Error('请求内容不是有效 JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function stripTaskSecrets(task) {
  if (!task || typeof task !== 'object') return task;
  const { providerCookie, ...safe } = task;
  return safe;
}

function sanitizeTaskForClient(task) {
  if (!task || typeof task !== 'object') return task;
  const { providerCookie, account_id, ...safe } = task;
  return safe;
}

let inMemoryQueueCache = null;
let queueSaveTimer = null;

function loadTaskQueue() {
  if (Array.isArray(inMemoryQueueCache)) {
    return inMemoryQueueCache;
  }
  try {
    if (fs.existsSync(TASK_QUEUE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TASK_QUEUE_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        inMemoryQueueCache = parsed.map(stripTaskSecrets);
        return inMemoryQueueCache;
      }
    }
  } catch (e) {
    console.error('Failed to load task queue:', e.message);
  }
  inMemoryQueueCache = [];
  return inMemoryQueueCache;
}

function saveTaskQueue(queue, immediate = true) {
  const cleanQueue = Array.isArray(queue) ? queue.map(stripTaskSecrets) : [];
  inMemoryQueueCache = cleanQueue;
  if (immediate) {
    if (queueSaveTimer) {
      clearTimeout(queueSaveTimer);
      queueSaveTimer = null;
    }
    try {
      fs.writeFileSync(TASK_QUEUE_FILE, JSON.stringify(cleanQueue, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (e) {
      console.error('Failed to save task queue:', e.message);
    }
  } else if (!queueSaveTimer) {
    queueSaveTimer = setTimeout(() => {
      queueSaveTimer = null;
      try {
        fs.writeFileSync(TASK_QUEUE_FILE, JSON.stringify(inMemoryQueueCache || [], null, 2), { encoding: 'utf-8', mode: 0o600 });
      } catch (e) {
        console.error('Failed to flush task queue:', e.message);
      }
    }, 600);
  }
}

function broadcastTaskQueue() {
  const queue = loadTaskQueue();
  for (const client of sseClients) {
    const visible = client.user?.isAdmin
      ? queue.map(sanitizeTaskForClient)
      : queue.filter(t => t.owner_user === client.user?.username).map(sanitizeTaskForClient);
    try {
      client.res.write(`event: queue\ndata: ${JSON.stringify(visible)}\n\n`);
    } catch (e) {}
  }
}

function runNcmAuthHelper(...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath || 'node', [NCM_AUTH_SCRIPT, ...args], { timeout: 15000 }, (error, stdout, stderr) => {
      try {
        const text = (stdout || '').trim();
        if (!text) {
          if (error) return reject(new Error(stderr || error.message));
          return reject(new Error('NCM 授权服务无返回'));
        }
        const parsed = JSON.parse(text);
        resolve(parsed);
      } catch (e) {
        if (error) return reject(new Error(stderr || error.message));
        reject(new Error(`解析 NCM 返回失败: ${e.message}`));
      }
    });
  });
}

const ephemeralTaskCookies = new Map();

function killActiveChildProcess() {
  if (!activeChildProcess) return;
  const proc = activeChildProcess;
  activeChildProcess = null;
  try {
    if (proc.pid && process.platform !== 'win32') {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    }
  } catch (e) {}
  try {
    proc.kill('SIGKILL');
  } catch (e) {}
}

function createIdleTaskSnapshot() {
  return {
    status: 'idle',
    playlist_name: '等待任务中...',
    platform: 'TRIM Music',
    target: 'public',
    user: 'all',
    total: 0,
    processed_count: 0,
    reused_count: 0,
    downloaded_count: 0,
    failed_count: 0,
    current_track: null,
    speed: null,
    start_time: null,
    end_time: null,
    tracks: [],
    updated_at: new Date().toISOString()
  };
}

function canUserAccessOwner(sessionUser, ownerUser) {
  if (!sessionUser) return false;
  if (sessionUser.isAdmin) return true;
  if (!ownerUser) return false;
  return ownerUser === sessionUser.username;
}

function getVisibleCurrentTask(sessionUser) {
  if (!currentTask || currentTask.status === 'idle') return sanitizeTaskForClient(currentTask);
  if (canUserAccessOwner(sessionUser, currentTask.owner_user)) {
    return sanitizeTaskForClient(currentTask);
  }
  return createIdleTaskSnapshot();
}

function executeSingleTask(task) {
  const reqQuality = VALID_QUALITIES.includes(String(task.quality || '').toLowerCase()) ? String(task.quality).toLowerCase() : 'flac';
  const chosenSource = task.source || getSettings().download_source || 'kw';
  const taskTitle = task.title || `${task.artist} - ${task.song}`;
  const ownerUser = task.owner_user || DEFAULT_USER;

  currentTask = {
    task_id: task.id,
    status: 'downloading',
    playlist_name: `单曲下载: ${taskTitle} (${reqQuality.toUpperCase()})`,
    platform: '全网搜索单曲',
    target: task.target || 'public',
    user: task.user || 'all',
    owner_user: ownerUser,
    total: 1,
    processed_count: 0,
    reused_count: 0,
    downloaded_count: 0,
    failed_count: 0,
    current_track: {
      title: task.song,
      artist: task.artist,
      album: task.album || task.song,
      step: `正在解析 ${reqQuality.toUpperCase()} 音频流与歌词...`,
      cover: task.cover || ''
    },
    start_time: new Date().toISOString(),
    end_time: null,
    tracks: [{ title: task.song, artist: task.artist, album: task.album || '', status: 'downloading' }],
    updated_at: new Date().toISOString()
  };
  saveCurrentTask(true);
  broadcastSSE('status', sanitizeTaskForClient(currentTask), ownerUser);

  resetLiveLogs(`=== 开始单曲下载任务: ${taskTitle} [${reqQuality.toUpperCase()}] ===`, ownerUser);

  const currentSettings = getSettings();
  const args = ['-u', MUSIC_MANAGER_SCRIPT, '--artist', task.artist, '--song', task.song, '--quality', reqQuality, '--source', chosenSource, '--force'];
  if (currentSettings.force_transcode) {
    args.push('--force-transcode', '--transcode-quality', currentSettings.transcode_quality || '320k');
  }
  if (task.album) args.push('--album', task.album);

  appendLog(`启动单曲下载: ${task.artist} - ${task.song} [${reqQuality.toUpperCase()} / ${chosenSource.toUpperCase()}]`, ownerUser);

  const childEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    DATA_DIR,
    MUSIC_DIR: getEffectiveMusicDir(),
    FNOS_DB_PATH,
    FNOS_COVER_DIR,
    INTERNAL_API_TOKEN,
    PUID,
    PGID
  };

  const child = spawn('python3', args, { env: childEnv, detached: process.platform !== 'win32' });
  activeChildProcess = child;

  let outputBuffer = '';
  child.stdout.on('data', chunk => {
    outputBuffer += chunk.toString();
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('[PROGRESS_SPEED]')) {
        const sp = trimmed.replace('[PROGRESS_SPEED]', '').trim();
        currentTask.speed = sp;
        broadcastSSE('speed', { speed: sp, task_id: currentTask.task_id }, ownerUser);
      } else {
        appendLog(trimmed, ownerUser);
      }
    }
  });

  child.stderr.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) appendLog(`[STDERR] ${line.trim()}`, ownerUser);
    }
  });

  child.on('close', code => {
    if (activeChildProcess === child) activeChildProcess = null;
    currentTask.speed = null;
    broadcastSSE('speed', { speed: '', task_id: currentTask.task_id }, ownerUser);
    appendLog(`单曲抓取进程已结束，退出码: ${code}`, ownerUser);

    const queue = loadTaskQueue();
    const qTask = queue.find(t => t.id === task.id);

    if (currentTask.status === 'stopped' || (qTask && qTask.status === 'stopped')) {
      currentTask.status = 'stopped';
      currentTask.end_time = currentTask.end_time || new Date().toISOString();
      currentTask.current_track = null;
      if (qTask) {
        qTask.status = 'stopped';
        qTask.end_time = currentTask.end_time;
      }
      saveCurrentTask(true);
      broadcastSSE('status', sanitizeTaskForClient(currentTask), ownerUser);
      saveTaskQueue(queue, true);
      broadcastTaskQueue();
      setTimeout(executeNextQueueTask, 500);
      return;
    }

    let downloadSuccess = (code === 0);
    let errorMessage = '';
    let parsedResult = null;
    try {
      const matches = outputBuffer.trim().match(/\{[\s\S]*?\}/g);
      if (matches && matches.length) {
        parsedResult = JSON.parse(matches[matches.length - 1]);
        if (parsedResult.status === 'error') {
          downloadSuccess = false;
          errorMessage = parsedResult.message || '音源解析或下载失败';
        }
      }
    } catch (e) {}

    if (downloadSuccess) {
      const isAdjusted = Boolean(parsedResult?.adjusted);
      const isRevived = Boolean(parsedResult?.revived);
      const adjustmentNote = parsedResult?.adjustment_note || '';
      const actualQuality = parsedResult?.actual_quality || parsedResult?.target_quality || reqQuality;
      const actualSource = parsedResult?.source_used || chosenSource;

      currentTask.status = 'success';
      currentTask.downloaded_count = 1;
      currentTask.processed_count = 1;
      currentTask.end_time = new Date().toISOString();
      currentTask.current_track = null;
      currentTask.adjusted = isAdjusted;
      currentTask.adjustment_note = adjustmentNote;
      if (currentTask.tracks[0]) {
        currentTask.tracks[0].status = 'downloaded';
        currentTask.tracks[0].adjusted = isAdjusted;
        currentTask.tracks[0].adjustment_note = adjustmentNote;
        currentTask.tracks[0].actual_quality = actualQuality;
        currentTask.tracks[0].source_used = actualSource;
      }

      if (qTask) {
        qTask.status = 'success';
        qTask.downloaded_count = 1;
        qTask.processed_count = 1;
        qTask.end_time = currentTask.end_time;
        qTask.adjusted = isAdjusted;
        qTask.adjustment_note = adjustmentNote;
        qTask.actual_quality = actualQuality;
        qTask.source_used = actualSource;
      }

      const historyItem = {
        id: Date.now(),
        type: 'song',
        playlist_name: `${task.artist} - ${task.song}`,
        title: task.song,
        artist: task.artist,
        album: task.album || '',
        quality: reqQuality,
        actual_quality: actualQuality,
        source: chosenSource,
        source_used: actualSource,
        source_fallback: Boolean(parsedResult?.source_fallback),
        quality_adjusted: Boolean(parsedResult?.quality_adjusted),
        adjusted: isAdjusted,
        adjustment_note: adjustmentNote,
        cover: task.cover || '',
        platform: '全网单曲下载',
        target: task.target || 'public',
        user: task.user || 'all',
        owner_user: ownerUser,
        operator: ownerUser,
        total: 1,
        reused_count: 0,
        downloaded_count: 1,
        failed_count: 0,
        start_time: currentTask.start_time,
        end_time: currentTask.end_time,
        duration: Math.max(1, Math.round((new Date(currentTask.end_time) - new Date(currentTask.start_time)) / 1000)),
        status: 'success'
      };
      let history = [];
      try {
        if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        history.unshift(historyItem);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 100), null, 2), 'utf-8');
      } catch (e) {}

      broadcastSSE('history', historyItem, ownerUser);
      appendLog(`✅ 单曲下载入库完成: ${taskTitle}${isRevived ? ' [已自动复活飞牛曲库索引]' : ''}${isAdjusted ? ` [已调整: ${adjustmentNote}]` : ''}`, ownerUser);
    } else {
      currentTask.status = 'failed';
      currentTask.failed_count = 1;
      currentTask.processed_count = 1;
      currentTask.end_time = new Date().toISOString();
      currentTask.current_track = null;
      if (currentTask.tracks[0]) currentTask.tracks[0].status = 'failed';

      if (qTask) {
        qTask.status = 'failed';
        qTask.failed_count = 1;
        qTask.processed_count = 1;
        qTask.end_time = currentTask.end_time;
        qTask.error = errorMessage || '下载失败';
      }

      appendLog(`❌ 单曲抓取失败: ${errorMessage || '进程异常退出'}`, ownerUser);
    }

    saveCurrentTask(true);
    broadcastSSE('status', sanitizeTaskForClient(currentTask), ownerUser);
    saveTaskQueue(queue, true);
    broadcastTaskQueue();

    setTimeout(executeNextQueueTask, 500);
  });
}

function executePlaylistTask(task) {
  const chosenSource = task.source || getSettings().download_source || 'kw';
  const currentMusicDir = getEffectiveMusicDir();
  const globalQuality = (task.quality || 'flac').toLowerCase().trim();
  const validQuality = VALID_QUALITIES.includes(globalQuality) ? globalQuality : 'flac';
  const ownerUser = task.owner_user || DEFAULT_USER;
  let selectedTracksFile = '';
  const trackList = (Array.isArray(task.tracks) && task.tracks.length)
    ? task.tracks
    : (Array.isArray(task.options?.tracks) && task.options.tracks.length ? task.options.tracks : []);

  if (trackList.length) {
    selectedTracksFile = path.join(DATA_DIR, `playlist_tracks_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(selectedTracksFile, JSON.stringify(trackList), { encoding: 'utf-8', mode: 0o600 });
  }

  currentTask = {
    task_id: task.id,
    status: 'parsing',
    playlist_name: task.options?.playlistName || task.title || '正在解析中...',
    platform: '第三方平台',
    url: task.url || '',
    target: task.target || 'public',
    user: task.user || DEFAULT_USER,
    owner_user: ownerUser,
    daily_account_id: task.daily_account_id || task.options?.daily_account_id || null,
    cover: task.options?.coverUrl || task.cover || '',
    total: task.total || (trackList.length ? trackList.length : 0),
    processed_count: task.processed_count || 0,
    reused_count: task.reused_count || 0,
    downloaded_count: task.downloaded_count || 0,
    failed_count: 0,
    current_track: null,
    start_time: new Date().toISOString(),
    end_time: null,
    tracks: trackList,
    updated_at: new Date().toISOString()
  };
  saveCurrentTask(true);
  broadcastSSE('status', sanitizeTaskForClient(currentTask), ownerUser);
  resetLiveLogs(`=== 开始同步任务: ${task.url} ===`, ownerUser);

  const runtimeCookie = ephemeralTaskCookies.get(task.id)
    || resolveDecryptedCookieByAccountId(task.account_id || task.daily_account_id, ownerUser)
    || '';

  const currentSettings = getSettings();
  const concurrency = currentSettings.concurrent_downloads || 5;
  const args = [
    '-u', PLAYLIST_SYNC_SCRIPT,
    '--url', task.url,
    '--target', task.target || 'public',
    '--user', task.user || DEFAULT_USER,
    '--source', chosenSource,
    '--quality', validQuality,
    '--concurrency', String(concurrency)
  ];
  if (runtimeCookie) {
    args.push('--cookie-stdin');
  }
  if (currentSettings.force_transcode) {
    args.push('--force-transcode', '--transcode-quality', currentSettings.transcode_quality || '320k');
  }
  if (task.options?.playlistName) args.push('--playlist-name', task.options.playlistName);
  if (task.options?.coverUrl) args.push('--cover-url', task.options.coverUrl);
  if (selectedTracksFile) args.push('--tracks-file', selectedTracksFile);

  const childEnv = { ...process.env };
  delete childEnv.THIRD_PARTY_COOKIE;
  Object.assign(childEnv, {
    PYTHONUNBUFFERED: '1',
    PORT: PORT.toString(),
    DATA_DIR,
    MUSIC_DIR: currentMusicDir,
    FNOS_DB_PATH,
    FNOS_COVER_DIR,
    INTERNAL_API_TOKEN,
    PUID,
    PGID,
    THIRD_PARTY_PROVIDER: task.provider || ''
  });

  const child = spawn('python3', args, {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  if (runtimeCookie) {
    try { child.stdin.end(runtimeCookie); } catch (e) {}
  } else {
    try { child.stdin.end(); } catch (e) {}
  }
  activeChildProcess = child;

  child.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('[PROGRESS_SPEED]')) {
        const sp = trimmed.replace('[PROGRESS_SPEED]', '').trim();
        currentTask.speed = sp;
        broadcastSSE('speed', { speed: sp, task_id: currentTask.task_id }, ownerUser);
      } else {
        appendLog(trimmed, ownerUser);
      }
    }
  });
  child.stderr.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(line => appendLog(`[STDERR] ${line.trim()}`, ownerUser)));
  child.on('close', code => {
    if (activeChildProcess === child) activeChildProcess = null;
    ephemeralTaskCookies.delete(task.id);
    currentTask.speed = null;
    broadcastSSE('speed', { speed: '', task_id: currentTask.task_id }, ownerUser);
    if (selectedTracksFile) {
      try { fs.rmSync(selectedTracksFile, { force: true }); } catch (e) {}
    }
    appendLog(`任务进程已结束，退出码: ${code}`, ownerUser);

    const queue = loadTaskQueue();
    const qTask = queue.find(t => t.id === task.id);

    if (currentTask.status === 'stopped' || (qTask && qTask.status === 'stopped')) {
      currentTask.status = 'stopped';
      currentTask.end_time = new Date().toISOString();
      if (qTask) {
        qTask.status = 'stopped';
        qTask.end_time = currentTask.end_time;
      }
    } else if (code !== 0 && currentTask.status !== 'success') {
      currentTask.status = 'failed';
      currentTask.end_time = new Date().toISOString();
      if (qTask) {
        qTask.status = 'failed';
        qTask.end_time = currentTask.end_time;
      }
    } else {
      if (qTask) {
        qTask.status = 'success';
        qTask.end_time = currentTask.end_time || new Date().toISOString();
        qTask.processed_count = currentTask.processed_count;
        qTask.downloaded_count = currentTask.downloaded_count;
        qTask.reused_count = currentTask.reused_count;
        qTask.failed_count = currentTask.failed_count;
        qTask.total = currentTask.total;
      }
    }
    const dailyAccId = currentTask.daily_account_id || task.daily_account_id || task.options?.daily_account_id;
    if (dailyAccId) {
      try {
        const accStore = loadMusicAccounts();
        const acc = accStore.accounts?.find(a => a.id === dailyAccId);
        if (acc) {
          const isSuccess = currentTask.status === 'success' || (qTask && qTask.status === 'success');
          acc.last_daily_sync_at = new Date().toISOString();
          acc.last_daily_sync_status = isSuccess ? 'success' : 'failed';
          acc.last_daily_sync_message = isSuccess
            ? `同步完成：共 ${currentTask.total || 0} 首（本地已收录 ${currentTask.reused_count || 0} 首，本次下载 ${currentTask.downloaded_count || 0} 首${currentTask.failed_count ? `，失败 ${currentTask.failed_count} 首` : ''}）`
            : `同步遇到异常（退出码: ${code}）`;
          saveMusicAccounts(accStore);
        }
      } catch (err) {
        console.error('Failed to update daily sync status on account:', err.message);
      }
    }

    saveCurrentTask(true);
    broadcastSSE('status', sanitizeTaskForClient(currentTask), ownerUser);
    saveTaskQueue(queue, true);
    broadcastTaskQueue();

    setTimeout(executeNextQueueTask, 500);
  });
}

function executeNextQueueTask() {
  if (activeChildProcess) return;

  const queue = loadTaskQueue();
  const pendingTasks = queue
    .filter(t => t.status === 'pending')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || new Date(a.created_at) - new Date(b.created_at));

  if (!pendingTasks.length) return;

  const nextTask = pendingTasks[0];
  nextTask.status = 'running';
  nextTask.start_time = new Date().toISOString();
  saveTaskQueue(queue, true);
  broadcastTaskQueue();

  if (nextTask.type === 'single') {
    executeSingleTask(nextTask);
  } else {
    executePlaylistTask(nextTask);
  }
}

function startPlaylistTask(url, target = 'public', user = DEFAULT_USER, provider = '', providerCookie = '', source = '', options = {}, owner_user = DEFAULT_USER, accountId = '') {
  if (!url) return { ok: false, status: 400, error: 'url is required' };
  let defaultSourceForPlatform = getSettings().download_source || 'kw';
  if (provider === 'qq' || (url && /y\.qq\.com|qq\.com/i.test(url))) {
    defaultSourceForPlatform = 'tx';
  } else if (provider === 'netease' || (url && /music\.163\.com/i.test(url))) {
    defaultSourceForPlatform = 'wy';
  }
  const chosenSource = source || defaultSourceForPlatform;
  const globalQuality = (options.quality || 'flac').toLowerCase().trim();
  const validQuality = VALID_QUALITIES.includes(globalQuality) ? globalQuality : 'flac';

  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  if (providerCookie && !accountId) {
    ephemeralTaskCookies.set(taskId, providerCookie);
  }
  const queue = loadTaskQueue();
  const pendingCount = queue.filter(t => t.status === 'pending').length;

  const newTask = {
    id: taskId,
    type: 'playlist',
    title: options.playlistName || '第三方歌单导入',
    url,
    target,
    user,
    provider,
    account_id: accountId || options.daily_account_id || '',
    source: chosenSource,
    quality: validQuality,
    options: { playlistName: options.playlistName, tracks: options.tracks, quality: validQuality, coverUrl: options.coverUrl, daily_account_id: options.daily_account_id },
    cover: options.coverUrl || '',
    owner_user: owner_user || DEFAULT_USER,
    daily_account_id: options.daily_account_id || null,
    created_at: new Date().toISOString(),
    status: 'pending',
    order: pendingCount + 1,
    total: Array.isArray(options.tracks) && options.tracks.length ? options.tracks.length : 0,
    processed_count: 0,
    reused_count: 0,
    downloaded_count: 0,
    failed_count: 0,
    current_track: null
  };
  queue.push(newTask);
  saveTaskQueue(queue, true);
  broadcastTaskQueue();

  executeNextQueueTask();
  return { ok: true, status: 200, message: activeChildProcess ? '歌单任务已排队，将按序执行' : '歌单任务已启动', task_id: taskId };
}

// Database helpers
function buildDbOpsEnv() {
  const env = { ...process.env };
  delete env.THIRD_PARTY_COOKIE;
  return {
    ...env,
    DATA_DIR,
    MUSIC_DIR: getEffectiveMusicDir(),
    FNOS_DB_PATH,
    FNOS_COVER_DIR,
    PUID,
    PGID
  };
}

async function callDbOps(...args) {
  const { stdout } = await execFileAsync('python3', [DB_OPS_SCRIPT, ...args], {
    env: buildDbOpsEnv(),
    maxBuffer: 20 * 1024 * 1024
  });
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('db_ops returned empty response');
  }
  return JSON.parse(trimmed);
}

async function callDbOpsStdin(action, payloadObj, ...extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [DB_OPS_SCRIPT, action, '-', ...extraArgs], {
      env: buildDbOpsEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        return reject(new Error(stderr.trim() || `db_ops ${action} exited with code ${code}`));
      }
      try {
        resolve(JSON.parse(trimmed));
      } catch (e) {
        reject(new Error(stderr.trim() || `Invalid JSON from db_ops ${action}`));
      }
    });
    child.stdin.end(JSON.stringify(payloadObj));
  });
}

async function runPlaylistParseOnly(url, cookie = '') {
  return new Promise((resolve, reject) => {
    const args = ['-u', PLAYLIST_SYNC_SCRIPT, '--url', String(url).trim(), '--parse-only'];
    if (cookie) args.push('--cookie-stdin');
    const env = buildDbOpsEnv();
    env.PYTHONUNBUFFERED = '1';
    const child = spawn('python3', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      reject(new Error('解析歌单超时，请检查链接或网络状态'));
    }, 25000);
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (code !== 0 || !lines.length) {
        return reject(new Error((stderr || stdout || '').trim() || '无法解析该歌单链接'));
      }
      try {
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) {
        reject(new Error('解析歌单返回格式异常'));
      }
    });
    if (cookie) {
      child.stdin.end(cookie);
    } else {
      child.stdin.end();
    }
  });
}

// Self-contained Online Music Search via Kugou Official Public API
async function searchOnlineKugou(keyword, page = 1, pageSize = 20) {
  const kw = encodeURIComponent(keyword.trim());
  const url = `http://songsearch.kugou.com/song_search_v2?keyword=${kw}&page=${page}&pagesize=${pageSize}&platform=WebFilter&filter=2&iscorrection=1`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(8000)
  });
  const json = await resp.json();
  const rawList = json?.data?.lists || [];

  const badKeywords = ['dj', '伴奏', '铃声', '片段', 'demo', '重低音', '慢摇', '变速'];
  const normalizedKeyword = keyword.trim().toLowerCase();
  const excludedKeywords = badKeywords.filter(term => !normalizedKeyword.includes(term));

  const results = [];
  for (const item of rawList) {
    const title = (item.SongName || '').replace(/<\/?em>/g, '').replace(/&nbsp;/g, ' ').trim();
    const artist = (item.SingerName || '').replace(/<\/?em>/g, '').replace(/&nbsp;/g, ' ').trim();
    const album = (item.AlbumName || '').replace(/<\/?em>/g, '').replace(/&nbsp;/g, ' ').trim();

    if (excludedKeywords.some(term => title.toLowerCase().includes(term))) {
      continue;
    }

    const img = (item.Image || '').replace('{size}', '400');
    const cover = img ? img.replace('http://', 'https://') : '';

    const available_qualities = [];
    if (item.ResFileHash && Number(item.ResFileSize || 0) > 0) {
      available_qualities.push('flac24bit');
    }
    if (item.SQFileHash && Number(item.SQFileSize || 0) > 0) {
      available_qualities.push('flac');
    }
    if (item.HQFileHash && Number(item.HQFileSize || 0) > 0) {
      available_qualities.push('320k');
    }
    if (item.FileHash && Number(item.FileSize || 0) > 0) {
      available_qualities.push('128k');
    }
    if (available_qualities.length === 0) {
      available_qualities.push(item.SQFileHash ? 'flac' : '128k');
    }

    results.push({
      title,
      artist,
      album,
      cover,
      has_sq: !!(item.SQFileHash || item.HQFileHash),
      hash: item.FileHash || '',
      available_qualities
    });
  }

  return { results, total: Number(json?.data?.total || json?.data?.totalHits || 0), page, pageSize };
}

// Probe real available audio qualities for a single track from target source
async function probeTrackQualitiesFromSource(title, artist, source) {
  const kw = `${String(title || '').trim()} ${String(artist || '').trim()}`.trim();
  if (!kw) return ['flac', '320k', '128k'];
  const quals = [];
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    if (source === 'kg' || source === 'auto') {
      const url = `http://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(kw)}&page=1&pagesize=1&platform=WebFilter&filter=2&iscorrection=1`;
      const resp = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(4500) });
      const json = await resp.json();
      const item = json?.data?.lists?.[0];
      if (item) {
        if (Number(item.ResFileSize || 0) > 0 || item.ResFileHash) quals.push('flac24bit');
        if (Number(item.SQFileSize || 0) > 0 || item.SQFileHash) quals.push('flac');
        if (Number(item.HQFileSize || 0) > 0 || item.HQFileHash) quals.push('320k');
        if (Number(item.FileSize || 0) > 0 || item.FileHash) quals.push('128k');
      }
    } else if (source === 'tx') {
      const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
      const payload = {
        req_1: {
          method: 'DoSearchForQQMusicDesktop',
          module: 'music.search.SearchCgiService',
          param: { num_per_page: 1, page_num: 1, query: kw, search_type: 0 }
        }
      };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': ua, 'Content-Type': 'application/json', 'Referer': 'https://y.qq.com' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4500)
      });
      const json = await resp.json();
      const item = json?.req_1?.data?.body?.song?.list?.[0];
      const f = item?.file || {};
      if (Number(f.size_hires || 0) > 0) quals.push('flac24bit');
      if (Number(f.size_flac || 0) > 0 || Number(f.size_ape || 0) > 0) quals.push('flac');
      if (Number(f.size_320mp3 || 0) > 0) quals.push('320k');
      if (Number(f.size_128mp3 || 0) > 0) quals.push('128k');
    } else if (source === 'wy') {
      const url = 'https://music.163.com/api/cloudsearch/pc';
      const body = new URLSearchParams({ s: kw, type: '1', limit: '1', offset: '0' }).toString();
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://music.163.com' },
        body,
        signal: AbortSignal.timeout(4500)
      });
      const json = await resp.json();
      const item = json?.result?.songs?.[0];
      if (item) {
        if (item.hr) quals.push('flac24bit');
        if (item.sq) quals.push('flac');
        if (item.h) quals.push('320k');
        if (item.m || item.l) quals.push('128k');
      }
    } else if (source === 'kw') {
      const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(kw)}&pn=0&rn=1&vipver=1&ft=music&encoding=utf8&rformat=json&mobi=1`;
      const resp = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(4500) });
      const json = await resp.json();
      const item = json?.abslist?.[0];
      if (item) {
        const combo = `${item.MINFO || ''};${item.N_MINFO || ''}`;
        if (combo.includes('zp') || combo.includes('bitrate:20000')) quals.push('flac24bit');
        if (combo.includes('format:flac') || combo.includes('level:ff') || combo.includes('mflac')) quals.push('flac');
        if (combo.includes('bitrate:320')) quals.push('320k');
        if (combo.includes('bitrate:128')) quals.push('128k');
      }
    }
  } catch (e) {
    // Fallback gracefully on timeout or network error
  }
  return quals.length > 0 ? quals : ['flac', '320k', '128k'];
}

async function batchProbeTrackQualities(tracks, source) {
  const results = new Array(tracks.length);
  const concurrency = 8;
  let idx = 0;

  async function worker() {
    while (idx < tracks.length) {
      const current = idx++;
      const t = tracks[current];
      if (t.exists) {
        results[current] = { index: t.index ?? current, available_qualities: t.available_qualities || ['flac', '320k', '128k'] };
      } else {
        const quals = await probeTrackQualitiesFromSource(t.title, t.artist, source);
        results[current] = { index: t.index ?? current, available_qualities: quals };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tracks.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

// State Management
let currentTask = createIdleTaskSnapshot();
let currentTaskSaveTimer = null;

try {
  if (fs.existsSync(CURRENT_TASK_FILE)) {
    const raw = fs.readFileSync(CURRENT_TASK_FILE, 'utf-8');
    currentTask = { ...currentTask, ...stripTaskSecrets(JSON.parse(raw)) };
  }
} catch (e) {
  console.error('Failed to load current task:', e.message);
}

function saveCurrentTask(immediate = true) {
  const safeTask = stripTaskSecrets(currentTask);
  if (immediate) {
    if (currentTaskSaveTimer) {
      clearTimeout(currentTaskSaveTimer);
      currentTaskSaveTimer = null;
    }
    try {
      fs.writeFileSync(CURRENT_TASK_FILE, JSON.stringify(safeTask, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (e) {
      console.error('Failed to save current task:', e.message);
    }
  } else if (!currentTaskSaveTimer) {
    currentTaskSaveTimer = setTimeout(() => {
      currentTaskSaveTimer = null;
      try {
        fs.writeFileSync(CURRENT_TASK_FILE, JSON.stringify(stripTaskSecrets(currentTask), null, 2), { encoding: 'utf-8', mode: 0o600 });
      } catch (e) {
        console.error('Failed to flush current task:', e.message);
      }
    }, 600);
  }
}

const recentLogEntries = [];
const MAX_RECENT_LOGS = 500;

function resetLiveLogs(headerLine, ownerUser = '') {
  recentLogEntries.length = 0;
  const line = `${headerLine}\n`;
  recentLogEntries.push({ text: headerLine, owner_user: ownerUser });
  try {
    fs.writeFileSync(LOG_FILE, line, { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {}
}

function appendLog(line, ownerUser = currentTask?.owner_user || '') {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const formatted = `[${timestamp}] ${line}`;
  recentLogEntries.push({ text: formatted, owner_user: ownerUser });
  if (recentLogEntries.length > MAX_RECENT_LOGS) {
    recentLogEntries.splice(0, recentLogEntries.length - MAX_RECENT_LOGS);
  }
  try {
    fs.appendFileSync(LOG_FILE, `${formatted}\n`, 'utf-8');
  } catch (e) {}
  broadcastSSE('log', { text: formatted }, ownerUser);
}

// SSE Push Mechanism (stores { res, user } per client for multi-tenant isolation)
const sseClients = new Set();
function broadcastSSE(event, data, ownerUser = null) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (ownerUser && !canUserAccessOwner(client.user, ownerUser)) {
      continue;
    }
    try {
      client.res.write(msg);
    } catch (e) {}
  }
}

let activeChildProcess = null;

function getShanghaiTimeString() {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(d);
  let year = '', month = '', day = '', hour = '', minute = '';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
    if (p.type === 'hour') hour = p.value;
    if (p.type === 'minute') minute = p.value;
  }
  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${hour}:${minute}`
  };
}

async function triggerDailySyncForAccount(accId, isManual = false) {
  const store = loadMusicAccounts();
  const acc = store.accounts?.find(a => a.id === accId || a.provider === accId);
  if (!acc || !acc.connected || !acc.secret) {
    throw new Error('账号未连接或凭据不存在');
  }
  const cookie = decryptSecret(acc.secret);
  const recResult = await runMusicAccountHelper(acc.provider, 'daily_recommend', cookie);
  if (!recResult || !recResult.connected || !Array.isArray(recResult.tracks) || !recResult.tracks.length) {
    acc.last_daily_sync_status = 'failed';
    acc.last_daily_sync_at = new Date().toISOString();
    acc.last_daily_sync_message = recResult?.error || '未能获取到今日推荐歌曲或推荐列表为空';
    saveMusicAccounts(store);
    throw new Error(acc.last_daily_sync_message);
  }

  const defaultTitle = acc.provider === 'qq' ? 'QQ音乐每日推荐' : '网易云每日推荐';
  const playlistName = acc.daily_sync_playlist_name || defaultTitle;
  const ownerUser = acc.owner_user || DEFAULT_USER;
  const targetScope = acc.daily_sync_target || 'user';
  const targetUser = targetScope === 'public' ? 'all' : (acc.daily_sync_user || ownerUser);
  const quality = VALID_QUALITIES.includes(acc.daily_sync_quality) ? acc.daily_sync_quality : 'flac';
  const importUrl = recResult.import_url || (acc.provider === 'qq' ? `daily://qq/${acc.id}` : `daily://netease/${acc.id}`);

  acc.last_daily_sync_status = 'running';
  acc.last_daily_sync_at = new Date().toISOString();
  acc.last_daily_sync_message = '已创建同步任务，正在排队下载入库…';
  saveMusicAccounts(store);

  const startRes = startPlaylistTask(
    importUrl,
    targetScope,
    targetUser,
    acc.provider,
    '',
    '',
    {
      playlistName,
      tracks: recResult.tracks,
      quality,
      coverUrl: recResult.cover_url || '',
      daily_account_id: acc.id
    },
    ownerUser,
    acc.id
  );

  if (!startRes.ok) {
    acc.last_daily_sync_status = 'failed';
    acc.last_daily_sync_message = startRes.error || '创建同步任务失败';
    saveMusicAccounts(store);
    throw new Error(startRes.error || '创建同步任务失败');
  }

  return {
    ok: true,
    playlist_name: playlistName,
    track_count: recResult.tracks.length,
    task_id: startRes.task_id,
    message: startRes.message
  };
}

function checkScheduledDailySync() {
  try {
    const { dateStr, timeStr } = getShanghaiTimeString();
    const store = loadMusicAccounts();
    const accounts = store.accounts || [];
    for (const acc of accounts) {
      if (!acc.connected || !acc.daily_sync_enabled || !acc.secret) continue;
      const targetTime = acc.daily_sync_time || '04:00';
      if (timeStr === targetTime && acc.last_daily_sync_date !== dateStr) {
        acc.last_daily_sync_date = dateStr;
        saveMusicAccounts(store);
        appendLog(`[定时任务] 触发账号 ${acc.nickname || acc.id} (${acc.provider}) 的每日推荐自动同步 (${timeStr})...`);
        triggerDailySyncForAccount(acc.id, false).catch(err => {
          appendLog(`[定时任务错误] 账号 ${acc.nickname || acc.id} 每日推荐同步失败: ${err.message}`);
        });
      }
    }
  } catch (err) {
    console.error('checkScheduledDailySync error:', err);
  }
}

async function handleHttpRequest(req, res) {
  try {
  let rawUrl = req.url || '/';
  if (req.__fromFnGateway && GATEWAY_PREFIX) {
    if (rawUrl === GATEWAY_PREFIX || rawUrl.startsWith(`${GATEWAY_PREFIX}?`)) {
      const qs = rawUrl.slice(GATEWAY_PREFIX.length);
      res.writeHead(302, { Location: `${GATEWAY_PREFIX}/${qs}` });
      res.end();
      return;
    }
    if (rawUrl.startsWith(`${GATEWAY_PREFIX}/`)) {
      rawUrl = rawUrl.slice(GATEWAY_PREFIX.length) || '/';
    }
  }
  const reqUrl = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const isHttps = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket?.encrypted);
  const cookieSecureFlag = isHttps ? '; Secure' : '';

  // 获取会话用户（基于 Token / Cookie；飞牛统一网关 Unix Socket 请求自动映射 NAS 登录身份）
  let sessionUser = getSessionUser(req, reqUrl);
  if (req.__fromFnGateway && req.headers['x-trim-username']) {
    sessionUser = await resolveGatewayUser(req, res, sessionUser, cookieSecureFlag);
  }

  // ==================== 身份认证与健康检查 API (公开访问) ====================
  if (pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, status: 'healthy', timestamp: Date.now() }));
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const clientIp = getClientIp(req);
    const rateCheck = checkLoginRateLimit(clientIp);
    if (!rateCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(rateCheck.retrySec)
      });
      res.end(JSON.stringify({ ok: false, error: `登录尝试过于频繁，请 ${rateCheck.retrySec} 秒后再试` }));
      return;
    }

    try {
      const { username, password } = await readRequestJson(req, 16 * 1024);
      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '请输入飞牛账号和密码' }));
        return;
      }

      const authRes = await authenticateWithFnOS(username, password);
      if (!authRes.ok) {
        recordLoginFailure(clientIp);
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: authRes.error }));
        return;
      }

      clearLoginFailures(clientIp);

      // 获取用户在飞牛音乐中的对应角色和 ID
      let userId = 1000;
      let role = 'member';
      try {
        const users = await callDbOps('list_users');
        const matched = (users || []).find(u => u.name && u.name.toLowerCase() === String(username).trim().toLowerCase());
        if (matched) {
          userId = matched.id;
          role = matched.role || 'member';
        }
      } catch (e) {
        console.error('Failed to query users from music.db:', e.message);
      }

      const isAdmin = role === 'admin';
      const sessionData = {
        username: String(username).trim(),
        userId,
        role,
        isAdmin,
        exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30天有效
      };
      const token = signToken(sessionData);

      res.setHeader('Set-Cookie', `fn_music_token=${token}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax; HttpOnly${cookieSecureFlag}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, user: sessionData, token }));
    } catch (e) {
      const code = e.statusCode || 500;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const clearCookies = [`fn_music_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${cookieSecureFlag}`];
    if (GATEWAY_PREFIX && GATEWAY_PREFIX !== '/') {
      clearCookies.push(`fn_music_token=; Path=${GATEWAY_PREFIX}; Max-Age=0; SameSite=Lax; HttpOnly${cookieSecureFlag}`);
    }
    res.setHeader('Set-Cookie', clearCookies);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: '已退出登录' }));
    return;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!sessionUser) {
      res.end(JSON.stringify({ ok: true, loggedIn: false }));
    } else {
      res.end(JSON.stringify({ ok: true, loggedIn: true, user: sessionUser }));
    }
    return;
  }

  // ==================== 全局未登录与内部接口鉴权拦截 ====================
  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/update-status') {
      const providedInternal = String(req.headers['x-internal-token'] || '');
      if (!safeEqualStrings(providedInternal, INTERNAL_API_TOKEN)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden internal status endpoint' }));
        return;
      }
    } else if (!sessionUser) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '未登录或登录已失效，请重新登录飞牛账号', needLogin: true }));
      return;
    }
  }

  // ==================== SSE 实时推流 ====================
  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const visibleTask = getVisibleCurrentTask(sessionUser);
    const fullQueue = loadTaskQueue();
    const visibleQueue = sessionUser.isAdmin
      ? fullQueue.map(sanitizeTaskForClient)
      : fullQueue.filter(t => t.owner_user === sessionUser.username).map(sanitizeTaskForClient);

    res.write(`event: init\ndata: ${JSON.stringify(visibleTask)}\n\n`);
    res.write(`event: queue\ndata: ${JSON.stringify(visibleQueue)}\n\n`);
    const clientEntry = { res, user: sessionUser };
    sseClients.add(clientEntry);

    req.on('close', () => {
      sseClients.delete(clientEntry);
    });
    return;
  }

  // ==================== 业务 API ====================
  if (pathname === '/api/status' && req.method === 'GET') {
    const visibleTask = getVisibleCurrentTask(sessionUser);
    const isVisibleRunning = Boolean(activeChildProcess && canUserAccessOwner(sessionUser, currentTask?.owner_user));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: visibleTask, isRunning: isVisibleRunning }));
    return;
  }

  // Settings API
  if (pathname === '/api/settings' && req.method === 'GET') {
    const settings = getSettings();
    settings.effective_music_dir = getEffectiveMusicDir();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: sanitizeSettingsForUser(settings, sessionUser) }));
    return;
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!sessionUser.isAdmin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '权限不足：仅管理员可以修改系统与音源设置' }));
      return;
    }
    try {
      const { download_source, download_dir, is_configured, custom_source, concurrent_downloads, force_transcode, transcode_quality } = await readRequestJson(req);
      const validSources = ['kw', 'kg', 'tx', 'wy', 'auto', 'custom'];
      const current = getSettings();
      if (typeof force_transcode === 'boolean') {
        current.force_transcode = force_transcode;
      }
      if (transcode_quality !== undefined) {
        if (!VALID_QUALITIES.includes(transcode_quality)) throw new Error('不支持的目标转码品质');
        current.transcode_quality = transcode_quality;
      }
      if (download_source !== undefined) {
        if (!validSources.includes(download_source)) throw new Error('不支持的下载音源');
        current.download_source = download_source;
      }
      if (concurrent_downloads !== undefined) {
        const cd = parseInt(concurrent_downloads, 10);
        if (isNaN(cd) || cd < 1 || cd > 10) throw new Error('同时下载歌曲数必须在 1 到 10 之间');
        current.concurrent_downloads = cd;
      }
      if (download_dir !== undefined) {
        if (typeof download_dir !== 'string' || !download_dir.trim()) throw new Error('下载目录不能为空');
        const targetDir = download_dir.trim();

        const queue = loadTaskQueue();
        const hasActiveTasks = Boolean(activeChildProcess) || queue.some(t => t.status === 'running' || t.status === 'pending');
        if (hasActiveTasks && targetDir !== current.download_dir) {
          throw new Error('当前有任务正在执行或排队中，禁止修改下载目录！');
        }

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true, mode: 0o775 });
        }
        try {
          fs.chmodSync(targetDir, 0o775);
          const uidNum = parseInt(PUID, 10);
          const gidNum = parseInt(PGID, 10);
          if (!isNaN(uidNum) && !isNaN(gidNum)) {
            fs.chownSync(targetDir, uidNum, gidNum);
          }
        } catch (e) {}
        current.download_dir = targetDir;
      }
      if (typeof is_configured === 'boolean') current.is_configured = is_configured;
      if (custom_source && typeof custom_source === 'object') {
        const nextKey = String(custom_source.api_key ?? '').trim();
        current.custom_source = {
          name: String(custom_source.name || '自建音乐解析服务').trim(),
          api_url: String(custom_source.api_url || '').trim(),
          api_key: nextKey === '********' ? (current.custom_source?.api_key || '') : nextKey,
          script_url: String(custom_source.script_url || '').trim()
        };
      }
      saveSettings(current);
      appendLog(`[系统设置] 下载设置已更新 (音源: ${current.download_source.toUpperCase()}, 目录: ${current.download_dir || getEffectiveMusicDir()})`, sessionUser.username);
      current.effective_music_dir = getEffectiveMusicDir();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data: current }));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/settings/directories' && req.method === 'GET') {
    try {
      const data = await callDbOps('list_authorized_directories');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/settings/verify-directory' && req.method === 'POST') {
    if (!sessionUser.isAdmin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '权限不足：仅管理员可以验证目录权限' }));
      return;
    }
    try {
      const { path: dirPath } = await readRequestJson(req);
      if (!dirPath || typeof dirPath !== 'string') throw new Error('缺少目录路径');
      const data = await callDbOps('verify_directory', dirPath.trim());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ==================== 第三方音乐账号相关 API ====================
  // 网易云二维码生成
  if (pathname === '/api/music-accounts/netease/qr/create' && req.method === 'POST') {
    try {
      const authRes = await runNcmAuthHelper('get_qr');
      if (!authRes || !authRes.ok) throw new Error(authRes?.error || '获取网易云登录密钥失败');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, unikey: authRes.unikey, qr_url: authRes.qr_url, qr_img: authRes.qr_img }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message || '二维码生成失败' }));
    }
    return;
  }

  // 网易云二维码状态轮询
  if (pathname === '/api/music-accounts/netease/qr/check' && req.method === 'POST') {
    try {
      const { unikey } = await readRequestJson(req);
      if (!unikey) throw new Error('缺少 unikey');
      const authRes = await runNcmAuthHelper('check_qr', unikey);
      const code = authRes?.code;
      if (code === 800) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, status: 'expired', code, message: '二维码已过期，请刷新' }));
        return;
      }
      if (code === 801) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, status: 'waiting', code, message: '等待手机扫码' }));
        return;
      }
      if (code === 802) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, status: 'scanned', code, message: '已扫码，请在手机上点击确认授权' }));
        return;
      }
      if (code === 803) {
        const cookie = authRes.cookie;
        if (!cookie) throw new Error('未能获取到登录 Cookie');
        const status = await runMusicAccountHelper('netease', 'status', cookie);
        if (!status.connected) throw new Error(status.error || '登录状态验证失败');

        const store = loadMusicAccounts();
        const accId = `acc_netease_${sessionUser.username}`;
        const existingIndex = store.accounts.findIndex(a => a.id === accId || (a.provider === 'netease' && a.owner_user === sessionUser.username));
        const prevAcc = existingIndex >= 0 ? store.accounts[existingIndex] : {};
        const newAcc = {
          ...prevAcc,
          id: accId,
          provider: 'netease',
          owner_user: sessionUser.username,
          secret: encryptSecret(cookie),
          connected: true,
          nickname: status.nickname || '网易云用户',
          avatar: status.avatar || '',
          user_id: status.user_id || '',
          connected_at: new Date().toISOString()
        };
        if (existingIndex >= 0) {
          store.accounts[existingIndex] = newAcc;
        } else {
          store.accounts.push(newAcc);
        }
        saveMusicAccounts(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, status: 'success', code: 803, message: '登录成功', account: publicMusicAccount(newAcc, sessionUser) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, status: 'unknown', code, message: authRes?.message || '未知状态' }));
    } catch (e) {
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message || '二维码状态检查失败' }));
    }
    return;
  }

  // 账号列表 API (管理员可见所有账号，普通用户可见自身账号)
  if (pathname === '/api/music-accounts' && req.method === 'GET') {
    const store = loadMusicAccounts();
    const allAccounts = store.accounts || [];
    const providers = Object.keys(MUSIC_PROVIDER_META);

    let resultList = [];
    if (sessionUser.isAdmin) {
      for (const acc of allAccounts) {
        if (acc.connected) {
          resultList.push(publicMusicAccount(acc, sessionUser));
        }
      }
      for (const prov of providers) {
        const hasSelf = allAccounts.some(a => a.provider === prov && a.owner_user === sessionUser.username && a.connected);
        if (!hasSelf) {
          resultList.push({
            id: prov,
            provider: prov,
            name: MUSIC_PROVIDER_META[prov].name,
            owner_user: sessionUser.username,
            is_self: true,
            available: MUSIC_PROVIDER_META[prov].available,
            login_method: MUSIC_PROVIDER_META[prov].login_method,
            hint: MUSIC_PROVIDER_META[prov].hint,
            connected: false,
            nickname: '',
            avatar: '',
            user_id: '',
            connected_at: null,
            daily_sync_enabled: false,
            daily_sync_time: '04:00',
            daily_sync_target: 'user',
            daily_sync_user: sessionUser.username,
            daily_sync_quality: 'flac',
            daily_sync_playlist_name: '',
            last_daily_sync_at: null,
            last_daily_sync_status: null,
            last_daily_sync_message: null
          });
        }
      }
    } else {
      for (const prov of providers) {
        const found = allAccounts.find(a => a.provider === prov && a.owner_user === sessionUser.username && a.connected);
        if (found) {
          resultList.push(publicMusicAccount(found, sessionUser));
        } else {
          resultList.push({
            id: prov,
            provider: prov,
            name: MUSIC_PROVIDER_META[prov].name,
            owner_user: sessionUser.username,
            is_self: true,
            available: MUSIC_PROVIDER_META[prov].available,
            login_method: MUSIC_PROVIDER_META[prov].login_method,
            hint: MUSIC_PROVIDER_META[prov].hint,
            connected: false,
            nickname: '',
            avatar: '',
            user_id: '',
            connected_at: null,
            daily_sync_enabled: false,
            daily_sync_time: '04:00',
            daily_sync_target: 'user',
            daily_sync_user: sessionUser.username,
            daily_sync_quality: 'flac',
            daily_sync_playlist_name: '',
            last_daily_sync_at: null,
            last_daily_sync_status: null,
            last_daily_sync_message: null
          });
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: resultList }));
    return;
  }

  // 账号操作路由 (支持 provider 或具体 account_id)
  const accountMatch = pathname.match(/^\/api\/music-accounts\/([^/]+)(?:\/(playlists|import|daily-recommend|daily-sync|settings))?$/);
  if (accountMatch) {
    const target = decodeURIComponent(accountMatch[1]);
    const action = accountMatch[2] || '';
    const store = loadMusicAccounts();
    const allAccounts = store.accounts || [];

    const findAccount = () => {
      let acc = allAccounts.find(a => a.id === target);
      if (acc) return acc;
      acc = allAccounts.find(a => a.provider === target && a.owner_user === sessionUser.username);
      if (acc) return acc;
      if (sessionUser.isAdmin) {
        acc = allAccounts.find(a => a.provider === target);
        if (acc) return acc;
      }
      return null;
    };

    // POST: 绑定 Cookie
    if (!action && req.method === 'POST') {
      try {
        const body = await readRequestJson(req, 64 * 1024);
        const cookie = String(body.cookie || '').trim();
        if (!cookie) throw new Error('请粘贴登录 Cookie');

        const provider = (target === 'netease' || target === 'qq' || target === 'bodian')
          ? target
          : (findAccount()?.provider || '');
        if (!provider || !MUSIC_PROVIDER_META[provider]?.available) {
          throw new Error('不支持或未知的平台');
        }

        const status = await runMusicAccountHelper(provider, 'status', cookie);
        if (!status.connected) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: status.error || '登录状态验证失败' }));
          return;
        }

        const accId = `acc_${provider}_${sessionUser.username}`;
        const existingIdx = allAccounts.findIndex(a => a.id === accId || (a.provider === provider && a.owner_user === sessionUser.username));
        const prevAcc = existingIdx >= 0 ? allAccounts[existingIdx] : {};
        const newAcc = {
          ...prevAcc,
          id: accId,
          provider,
          owner_user: sessionUser.username,
          secret: encryptSecret(cookie),
          connected: true,
          nickname: status.nickname || MUSIC_PROVIDER_META[provider].name,
          avatar: status.avatar || '',
          user_id: status.user_id || '',
          connected_at: new Date().toISOString()
        };
        if (existingIdx >= 0) {
          allAccounts[existingIdx] = newAcc;
        } else {
          allAccounts.push(newAcc);
        }
        saveMusicAccounts({ accounts: allAccounts });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: publicMusicAccount(newAcc, sessionUser) }));
      } catch (e) {
        res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // DELETE: 断开账号
    if (!action && req.method === 'DELETE') {
      const acc = findAccount();
      if (!acc) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '账号不存在' }));
        return;
      }
      if (!sessionUser.isAdmin && acc.owner_user !== sessionUser.username) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '无权删除其他用户的账号凭据' }));
        return;
      }
      store.accounts = allAccounts.filter(a => a.id !== acc.id);
      saveMusicAccounts(store);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET playlists: 获取歌单
    if (action === 'playlists' && req.method === 'GET') {
      try {
        const acc = findAccount();
        if (!acc || !acc.secret) throw new Error('请先连接账号');
        if (!sessionUser.isAdmin && acc.owner_user !== sessionUser.username) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '无权查看其他用户的账号歌单' }));
          return;
        }
        const cookie = decryptSecret(acc.secret);
        const result = await runMusicAccountHelper(acc.provider, 'playlists', cookie);
        if (!result.connected) throw new Error(result.error || '登录状态已失效，请重新连接');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: result.playlists || [] }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST import: 导入指定歌单
    if (action === 'import' && req.method === 'POST') {
      try {
        const body = await readRequestJson(req);
        const urls = Array.isArray(body.urls) ? body.urls.filter(url => typeof url === 'string' && url.trim()).map(url => url.trim()) : [];
        if (urls.length !== 1) throw new Error('当前一次只能导入一个歌单');
        const acc = findAccount();
        if (!acc || !acc.secret) throw new Error('请先连接账号');
        if (!sessionUser.isAdmin && acc.owner_user !== sessionUser.username) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '无权操作其他用户的账号' }));
          return;
        }
        const targetScope = sessionUser.isAdmin ? (body.target === 'public' ? 'public' : 'user') : 'user';
        const targetUser = sessionUser.isAdmin
          ? (targetScope === 'public' ? 'all' : (body.user || acc.owner_user || sessionUser.username))
          : sessionUser.username;
        const result = startPlaylistTask(urls[0], targetScope, targetUser, acc.provider, '', '', {}, sessionUser.username, acc.id);
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result.ok ? { ok: true, message: result.message, task_id: result.task_id } : { ok: false, error: result.error }));
      } catch (e) {
        res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // GET daily-recommend: 获取今日推荐歌曲并标记本地是否已收录
    if (action === 'daily-recommend' && req.method === 'GET') {
      try {
        const acc = findAccount();
        if (!acc || !acc.secret) throw new Error('请先连接账号');
        if (!sessionUser.isAdmin && acc.owner_user !== sessionUser.username) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '无权查看其他用户的推荐歌曲' }));
          return;
        }
        const cookie = decryptSecret(acc.secret);
        const result = await runMusicAccountHelper(acc.provider, 'daily_recommend', cookie);
        if (!result.connected) throw new Error(result.error || '登录状态已失效，请重新连接');

        let checkResults = [];
        try {
          checkResults = await callDbOpsStdin('batch_check', (result.tracks || []).map(track => ({ title: track.title, artist: track.artist })));
        } catch (e) {
          console.error('Daily recommend batch check error:', e.message);
        }
        const tracks = (result.tracks || []).map((track, index) => ({
          ...track,
          index,
          exists: Boolean(checkResults[index]?.exists),
          local_path: checkResults[index]?.path || ''
        }));
        const preview = {
          platform: acc.provider === 'qq' ? 'QQ音乐' : (acc.provider === 'netease' ? '网易云音乐' : acc.name),
          playlist_name: result.playlist_name || `${acc.provider === 'qq' ? 'QQ音乐' : '网易云'}今日推荐`,
          cover_url: result.cover_url || '',
          track_count: tracks.length,
          tracks,
          import_url: result.import_url || '',
          matched_account: {
            id: acc.id,
            provider: acc.provider,
            name: MUSIC_PROVIDER_META[acc.provider]?.name || acc.provider,
            owner_user: acc.owner_user || '',
            nickname: acc.nickname || ''
          }
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: preview }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST daily-sync: 立即触发今日推荐同步
    if (action === 'daily-sync' && req.method === 'POST') {
      try {
        const acc = findAccount();
        if (!acc || !acc.secret) throw new Error('请先连接账号');
        if (!sessionUser.isAdmin && acc.owner_user !== sessionUser.username) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '无权操作其他用户的账号' }));
          return;
        }
        const syncRes = await triggerDailySyncForAccount(acc.id, true);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: syncRes }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST settings: 保存日推自动同步偏好设置
    if (action === 'settings' && req.method === 'POST') {
      try {
        const acc = findAccount();
        if (!acc) throw new Error('账号不存在');
        if (!sessionUser.isAdmin && acc.owner_user !== sessionUser.username) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '无权修改其他用户的账号配置' }));
          return;
        }
        const body = await readRequestJson(req);
        if (typeof body.daily_sync_enabled !== 'undefined') {
          acc.daily_sync_enabled = Boolean(body.daily_sync_enabled);
        }
        if (typeof body.daily_sync_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.daily_sync_time)) {
          acc.daily_sync_time = body.daily_sync_time;
        }
        if (sessionUser.isAdmin) {
          if (body.daily_sync_target === 'public' || body.daily_sync_target === 'user') {
            acc.daily_sync_target = body.daily_sync_target;
          }
          if (typeof body.daily_sync_user === 'string' && body.daily_sync_user.trim()) {
            acc.daily_sync_user = body.daily_sync_user.trim();
          }
        } else {
          acc.daily_sync_target = 'user';
          acc.daily_sync_user = sessionUser.username;
        }
        if (VALID_QUALITIES.includes(body.daily_sync_quality)) {
          acc.daily_sync_quality = body.daily_sync_quality;
        }
        if (typeof body.daily_sync_playlist_name === 'string') {
          acc.daily_sync_playlist_name = body.daily_sync_playlist_name.trim();
        }
        saveMusicAccounts(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: publicMusicAccount(acc, sessionUser) }));
      } catch (e) {
        res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
  }

  // Users API
  if (pathname === '/api/users' && req.method === 'GET') {
    if (!sessionUser.isAdmin) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        data: [{ id: sessionUser.userId || 0, name: sessionUser.username, role: 'member' }]
      }));
      return;
    }
    try {
      const data = await callDbOps('list_users');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data: [{ id: 1, name: DEFAULT_USER, role: 'admin' }] }));
    }
    return;
  }

  // History API (isolated per user for non-admins)
  if (pathname === '/api/history' && req.method === 'GET') {
    let history = [];
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      }
    } catch (e) {}
    if (!sessionUser.isAdmin) {
      history = history.filter(h => (h.owner_user || h.operator) === sessionUser.username);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: history }));
    return;
  }

  // Delete History Item
  if (pathname === '/api/history/delete' && req.method === 'POST') {
    try {
      const { id } = await readRequestJson(req);
      let history = [];
      if (fs.existsSync(HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      }
      const targetItem = history.find(h => h.id === id);
      if (!targetItem) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const itemOwner = targetItem.owner_user || targetItem.operator || '';
      if (!sessionUser.isAdmin && itemOwner !== sessionUser.username) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '权限不足：仅可删除自己的操作记录' }));
        return;
      }
      history = history.filter(h => h.id !== id);
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), { encoding: 'utf-8', mode: 0o600 });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Clear History
  if (pathname === '/api/history/clear' && req.method === 'POST') {
    try {
      if (sessionUser.isAdmin) {
        fs.writeFileSync(HISTORY_FILE, '[]', { encoding: 'utf-8', mode: 0o600 });
      } else if (fs.existsSync(HISTORY_FILE)) {
        const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        const remaining = (Array.isArray(history) ? history : []).filter(
          h => (h.owner_user || h.operator) !== sessionUser.username
        );
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(remaining, null, 2), { encoding: 'utf-8', mode: 0o600 });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // fnOS scraped cover cache + fallback cover directory (DATA_DIR/covers when /app/cover is read-only)
  const coverMatch = pathname.match(/^\/api\/covers\/(playlist|track|album|artist)\/([a-f0-9]{32})$/i);
  if (coverMatch && req.method === 'GET') {
    const [, rawType, rawGuid] = coverMatch;
    const initialType = rawType.toLowerCase();
    const guid = rawGuid.toLowerCase();
    const requestedSize = reqUrl.searchParams.get('size') || '160';
    const size = new Set(['120', '160', '400', '600', '800']).has(requestedSize) ? requestedSize : '160';
    const typesToSearch = [initialType, 'album', 'track', 'artist', 'playlist']
      .filter((item, index, list) => list.indexOf(item) === index);
    const coverRoots = [FNOS_COVER_DIR, FALLBACK_COVER_DIR].filter(Boolean);
    let coverPath = null;

    outerLoop:
    for (const rootDir of coverRoots) {
      for (const currentType of typesToSearch) {
        const typeRoot = path.resolve(rootDir, currentType);
        const shardRoot = path.resolve(typeRoot, guid.slice(0, 2));
        const candidates = [
          path.resolve(shardRoot, `${guid}_w${size}.jpg`),
          path.resolve(shardRoot, `${guid}_w400.jpg`),
          path.resolve(shardRoot, `${guid}_w160.jpg`),
          path.resolve(shardRoot, `${guid}_w120.jpg`),
          path.resolve(shardRoot, `${guid}_w600.jpg`),
          path.resolve(shardRoot, `${guid}_w800.jpg`),
          path.resolve(shardRoot, guid)
        ];
        coverPath = candidates.find(candidate => candidate.startsWith(`${typeRoot}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (coverPath) break outerLoop;
      }
    }

    if (!coverPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Cover not found');
      return;
    }

    const header = Buffer.alloc(12);
    const fd = fs.openSync(coverPath, 'r');
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    const signature = header.subarray(0, bytesRead);
    let contentType = 'application/octet-stream';
    if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) contentType = 'image/jpeg';
    else if (signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) contentType = 'image/png';
    else if (signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP') contentType = 'image/webp';
    else if (signature.subarray(0, 3).toString('ascii') === 'GIF') contentType = 'image/gif';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(coverPath).pipe(res);
    return;
  }

  // Helper to resolve a playlist visible to sessionUser by ID/playlist_ids/name
  const resolveSessionPlaylist = async ({ playlist_id, playlist_ids, name }) => {
    const visibleList = await callDbOps(
      'list_playlists',
      String(sessionUser.userId ?? ''),
      sessionUser.isAdmin ? 'true' : 'false'
    );
    const list = Array.isArray(visibleList) ? visibleList : [];
    const hasPid = playlist_id !== undefined && playlist_id !== null && String(playlist_id).trim() !== '';
    const pidNum = hasPid ? Number(playlist_id) : NaN;
    if (!Number.isNaN(pidNum)) {
      return list.find(p => Number(p.id) === pidNum || (Array.isArray(p.playlist_ids) && p.playlist_ids.map(Number).includes(pidNum))) || null;
    }
    if (Array.isArray(playlist_ids) && playlist_ids.length > 0) {
      const wanted = new Set(playlist_ids.map(Number).filter(n => !Number.isNaN(n)));
      if (wanted.size > 0) {
        return list.find(p => wanted.has(Number(p.id)) || (Array.isArray(p.playlist_ids) && p.playlist_ids.some(id => wanted.has(Number(id))))) || null;
      }
    }
    if (name) {
      const sameName = list.filter(p => p.name === name);
      if (sameName.length > 0) {
        return sameName.find(p => p.can_manage) || sameName[0];
      }
    }
    return null;
  };

  const buildPlaylistSelectorJson = (target, fallback = {}) => JSON.stringify({
    playlist_id: target?.id ?? fallback.playlist_id ?? null,
    playlist_ids: target?.playlist_ids ?? fallback.playlist_ids ?? null,
    name: target?.name ?? fallback.name ?? '',
    is_public: target?.is_public ?? fallback.is_public
  });

  // Playlists API
  if (pathname === '/api/playlists' && req.method === 'GET') {
    try {
      const data = await callDbOps(
        'list_playlists',
        String(sessionUser.userId ?? ''),
        sessionUser.isAdmin ? 'true' : 'false'
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Playlist Tracks API (visibility-checked by playlist_id, playlist_ids, or name)
  if (pathname === '/api/playlists/tracks' && req.method === 'GET') {
    const name = reqUrl.searchParams.get('name') || '';
    const playlistIdParam = reqUrl.searchParams.get('playlist_id') || '';
    const playlistIdsRaw = reqUrl.searchParams.get('playlist_ids') || '';
    const playlistIdsParam = playlistIdsRaw
      ? playlistIdsRaw.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n))
      : undefined;
    if (!name && !playlistIdParam && (!playlistIdsParam || playlistIdsParam.length === 0)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '歌单标识不能为空' }));
      return;
    }
    try {
      const target = await resolveSessionPlaylist({ playlist_id: playlistIdParam, playlist_ids: playlistIdsParam, name });
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '歌单不存在或无权查看' }));
        return;
      }
      const selector = buildPlaylistSelectorJson(target, { playlist_id: playlistIdParam, playlist_ids: playlistIdsParam, name });
      const data = await callDbOps('get_playlist_tracks', selector);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Rename Playlist API
  if (pathname === '/api/playlists/rename' && req.method === 'POST') {
    try {
      const { playlist_id, playlist_ids, old_name, new_name } = await readRequestJson(req);
      if (!new_name || !String(new_name).trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '新歌单名称不能为空' }));
        return;
      }
      const target = await resolveSessionPlaylist({ playlist_id, playlist_ids, name: old_name });
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '歌单不存在或无权访问' }));
        return;
      }
      if (!sessionUser.isAdmin && !target.can_manage) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '权限不足：普通用户仅可重命名属于自己的个人专属歌单' }));
        return;
      }
      const selector = buildPlaylistSelectorJson(target, { playlist_id, playlist_ids, name: old_name });
      const result = await callDbOps('rename_playlist', selector, String(new_name).trim());
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Update Playlist Visible Users API
  if (pathname === '/api/playlists/update-users' && req.method === 'POST') {
    if (!sessionUser.isAdmin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '权限不足：仅管理员可以调整歌单的可见成员' }));
      return;
    }
    try {
      const { playlist_id, playlist_ids, name, user_ids } = await readRequestJson(req);
      if ((!name && playlist_id === undefined) || !Array.isArray(user_ids)) {
        throw new Error('缺少歌单标识或用户列表');
      }
      const target = await resolveSessionPlaylist({ playlist_id, playlist_ids, name });
      const selector = buildPlaylistSelectorJson(target, { playlist_id, playlist_ids, name });
      const result = await callDbOps('update_playlist_users', selector, JSON.stringify(user_ids));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Remove Tracks from Playlist API
  if (pathname === '/api/playlists/remove-tracks' && req.method === 'POST') {
    try {
      const { playlist_id, playlist_ids, name, track_ids, remove_physical } = await readRequestJson(req);
      if ((!name && playlist_id === undefined) || !Array.isArray(track_ids) || track_ids.length === 0) {
        throw new Error('缺少歌单标识或曲目列表');
      }
      const target = await resolveSessionPlaylist({ playlist_id, playlist_ids, name });
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '歌单不存在或无权访问' }));
        return;
      }
      if (!sessionUser.isAdmin) {
        if (!target.can_manage) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '权限不足：普通用户仅可编辑属于自己的个人专属歌单' }));
          return;
        }
        if (remove_physical) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '权限不足：普通用户禁止物理删除 NAS 本地音乐文件' }));
          return;
        }
      }
      const selector = buildPlaylistSelectorJson(target, { playlist_id, playlist_ids, name });
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          'python3',
          [DB_OPS_SCRIPT, 'remove_playlist_tracks', selector, '-', (sessionUser.isAdmin && remove_physical) ? 'true' : 'false'],
          { env: buildDbOpsEnv(), stdio: ['pipe', 'pipe', 'pipe'] }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', c => { stdout += c.toString(); });
        child.stderr.on('data', c => { stderr += c.toString(); });
        child.on('error', reject);
        child.on('close', () => {
          try { resolve(JSON.parse(stdout.trim())); }
          catch (err) { reject(new Error(stderr.trim() || '移除歌单曲目失败')); }
        });
        child.stdin.end(JSON.stringify(track_ids));
      });
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Delete Playlist API
  if (pathname === '/api/playlists/delete' && req.method === 'POST') {
    try {
      const { playlist_id, playlist_ids, name, delete_tracks } = await readRequestJson(req);
      const target = await resolveSessionPlaylist({ playlist_id, playlist_ids, name });
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '歌单不存在或无权访问' }));
        return;
      }
      if (!sessionUser.isAdmin) {
        if (!target.can_manage) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '权限不足：普通用户仅可删除自己创建的个人专属歌单' }));
          return;
        }
        if (delete_tracks) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '权限不足：普通用户禁止删除 NAS 本地音乐文件' }));
          return;
        }
      }
      const selector = buildPlaylistSelectorJson(target, { playlist_id, playlist_ids, name });
      const result = await callDbOps('delete_playlist', selector, (sessionUser.isAdmin && delete_tracks) ? 'true' : 'false');
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Search Library Tracks API
  if (pathname === '/api/tracks/search' && req.method === 'GET') {
    const q = reqUrl.searchParams.get('q') || '';
    const page = reqUrl.searchParams.get('page') || '1';
    const limit = reqUrl.searchParams.get('limit') || '50';
    try {
      const data = await callDbOps('search_tracks', q, page, limit);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Delete Single Track API
  if (pathname === '/api/tracks/delete' && req.method === 'POST') {
    if (!sessionUser.isAdmin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '权限不足：普通用户禁止删除曲库歌曲' }));
      return;
    }
    try {
      const { track_id, remove_physical } = await readRequestJson(req);
      const result = await callDbOps('delete_track', String(track_id), remove_physical !== false ? 'true' : 'false');
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Get Duplicate Tracks API
  if (pathname === '/api/tracks/duplicates' && req.method === 'GET') {
    const q = reqUrl.searchParams.get('q') || '';
    try {
      const data = await callDbOps('find_duplicates', q);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Batch Delete Tracks API (stdin payload to avoid E2BIG)
  if (pathname === '/api/tracks/batch-delete' && req.method === 'POST') {
    if (!sessionUser.isAdmin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '权限不足：普通用户禁止批量删除曲库歌曲' }));
      return;
    }
    try {
      const { track_ids, remove_physical } = await readRequestJson(req, 5 * 1024 * 1024);
      if (!Array.isArray(track_ids) || track_ids.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '未提供待删除的曲目 ID 列表' }));
        return;
      }
      const result = await callDbOpsStdin('batch_delete_tracks', track_ids, remove_physical !== false ? 'true' : 'false');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Online Music Search API (Self-Contained + Library Deduplication)
  if (pathname === '/api/search/online' && req.method === 'GET') {
    const q = reqUrl.searchParams.get('q') || reqUrl.searchParams.get('keyword') || '';
    if (!q.trim()) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data: [] }));
      return;
    }

    try {
      const page = Math.max(1, Number(reqUrl.searchParams.get('page') || '1'));
      const pageSize = Math.min(50, Math.max(1, Number(reqUrl.searchParams.get('page_size') || '20')));
      const searchResult = await searchOnlineKugou(q.trim(), page, pageSize);
      const songs = searchResult.results;

      let checkResults = [];
      try {
        checkResults = await callDbOpsStdin('batch_check', songs.map(s => ({ title: s.title, artist: s.artist })));
      } catch (e) {
        console.error('Batch check error:', e.message);
      }

      const merged = songs.map((s, idx) => ({
        ...s,
        exists: checkResults[idx] ? checkResults[idx].exists : false,
        local_path: checkResults[idx] ? checkResults[idx].path : '',
        local_id: checkResults[idx] ? checkResults[idx].id : null
      }));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data: merged, page, page_size: pageSize, total: searchResult.total, has_more: searchResult.total ? page * pageSize < searchResult.total : songs.length === pageSize }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Single Song Download API
  if (pathname === '/api/download/single' && req.method === 'POST') {
    try {
      const { artist, song, album, cover, quality, source, force } = await readRequestJson(req);
      if (!song || !artist) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '缺少歌曲名或歌手名' }));
        return;
      }

      const requestedQuality = String(quality || 'flac').toLowerCase().trim();
      const reqQuality = VALID_QUALITIES.includes(requestedQuality) ? requestedQuality : 'flac';
      const chosenSource = source || getSettings().download_source || 'kw';
      const allowForceOverwrite = Boolean(force && sessionUser.isAdmin);

      if (!allowForceOverwrite) {
        try {
          const existsCheck = await callDbOps('check_song_exists', song, artist);
          if (existsCheck && existsCheck.exists) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              ok: false,
              error: `【${artist} - ${song}】在 NAS 曲库中已存在，无需重复下载`,
              path: existsCheck.path
            }));
            return;
          }
        } catch (checkErr) {
          console.error('Check exists before download error:', checkErr.message);
        }
      }

      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const queue = loadTaskQueue();
      const pendingCount = queue.filter(t => t.status === 'pending').length;

      const newTask = {
        id: taskId,
        type: 'single',
        title: `${artist} - ${song}`,
        artist,
        song,
        album: album || song,
        cover: cover || '',
        quality: reqQuality,
        source: chosenSource,
        target: 'public',
        user: 'all',
        owner_user: sessionUser.username,
        created_at: new Date().toISOString(),
        status: 'pending',
        order: pendingCount + 1,
        total: 1,
        processed_count: 0,
        reused_count: 0,
        downloaded_count: 0,
        failed_count: 0,
        current_track: null
      };
      queue.push(newTask);
      saveTaskQueue(queue, true);
      broadcastTaskQueue();

      executeNextQueueTask();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: activeChildProcess ? '任务已加入队列排队下载' : '单曲下载流水线已成功拉起', task_id: taskId }));
    } catch (err) {
      res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Update Status API (Internal push from playlist_sync, protected by X-Internal-Token)
  if (pathname === '/api/update-status' && req.method === 'POST') {
    if (req.headers['x-internal-token'] !== INTERNAL_API_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden: invalid internal token' }));
      return;
    }
    try {
      const update = await readRequestJson(req, 5 * 1024 * 1024);
      const processed = (update.processed_count !== undefined)
        ? update.processed_count
        : ((update.reused_count || 0) + (update.downloaded_count || 0) + (update.failed_count || 0));

      const mergedTracks = Array.isArray(update.tracks)
        ? update.tracks
        : (Array.isArray(currentTask.tracks) ? currentTask.tracks : []);

      if (update.track_update && typeof update.track_update.index === 'number' && update.track_update.track) {
        const idx = update.track_update.index;
        if (idx >= 0) {
          mergedTracks[idx] = { ...(mergedTracks[idx] || {}), ...update.track_update.track };
        }
      }

      const { track_update: incomingTrackUpdate, ...restUpdate } = update;
      currentTask = {
        ...currentTask,
        ...restUpdate,
        tracks: mergedTracks,
        processed_count: processed,
        updated_at: new Date().toISOString()
      };

      const isTerminal = ['success', 'failed', 'stopped', 'finalizing'].includes(update.status);
      saveCurrentTask(isTerminal);

      const ssePayload = sanitizeTaskForClient(currentTask);
      if (incomingTrackUpdate && !Array.isArray(update.tracks)) {
        delete ssePayload.tracks;
        ssePayload.track_update = incomingTrackUpdate;
      }
      broadcastSSE('status', ssePayload, currentTask.owner_user);

      const queue = loadTaskQueue();
      const qTask = queue.find(t => t.id === currentTask.task_id || (t.status === 'running' && t.type === 'playlist'));
      if (qTask) {
        if (update.status) qTask.status = update.status;
        if (update.total !== undefined) qTask.total = update.total;
        qTask.processed_count = processed;
        if (update.downloaded_count !== undefined) qTask.downloaded_count = update.downloaded_count;
        if (update.reused_count !== undefined) qTask.reused_count = update.reused_count;
        if (update.failed_count !== undefined) qTask.failed_count = update.failed_count;
        if (update.current_track !== undefined) qTask.current_track = update.current_track;
        if (update.end_time) qTask.end_time = update.end_time;
        if (Array.isArray(update.tracks) && update.tracks.length) {
          qTask.tracks = update.tracks;
        } else if (incomingTrackUpdate && typeof incomingTrackUpdate.index === 'number' && incomingTrackUpdate.track) {
          if (!Array.isArray(qTask.tracks)) qTask.tracks = [];
          qTask.tracks[incomingTrackUpdate.index] = {
            ...(qTask.tracks[incomingTrackUpdate.index] || {}),
            ...incomingTrackUpdate.track
          };
        }
        saveTaskQueue(queue, isTerminal);
        broadcastTaskQueue();
      }

      if (update.status === 'success') {
        const adjustedCount = update.adjusted_count || currentTask.adjusted_count || 0;
        const ownerUser = currentTask.owner_user || DEFAULT_USER;
        const historyItem = {
          id: Date.now(),
          type: 'playlist',
          url: update.url || currentTask.url || (qTask ? qTask.url : '') || '',
          playlist_name: update.playlist_name || currentTask.playlist_name,
          platform: update.platform || currentTask.platform,
          target: update.target || currentTask.target,
          user: update.user || currentTask.user,
          owner_user: ownerUser,
          operator: ownerUser,
          total: update.total || currentTask.total,
          reused_count: update.reused_count || currentTask.reused_count,
          downloaded_count: update.downloaded_count || currentTask.downloaded_count,
          failed_count: update.failed_count || currentTask.failed_count,
          adjusted_count: adjustedCount,
          adjusted: adjustedCount > 0,
          has_adjustments: adjustedCount > 0,
          cover: update.cover || currentTask.cover || (currentTask.tracks && currentTask.tracks[0] && (currentTask.tracks[0].cover || currentTask.tracks[0].pic || currentTask.tracks[0].image)) || '',
          start_time: currentTask.start_time,
          end_time: update.end_time || new Date().toISOString(),
          duration: currentTask.start_time ? Math.round((new Date(update.end_time || Date.now()) - new Date(currentTask.start_time)) / 1000) : 0,
          status: 'success',
          tracks: Array.isArray(currentTask.tracks) ? currentTask.tracks.map(t => ({
            title: t.title,
            artist: t.artist,
            status: t.status,
            path: t.path,
            quality: t.quality,
            actual_quality: t.actual_quality,
            source_used: t.source_used,
            adjusted: Boolean(t.adjusted),
            adjustment_note: t.adjustment_note || ''
          })) : []
        };
        let history = [];
        try {
          if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
          history.unshift(historyItem);
          fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 100), null, 2), { encoding: 'utf-8', mode: 0o600 });
        } catch (e) {}
        broadcastSSE('history', historyItem, ownerUser);
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  const canUseMusicAccount = (acc) => {
    if (!acc) return false;
    if (sessionUser.isAdmin) return true;
    return acc.owner_user === sessionUser.username;
  };

  // Parse Playlist API (preview before starting an import)
  if (pathname === '/api/tasks/parse-playlist' && req.method === 'POST') {
    try {
      const { url, account_id } = await readRequestJson(req);
      if (!url || !String(url).trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'url is required' }));
        return;
      }

      const rawUrl = String(url).trim();
      const store = loadMusicAccounts();
      const allAccounts = store.accounts || [];
      const accessibleAccounts = allAccounts.filter(canUseMusicAccount);

      if (rawUrl.startsWith('daily://')) {
        const parts = rawUrl.replace('daily://', '').split('/');
        const prov = parts[0] || 'qq';
        if (account_id) {
          const explicit = allAccounts.find(a => a.id === account_id || a.provider === account_id);
          if (explicit && !canUseMusicAccount(explicit)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '无权访问其他成员绑定的音乐账号' }));
            return;
          }
        }
        const accTarget = (account_id ? accessibleAccounts.find(a => a.id === account_id || a.provider === account_id) : null)
          || (parts[1] ? accessibleAccounts.find(a => a.id === parts[1]) : null)
          || accessibleAccounts.find(a => a.provider === prov && a.owner_user === sessionUser.username && a.connected)
          || (sessionUser.isAdmin ? accessibleAccounts.find(a => a.provider === prov && a.connected) : null);

        if (!accTarget || !accTarget.secret) {
          throw new Error('未找到对应已连接的音乐账号');
        }
        const cookie = decryptSecret(accTarget.secret);
        const result = await runMusicAccountHelper(accTarget.provider, 'daily_recommend', cookie);
        if (!result.connected) throw new Error(result.error || '登录状态已失效，请重新连接');
        let checkResults = [];
        try {
          checkResults = await callDbOpsStdin('batch_check', (result.tracks || []).map(track => ({ title: track.title, artist: track.artist })));
        } catch (e) {
          console.error('Daily recommend batch check error:', e.message);
        }
        const tracks = (result.tracks || []).map((track, index) => ({
          ...track,
          index,
          exists: Boolean(checkResults[index]?.exists),
          local_path: checkResults[index]?.path || ''
        }));
        const preview = {
          platform: accTarget.provider === 'qq' ? 'QQ音乐' : (accTarget.provider === 'netease' ? '网易云音乐' : accTarget.name),
          playlist_name: result.playlist_name || (accTarget.provider === 'qq' ? 'QQ音乐今日推荐' : '网易云今日推荐'),
          cover_url: result.cover_url || '',
          track_count: tracks.length,
          tracks,
          import_url: result.import_url || rawUrl,
          matched_account: {
            id: accTarget.id,
            provider: accTarget.provider,
            name: MUSIC_PROVIDER_META[accTarget.provider]?.name || accTarget.provider,
            owner_user: accTarget.owner_user || '',
            nickname: accTarget.nickname || ''
          }
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: preview }));
        return;
      }

      // 获取可能匹配的 Cookie (严格遵循账号归属隔离)
      let cookieToUse = '';
      let matchedAccount = null;
      if (account_id) {
        const candidate = allAccounts.find(a => a.id === account_id || a.provider === account_id);
        if (candidate && !canUseMusicAccount(candidate)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '无权使用其他成员绑定的音乐账号' }));
          return;
        }
        matchedAccount = candidate || null;
        if (matchedAccount && matchedAccount.secret) {
          cookieToUse = decryptSecret(matchedAccount.secret);
        }
      }
      if (!cookieToUse) {
        const urlStr = rawUrl.toLowerCase();
        const isNetease = urlStr.includes('163.com');
        const isQQ = urlStr.includes('qq.com');
        if (isNetease || isQQ) {
          const targetProv = isNetease ? 'netease' : 'qq';
          matchedAccount = accessibleAccounts.find(a => a.provider === targetProv && a.owner_user === sessionUser.username && a.connected) || null;
          if (!matchedAccount && sessionUser.isAdmin) {
            matchedAccount = accessibleAccounts.find(a => a.provider === targetProv && a.connected) || null;
          }
          if (matchedAccount && matchedAccount.secret) {
            cookieToUse = decryptSecret(matchedAccount.secret);
          }
        }
      }

      const parsed = await runPlaylistParseOnly(rawUrl, cookieToUse);
      let checkResults = [];
      try {
        checkResults = await callDbOpsStdin('batch_check', (parsed.tracks || []).map(track => ({ title: track.title, artist: track.artist })));
      } catch (e) {
        console.error('Playlist preview batch check error:', e.message);
      }
      const tracks = (parsed.tracks || []).map((track, index) => ({
        ...track,
        index,
        exists: Boolean(checkResults[index]?.exists),
        local_path: checkResults[index]?.path || ''
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        data: {
          ...parsed,
          tracks,
          matched_account: matchedAccount ? {
            id: matchedAccount.id,
            provider: matchedAccount.provider,
            name: MUSIC_PROVIDER_META[matchedAccount.provider]?.name || matchedAccount.provider,
            owner_user: matchedAccount.owner_user || '',
            nickname: matchedAccount.nickname || ''
          } : null
        }
      }));
    } catch (e) {
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message || '歌单解析失败' }));
    }
    return;
  }

  // Dynamic Query Track Qualities by Audio Source API
  if (pathname === '/api/tasks/query-source-qualities' && req.method === 'POST') {
    try {
      const { source = 'auto', tracks = [] } = await readRequestJson(req, 5 * 1024 * 1024);
      if (!Array.isArray(tracks) || tracks.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: [] }));
        return;
      }
      const results = await batchProbeTrackQualities(tracks, source);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data: results }));
    } catch (e) {
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message || '查询音源支持品质失败' }));
    }
    return;
  }

  // Start Playlist Task API
  if (pathname === '/api/tasks/start' && req.method === 'POST') {
    try {
      const { url, target = 'public', user = DEFAULT_USER, source = '', playlist_name = '', tracks = [], quality = 'flac', cover_url = '', account_id = '' } = await readRequestJson(req, 5 * 1024 * 1024);
      let provider = '';
      let matchedAccountId = '';
      let targetScope = sessionUser.isAdmin ? (target === 'user' ? 'user' : 'public') : 'user';
      let targetUser = sessionUser.isAdmin
        ? (targetScope === 'public' ? 'all' : (user || sessionUser.username))
        : sessionUser.username;

      if (account_id) {
        const store = loadMusicAccounts();
        const matched = (store.accounts || []).find(a => a.id === account_id || a.provider === account_id);
        if (matched) {
          if (!canUseMusicAccount(matched)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '无权使用其他成员绑定的音乐账号' }));
            return;
          }
          if (matched.secret) {
            provider = matched.provider;
            matchedAccountId = matched.id;
            if (sessionUser.isAdmin && targetScope === 'user' && (!targetUser || targetUser === 'admin' || targetUser === DEFAULT_USER) && matched.owner_user) {
              targetUser = matched.owner_user;
            }
          }
        }
      }
      const result = startPlaylistTask(
        url,
        targetScope,
        targetUser,
        provider,
        '',
        source,
        { playlistName: playlist_name, tracks, quality, coverUrl: cover_url },
        sessionUser.username,
        matchedAccountId
      );
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.ok ? { ok: true, message: result.message, task_id: result.task_id } : { ok: false, error: result.error, message: result.error }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message, message: err.message }));
    }
    return;
  }

  // Task Queue Management APIs
  // 1. GET /api/tasks/queue
  if (pathname === '/api/tasks/queue' && req.method === 'GET') {
    const queue = loadTaskQueue();
    const visible = (sessionUser.isAdmin
      ? queue
      : queue.filter(t => t.owner_user === sessionUser.username)
    ).map(sanitizeTaskForClient);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: visible, isAdmin: sessionUser.isAdmin }));
    return;
  }

  // 2. POST /api/tasks/reorder
  if (pathname === '/api/tasks/reorder' && req.method === 'POST') {
    try {
      const { task_ids } = await readRequestJson(req);
      if (!Array.isArray(task_ids)) throw new Error('task_ids 必须为数组');
      const queue = loadTaskQueue();

      const pendingTasks = queue.filter(t => t.status === 'pending');
      const allowedIds = new Set(
        sessionUser.isAdmin
          ? pendingTasks.map(t => t.id)
          : pendingTasks.filter(t => t.owner_user === sessionUser.username).map(t => t.id)
      );

      const validOrderedIds = task_ids.filter(id => allowedIds.has(id));
      let currentOrder = 1;
      for (const id of validOrderedIds) {
        const item = queue.find(t => t.id === id);
        if (item && item.status === 'pending') {
          item.order = currentOrder++;
        }
      }
      saveTaskQueue(queue, true);
      broadcastTaskQueue();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: '队列顺序已更新' }));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 3. POST /api/tasks/cancel
  if (pathname === '/api/tasks/cancel' && req.method === 'POST') {
    try {
      const { task_id } = await readRequestJson(req);
      if (!task_id) throw new Error('缺少 task_id');
      const queue = loadTaskQueue();
      const target = queue.find(t => t.id === task_id);
      if (!target) throw new Error('未找到指定任务');

      if (!sessionUser.isAdmin && target.owner_user !== sessionUser.username) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '权限不足：仅可取消自己创建的任务' }));
        return;
      }

      let actionMsg = '任务已删除';
      const isRunningLike = target.status === 'running' || target.status === 'downloading' || target.status === 'parsing' || target.status === 'finalizing';
      ephemeralTaskCookies.delete(task_id);
      if (isRunningLike) {
        killActiveChildProcess();
        target.status = 'stopped';
        target.end_time = new Date().toISOString();
        if (currentTask && (currentTask.task_id === task_id || isRunningLike)) {
          currentTask.status = 'stopped';
          currentTask.speed = null;
          currentTask.end_time = target.end_time;
          saveCurrentTask(true);
          broadcastSSE('status', sanitizeTaskForClient(currentTask), currentTask.owner_user);
          broadcastSSE('speed', { speed: '', task_id: currentTask.task_id }, currentTask.owner_user);
        }

        const idx = queue.findIndex(t => t.id === task_id);
        if (idx >= 0) queue.splice(idx, 1);
        saveTaskQueue(queue, true);
        broadcastTaskQueue();
        actionMsg = '已终止并移除运行中的任务';
        setTimeout(executeNextQueueTask, 500);
      } else {
        const idx = queue.findIndex(t => t.id === task_id);
        if (idx >= 0) queue.splice(idx, 1);
        saveTaskQueue(queue, true);
        broadcastTaskQueue();
        actionMsg = target.status === 'pending' ? '排队任务已取消' : '任务记录已删除';
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: actionMsg }));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 4. POST /api/tasks/clear-completed
  if (pathname === '/api/tasks/clear-completed' && req.method === 'POST') {
    try {
      const terminalStatuses = new Set(['success', 'failed', 'stopped']);
      let queue = loadTaskQueue();
      if (sessionUser.isAdmin) {
        queue = queue.filter(t => !terminalStatuses.has(t.status));
      } else {
        queue = queue.filter(t => !terminalStatuses.has(t.status) || t.owner_user !== sessionUser.username);
      }
      saveTaskQueue(queue, true);
      broadcastTaskQueue();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: '已清理已结束任务' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 5. POST /api/tasks/resume - 继续中断/失败的任务（断点续传）
  if (pathname === '/api/tasks/resume' && req.method === 'POST') {
    try {
      const { task_id } = await readRequestJson(req);
      if (!task_id) throw new Error('task_id 不能为空');

      const queue = loadTaskQueue();
      const target = queue.find(t => t.id === task_id);
      if (!target) throw new Error('任务不存在或已被删除');

      if (!sessionUser.isAdmin && target.owner_user !== sessionUser.username) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '无权操作其他用户的任务' }));
        return;
      }

      if (target.status === 'running' || target.status === 'downloading') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, message: '任务正在执行中，无需重复恢复' }));
        return;
      }

      target.status = 'pending';
      target.error = null;
      target.end_time = null;

      const pendingTasks = queue.filter(t => t.status === 'pending' && t.id !== task_id);
      const minPendingOrder = pendingTasks.reduce((min, t) => Math.min(min, t.order ?? 1), 1);
      target.order = Math.max(0, minPendingOrder - 1);

      saveTaskQueue(queue, true);
      broadcastTaskQueue();

      appendLog(`[任务恢复] 任务 《${target.title || target.playlist_name || target.id}》 已恢复排队执行`, target.owner_user || sessionUser.username);

      executeNextQueueTask();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: activeChildProcess ? '任务已恢复排队，就绪后将从中断处继续' : '任务已恢复，正在继续下载' }));
    } catch (e) {
      res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Stop Task API (校验任务归属权限，终止整个进程组并调度后续队列)
  if (pathname === '/api/tasks/stop' && req.method === 'POST') {
    const queue = loadTaskQueue();
    const runningTasks = queue.filter(
      t => t.status === 'running' || t.status === 'downloading' || t.status === 'parsing' || t.status === 'finalizing'
    );
    const activeOwner = currentTask?.owner_user || runningTasks[0]?.owner_user || '';
    if (!sessionUser.isAdmin && activeOwner && activeOwner !== sessionUser.username) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '权限不足：当前正在执行的任务属于其他成员，无权中止' }));
      return;
    }

    killActiveChildProcess();
    let affected = false;
    for (const t of runningTasks) {
      if (sessionUser.isAdmin || t.owner_user === sessionUser.username) {
        t.status = 'stopped';
        t.end_time = new Date().toISOString();
        affected = true;
      }
    }
    if (affected) {
      saveTaskQueue(queue, true);
      broadcastTaskQueue();
    }

    if (currentTask && currentTask.status !== 'idle' && (sessionUser.isAdmin || currentTask.owner_user === sessionUser.username)) {
      currentTask.status = 'stopped';
      currentTask.speed = null;
      currentTask.end_time = new Date().toISOString();
      saveCurrentTask(true);
      broadcastSSE('status', sanitizeTaskForClient(currentTask), currentTask.owner_user);
      broadcastSSE('speed', { speed: '', task_id: currentTask.task_id }, currentTask.owner_user);
    }

    appendLog('用户手动中止了当前任务', activeOwner || sessionUser.username);
    setTimeout(executeNextQueueTask, 500);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: '任务已终止' }));
    return;
  }

  // Logs API (isolated per user for non-admins)
  if (pathname === '/api/logs' && req.method === 'GET') {
    let logs = '';
    if (sessionUser.isAdmin) {
      if (recentLogEntries.length > 0) {
        logs = recentLogEntries.map(e => e.text).join('\n');
      } else {
        try {
          if (fs.existsSync(LOG_FILE)) logs = fs.readFileSync(LOG_FILE, 'utf-8');
        } catch (e) {}
      }
    } else {
      logs = recentLogEntries
        .filter(e => e.owner_user === sessionUser.username)
        .map(e => e.text)
        .join('\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data: logs }));
    return;
  }

  if (pathname === '/api/logs/clear' && req.method === 'POST') {
    if (sessionUser.isAdmin) {
      recentLogEntries.length = 0;
      try {
        fs.writeFileSync(LOG_FILE, '', { encoding: 'utf-8', mode: 0o600 });
      } catch (e) {}
    } else {
      for (let i = recentLogEntries.length - 1; i >= 0; i--) {
        if (recentLogEntries[i].owner_user === sessionUser.username) {
          recentLogEntries.splice(i, 1);
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ==================== 静态资源服务 (生产构建产物 DIST_DIR) ====================
  if (!pathname.startsWith('/api/')) {
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf'
    };

    if (fs.existsSync(DIST_DIR)) {
      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      let resolvedFile = path.resolve(DIST_DIR, relPath);
      if (resolvedFile !== DIST_DIR && !resolvedFile.startsWith(`${DIST_DIR}${path.sep}`)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }
      if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
        const spaFallback = path.resolve(DIST_DIR, 'index.html');
        if (!path.extname(relPath) && fs.existsSync(spaFallback)) {
          resolvedFile = spaFallback;
        }
      }
      if (fs.existsSync(resolvedFile) && fs.statSync(resolvedFile).isFile()) {
        const ext = path.extname(resolvedFile).toLowerCase();
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        fs.createReadStream(resolvedFile).pipe(res);
        return;
      }
    } else if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'TRIM Music Hub API', dev_frontend_port: 5175 }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
  } catch (unhandledErr) {
    console.error('Unhandled HTTP request error:', unhandledErr);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: unhandledErr?.message || 'Internal Server Error' }));
    } else {
      try { res.end(); } catch (e) {}
    }
  }
}

const server = http.createServer(handleHttpRequest);

let gatewayServer = null;
if (GATEWAY_SOCKET) {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_SOCKET), { recursive: true });
    if (fs.existsSync(GATEWAY_SOCKET)) {
      fs.unlinkSync(GATEWAY_SOCKET);
    }
    gatewayServer = http.createServer((req, res) => {
      req.__fromFnGateway = true;
      return handleHttpRequest(req, res);
    });
    gatewayServer.listen(GATEWAY_SOCKET, () => {
      try {
        fs.chmodSync(GATEWAY_SOCKET, 0o666);
      } catch (e) {}
      console.log(`🔌 fnOS Unified Gateway socket ready at ${GATEWAY_SOCKET} (prefix: ${GATEWAY_PREFIX})`);
    });
    const cleanupGatewaySocket = () => {
      try {
        if (fs.existsSync(GATEWAY_SOCKET)) fs.unlinkSync(GATEWAY_SOCKET);
      } catch (e) {}
    };
    process.on('SIGTERM', () => { cleanupGatewaySocket(); process.exit(0); });
    process.on('SIGINT', () => { cleanupGatewaySocket(); process.exit(0); });
  } catch (e) {
    console.error(`Failed to initialize GATEWAY_SOCKET (${GATEWAY_SOCKET}):`, e.message);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`🎵 TRIM Music Hub running at http://${HOST}:${PORT}`);
  console.log(`📁 Music Root: ${MUSIC_DIR}`);
  console.log(`💽 fnOS DB: ${FNOS_DB_PATH}`);

  // 启动清理：若有被意外中断的 running 任务，恢复状态为 stopped，并自动拉起排队中的 pending 任务
  try {
    const queue = loadTaskQueue();
    let changed = false;
    for (const t of queue) {
      if (t.status === 'running' || t.status === 'downloading' || t.status === 'parsing' || t.status === 'finalizing') {
        t.status = 'stopped';
        t.end_time = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      saveTaskQueue(queue, true);
    }
    if (currentTask && currentTask.status !== 'idle' && currentTask.status !== 'success' && currentTask.status !== 'failed' && currentTask.status !== 'stopped') {
      currentTask.status = 'stopped';
      currentTask.end_time = new Date().toISOString();
      saveCurrentTask(true);
    }
    if (queue.some(t => t.status === 'pending')) {
      setTimeout(executeNextQueueTask, 500);
    }
  } catch (e) {
    console.error('Failed to cleanup interrupted tasks on startup:', e.message);
  }

  // 启动每日推荐定时巡检器 (每 30 秒核对一次)
  setInterval(checkScheduledDailySync, 30000);
});
