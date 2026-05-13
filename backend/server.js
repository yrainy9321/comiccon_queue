const path = require('path');
// 无论从哪级目录启动 node，都优先读项目根 .env，其次 backend/.env（后者可覆盖）
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const {
  validateBraceletIdStrictMg27,
  validateBraceletIdCharsOnly
} = require('./lib/braceletId.cjs');
const systemLogger = require('./lib/systemLogger.cjs');

const app = express();
const PORT = process.env.PORT || 3000;
/** 用于启动日志中的「局域网访问」提示；与 frontend/config.js 的 LAN_IPV4 保持一致即可 */
const LAN_IPV4 =
  (process.env.LAN_IPV4 && String(process.env.LAN_IPV4).trim()) || '172.16.102.3';
/** 绑定到所有网卡，便于同局域网其它设备访问（本机仍可用 localhost） */
const LISTEN_HOST =
  process.env.LISTEN_HOST != null && String(process.env.LISTEN_HOST).trim() !== ''
    ? String(process.env.LISTEN_HOST).trim()
    : '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const AVATAR_DIR = path.join(__dirname, 'uploads/avatars');

// 配置 multer 文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, AVATAR_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/** 仅记录 /api 请求，便于排查真机/微信/鉴权（不写前端页面，见 data/system_logs.jsonl） */
app.use((req, res, next) => {
  const url = req.originalUrl || req.url || '';
  if (!url.startsWith('/api')) return next();
  const start = Date.now();
  const rid = crypto.randomBytes(4).toString('hex');
  req._requestLogId = rid;
  res.on('finish', () => {
    try {
      systemLogger.info('http', `${req.method} ${url}`, {
        rid,
        status: res.statusCode,
        ms: Date.now() - start,
        ip:
          (req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
          req.socket?.remoteAddress ||
          '',
        ua: String(req.headers['user-agent'] || '').slice(0, 200)
      });
    } catch (_) {
      /* ignore */
    }
  });
  next();
});

app.use('/admin', express.static(path.join(__dirname, '../admin')));
app.use(express.static(path.join(__dirname, '..')));
app.use('/avatars', express.static(AVATAR_DIR));

/** 真机/浏览器连通性自检（无鉴权）：应返回 ok:true；wechatConfigured 表示 .env 是否已配微信 */
app.get('/api/ping', (req, res) => {
  const aid =
    (process.env.WECHAT_APPID && String(process.env.WECHAT_APPID).trim()) || 'your_appid';
  const sec =
    (process.env.WECHAT_SECRET && String(process.env.WECHAT_SECRET).trim()) || 'your_secret';
  res.json({
    ok: true,
    time: new Date().toISOString(),
    wechatConfigured: aid !== 'your_appid' && sec !== 'your_secret',
    wechatAppId: aid !== 'your_appid' ? aid : null,
    hint:
      '小程序 frontend/project.config.json 的 appid 须与本字段 wechatAppId 完全一致，否则静默登录永远失败'
  });
});

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure avatar directory exists
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

// Helper functions to load and save data
function loadData(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`Error loading ${filename}:`, e);
      return null;
    }
  }
  return null;
}

function saveData(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Error saving ${filename}:`, e);
  }
}

/** 小程序 Authorization: Bearer xxx */
function readBearerToken(req) {
  const raw = req.headers.authorization || '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

/** 后台绑定写 手环编号/号码；员工端 bind-manual 曾只写 braceletCode/queueCode，读取时两处兼容 */
function queueBraceletKey(q) {
  if (!q) return '';
  return q.手环编号 || q.braceletCode || '';
}

function queueNumberRaw(q) {
  if (!q) return '';
  if (q.号码 != null && q.号码 !== '') return q.号码;
  if (q.queueCode != null && q.queueCode !== '') return q.queueCode;
  return '';
}

function queueNumberEq(q, num) {
  return String(queueNumberRaw(q)) === String(num);
}

/** 叫号前：待发放给用户 / 用户已扫码绑定，均视为占用该手环 */
function isQueueBeforeCalled(q) {
  return q && (q.status === 'waiting' || q.status === 'claimed');
}

// Load initial data or use defaults
let users = loadData('users.json') || [{
  id: '1',
  username: 'admin',
  password: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
  role: 'admin',
  permissions: ['admin', 'activity.manage', 'queue.bind', 'queue.call', 'queue.view', 'settings.manage']
}];

let roles = loadData('roles.json') || [{
  _id: '1',
  name: '管理员',
  permissions: ['admin', 'activity.manage', 'queue.bind', 'queue.call', 'queue.view', 'settings.manage']
}, {
  _id: '2',
  name: '工作人员',
  permissions: ['queue.bind', 'queue.view']
}];

let activities = loadData('activities.json') || [];
let queues = loadData('queues.json') || [];

// 加载微信用户数据
let wechatUsers = loadData('wechat_users.json') || {};

// 加载手环与openid的绑定关系 (braceletId -> openid)
let braceletBindings = loadData('bracelet_bindings.json') || {};

/** 后台「制作手环」批量生成的批次记录（含编号列表，用于导出与防重复） */
let braceletMakeBatches = loadData('bracelet_make_batches.json') || [];
if (!Array.isArray(braceletMakeBatches)) {
  console.warn('[bracelet_make_batches] 数据文件不是数组，已重置为空列表');
  braceletMakeBatches = [];
}

/** 以下依赖 activities / queues 已加载 */
function findActivityByFlexibleId(activityId) {
  if (activityId == null || activityId === '') return null;
  const s = String(activityId).trim();
  return (
    activities.find(
      (a) => String(a._id) === s || (a.id != null && String(a.id) === s)
    ) || null
  );
}

function canonicalActivityIdForPersist(activity) {
  if (!activity) return '';
  return String(activity._id != null ? activity._id : activity.id || '');
}

/** 队列里的 activityId 与请求参数可能分别用活动的 _id / id，需视为同一活动 */
function activityIdMatches(qActivityId, requestedId) {
  const a = String(qActivityId || '');
  const b = String(requestedId || '');
  if (a === b) return true;
  const qa = findActivityByFlexibleId(a);
  const qb = findActivityByFlexibleId(b);
  if (qa && qb) return canonicalActivityIdForPersist(qa) === canonicalActivityIdForPersist(qb);
  if (qa) {
    const ca = canonicalActivityIdForPersist(qa);
    return ca === b || (qa.id != null && String(qa.id) === b);
  }
  if (qb) {
    const cb = canonicalActivityIdForPersist(qb);
    return cb === a || (qb.id != null && String(qb.id) === a);
  }
  return false;
}

/** 无 activities 文档时，用已叫号记录的号码推断「当前叫号」进度（与 activity.currentNumber 语义接近） */
function inferCurrentNumberFromQueues(activityIdStr) {
  const called = queues.filter(
    (q) => activityIdMatches(q.activityId, activityIdStr) && q.status === 'called' && q.calledAt
  );
  let maxNum = 0;
  for (const q of called) {
    const n = Number(queueNumberRaw(q));
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  }
  return maxNum;
}

/**
 * 启动时：queues 里出现过的 activityId 若在 activities 中不存在，则自动写入占位活动并持久化。
 * 避免仅存在队列数据时小程序/接口误判「活动不存在」。
 */
function ensureActivitiesReferencedByQueues() {
  const idSet = new Set();
  for (const q of queues) {
    if (q.activityId == null) continue;
    const raw = String(q.activityId).trim();
    if (raw) idSet.add(raw);
  }
  const now = new Date().toISOString();
  let added = false;
  for (const aid of idSet) {
    const exists = activities.some(
      (a) => String(a._id) === aid || (a.id != null && String(a.id) === aid)
    );
    if (exists) continue;
    const inferredCur = inferCurrentNumberFromQueues(aid);
    activities.push({
      _id: aid,
      name: `自动补齐：${aid}`,
      description:
        '队列中存在该活动 ID，但活动表原先无记录，已于服务启动时自动创建；可在后台修改名称、状态或停用。',
      status: 'active',
      currentNumber: inferredCur,
      mode: 'sequential',
      createdBy: 'system-sync',
      createdAt: now,
      updatedBy: 'system-sync',
      updatedAt: now,
      queuePaused: false,
      operationLogs: [
        {
          operator: 'system',
          operation: '自动补齐',
          timestamp: now,
          detail: `根据 queues 中的 activityId「${aid}」创建占位活动`
        }
      ]
    });
    added = true;
  }
  if (added) {
    try {
      saveData('activities.json', activities);
      console.log('[activities] 已根据 queues 自动补齐缺失的活动记录');
    } catch (e) {
      console.error('[activities] 自动补齐写入失败', e);
    }
  }
}

function braceletKeyNormalize(s) {
  return String(s == null ? '' : s).trim();
}

/** bracelet_bindings 的 key 可能与 queue.手环编号在空白等处略不一致，做规范化查找 */
function findBraceletBindingByQueueBraceletKey(bKey) {
  const norm = braceletKeyNormalize(bKey);
  if (!norm) return null;
  const direct = braceletBindings[norm] || braceletBindings[bKey];
  if (direct && direct.openid) return direct;
  for (const k of Object.keys(braceletBindings)) {
    if (braceletKeyNormalize(k) === norm) return braceletBindings[k];
  }
  return null;
}

/**
 * 是否为微信侧真实用户 openid（可发订阅消息）。
 * 小程序 app.js 在登录超时后会写入 temp_ 前缀的假 openid，微信接口会报 40003，必须排除。
 */
function isRealWechatMiniOpenid(oid) {
  const s = String(oid == null ? '' : oid).trim();
  if (!s) return false;
  if (s.startsWith('temp_') || s.startsWith('mock_')) return false;
  if (s.length < 15 || s.length > 64) return false;
  return /^[a-zA-Z0-9_-]+$/.test(s);
}

/**
 * 订阅消息接收者 openid：优先 bracelet_bindings；否则用排队记录上的 openid（/wechat/bind 已写入）。
 */
function resolveCustomerOpenidForQueue(queue) {
  if (!queue) return '';
  const bKey = queueBraceletKey(queue);
  const rec = findBraceletBindingByQueueBraceletKey(bKey);
  if (rec && rec.openid && isRealWechatMiniOpenid(rec.openid)) return String(rec.openid).trim();
  if (queue.openid && isRealWechatMiniOpenid(queue.openid)) return String(queue.openid).trim();
  const uid = queue.userId != null ? String(queue.userId).trim() : '';
  if (uid && isRealWechatMiniOpenid(uid)) return uid;
  return '';
}

/** 该手环是否仍有未叫号入场的排队（待发放给用户或用户已扫码绑定），全局至多一条；叫号或解绑后可再绑 */
function findBlockingQueueByBracelet(braceletKey) {
  const key = braceletKeyNormalize(braceletKey);
  if (!key) return null;
  return (
    queues.find(
      (q) =>
        braceletKeyNormalize(queueBraceletKey(q)) === key && isQueueBeforeCalled(q)
    ) || null
  );
}

/** 同一活动下排号是否已被任意记录占用（含已叫号入场），不可重复使用 */
function hasQueueNumberTakenInActivity(activityId, num) {
  return queues.some(
    (q) => activityIdMatches(q.activityId, activityId) && queueNumberEq(q, num)
  );
}

/**
 * 自动模式：从 currentNumber+1 起找首个未被本活动占用的排号并回写 activity.currentNumber
 * @returns {number|string|null}
 */
function allocateNextFreeQueueNumber(activity, activityId) {
  let n = Number(activity.currentNumber);
  if (Number.isNaN(n)) n = 0;
  let candidate = n + 1;
  for (let i = 0; i < 100000; i++) {
    if (!hasQueueNumberTakenInActivity(activityId, candidate)) {
      activity.currentNumber = candidate;
      return candidate;
    }
    candidate += 1;
  }
  return null;
}

/** 绑定前唯一性校验；通过返回 null，否则返回错误文案（写入前再调一次可防并发窗口） */
function getBindConflict(resolvedActivityId, braceletKey, queueNumber) {
  const block = findBlockingQueueByBracelet(braceletKey);
  if (block) {
    if (activityIdMatches(block.activityId, resolvedActivityId)) {
      return '该手环在本活动仍有未叫号入场的排队（待发放给用户或用户已扫码绑定），请先叫号或解绑后再绑定';
    }
    return '该手环已在其他活动排队中（待发放给用户或用户已扫码绑定），请先在对应活动叫号或解绑后再绑定';
  }
  if (hasQueueNumberTakenInActivity(resolvedActivityId, queueNumber)) {
    return '该活动下此排号已使用（含已叫号入场记录），请更换排号';
  }
  return null;
}

/** 返回给管理后台 / 列表接口时统一手环、排号、活动名称等（不改磁盘上的历史结构也可正确展示） */
function normalizeQueueResponse(q) {
  if (!q) return q;
  const act = findActivityByFlexibleId(q.activityId);
  return {
    ...q,
    手环编号: queueBraceletKey(q),
    号码: queueNumberRaw(q),
    activityName: act ? act.name : ''
  };
}

const BRACELET_BATCH_MAX = 10000;

function userCanManageBraceletBatches(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.permissions) && user.permissions.includes('activity.manage');
}

function collectOccupiedBraceletIdSet() {
  const set = new Set();
  for (const q of queues) {
    const k = braceletKeyNormalize(queueBraceletKey(q));
    if (k) set.add(k);
  }
  for (const batch of braceletMakeBatches) {
    const ids = Array.isArray(batch.braceletIds) ? batch.braceletIds : [];
    for (const id of ids) {
      const k = braceletKeyNormalize(String(id || ''));
      if (k) set.add(k);
    }
  }
  return set;
}

function genMgBraceletId() {
  const buf = crypto.randomBytes(24);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'MG#';
  for (let i = 0; i < 24; i++) {
    s += alphabet[buf[i] % alphabet.length];
  }
  return s;
}

function generateUniqueBraceletIds(want, occupiedSet) {
  const out = [];
  const local = new Set(occupiedSet);
  let guard = 0;
  const maxTry = Math.max(want * 200, 10000);
  while (out.length < want && guard < maxTry) {
    guard += 1;
    const id = genMgBraceletId();
    const k = braceletKeyNormalize(id);
    if (local.has(k)) continue;
    local.add(k);
    out.push(id);
  }
  if (out.length < want) {
    throw new Error('手环去重后无法生成足够数量的唯一编号，请稍后重试');
  }
  return out;
}

function activityEligibleForBindRegisterBatch(activity) {
  if (!activity || activity.status === 'deleted') return false;
  if (activity.status !== 'active') return false;
  if (activity.batchBraceletBindDone === true) return false;
  const aid = canonicalActivityIdForPersist(activity);
  if (!aid) return false;
  const cnt = queues.filter((q) => activityIdMatches(q.activityId, aid)).length;
  if (cnt > 0) return false;
  const used = braceletMakeBatches.some(
    (b) =>
      b &&
      b.kind === 'bind_register' &&
      activityIdMatches(String(b.activityId || ''), aid)
  );
  return !used;
}

let currentUser = null;

// 微信消息推送配置
const WECHAT_APPID = process.env.WECHAT_APPID || 'your_appid';
const WECHAT_SECRET = process.env.WECHAT_SECRET || 'your_secret';
/** 订阅消息下发：与当前用户打开的小程序版本一致。体验版/开发版预览须设为 trial / developer，否则收不到 */
const WECHAT_SUBSCRIBE_MINIPROGRAM_STATE_RAW = String(
  process.env.WECHAT_MINIPROGRAM_STATE || 'formal'
).trim();
const WECHAT_SUBSCRIBE_MINIPROGRAM_STATE = ['developer', 'trial', 'formal'].includes(
  WECHAT_SUBSCRIBE_MINIPROGRAM_STATE_RAW
)
  ? WECHAT_SUBSCRIBE_MINIPROGRAM_STATE_RAW
  : 'formal';
const TEMPLATE_IDS = {
  REMINDER_5: process.env.WECHAT_TEMPLATE_REMINDER_5 || 'Ahead5ReminderTemplateId', // 还有5位提醒
  /** 排队到号通知（一次性订阅） */
  CALLED:
    process.env.WECHAT_TEMPLATE_CALLED || 'k-yabn5Ze0mYwfviBKmPDztWx6BqQynM-oGuzlyPQGY',
  MISSED: process.env.WECHAT_TEMPLATE_MISSED || 'MissedTemplateId', // 过号通知
  /** 排队叫号提醒：模板字段待定，绑定页已请求订阅，发送逻辑待补齐 */
  QUEUE_REMINDER:
    process.env.WECHAT_TEMPLATE_QUEUE_REMINDER || '5C3ru9yrICuvAAR3Evtnqn5OFD-cE7RaD9JeXUmZYK8'
};

function maskOpenid(oid) {
  const s = String(oid || '');
  if (s.length <= 10) return s ? `${s.slice(0, 2)}…` : '';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function logSubscribeConfigOnBoot() {
  const appid = String(WECHAT_APPID || '').trim();
  const appidOk = appid && appid !== 'your_appid';
  console.log('[订阅消息] 启动配置 — miniprogram_state=%s（体验版/预览请用 trial；正式上架用 formal）', WECHAT_SUBSCRIBE_MINIPROGRAM_STATE);
  console.log(
    '[订阅消息] WECHAT_APPID=%s %s',
    appidOk ? `${appid.slice(0, 6)}…` : appid || '(未设置)',
    appidOk ? '' : '← 未配置则无法换 access_token，发消息必失败'
  );
  console.log('[订阅消息] 模板 CALLED=%s…', String(TEMPLATE_IDS.CALLED || '').slice(0, 12));
  console.log('[订阅消息] 模板 QUEUE_REMINDER=%s…', String(TEMPLATE_IDS.QUEUE_REMINDER || '').slice(0, 12));

  try {
    const pj = path.join(__dirname, '../frontend/project.config.json');
    if (fs.existsSync(pj)) {
      const pm = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const mini = String(pm.appid || '').trim();
      if (mini && appidOk && mini !== appid) {
        console.error(
          '[微信] 致命配置：小程序 project.config.json 的 appid（%s）与 .env WECHAT_APPID（%s）不一致 → jscode2session 必失败，后台不会出现微信用户。',
          mini,
          appid
        );
        systemLogger.warn('boot', 'wechat_appid_mismatch', { miniAppId: mini, envAppId: appid });
      } else if (mini && appidOk) {
        console.log('[微信] 小程序工程 appid 与后端 WECHAT_APPID 一致（%s）', mini);
      }
    }
  } catch (e) {
    console.warn('[微信] 读取 frontend/project.config.json 失败:', e.message);
  }
}

logSubscribeConfigOnBoot();

// 缓存access_token
let accessTokenCache = {
  token: null,
  expiresAt: 0
};

// 获取微信access_token
async function getAccessToken() {
  const now = Date.now();
  
  // 如果token未过期，直接返回
  if (accessTokenCache.token && accessTokenCache.expiresAt > now) {
    return accessTokenCache.token;
  }
  
  try {
    const response = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: {
        grant_type: 'client_credential',
        appid: WECHAT_APPID,
        secret: WECHAT_SECRET
      }
    });
    
    const { access_token, expires_in } = response.data;
    
    if (!access_token) {
      throw new Error(`获取access_token失败: ${JSON.stringify(response.data)}`);
    }
    
    // 缓存token，提前5分钟刷新
    accessTokenCache = {
      token: access_token,
      expiresAt: now + (expires_in - 300) * 1000
    };
    
    console.log('获取到新的access_token');
    return access_token;
  } catch (error) {
    console.error('获取access_token失败:', error.message);
    throw error;
  }
}

/** 订阅消息卡片点击后打开的小程序页面（须在 app.json 注册） */
const SUBSCRIBE_MESSAGE_LANDING_PAGE = 'pages/my-bindings/index';

/** 小程序上报的各模板授权状态（accept / reject / ban），用于下发前跳过明确拒绝 */
function subscribeTemplateStatusForUser(openid, templateId) {
  const u = wechatUsers[String(openid || '')];
  if (!u || !u.subscribeTemplates || typeof u.subscribeTemplates !== 'object') return null;
  const s = u.subscribeTemplates[String(templateId)];
  return s ? String(s) : null;
}

// 发送订阅消息
async function sendSubscribeMessage(openid, templateId, data, page = SUBSCRIBE_MESSAGE_LANDING_PAGE) {
  const payload = {
    touser: openid,
    template_id: templateId,
    page: page,
    data: data,
    miniprogram_state: WECHAT_SUBSCRIBE_MINIPROGRAM_STATE,
    lang: 'zh_CN'
  };
  try {
    if (!isRealWechatMiniOpenid(openid)) {
      console.error(
        '[订阅消息] 跳过发送：openid 非微信真实用户（常见原因：小程序登录超时使用了 temp_ 临时身份）。raw=%s',
        String(openid || '').slice(0, 32)
      );
      return false;
    }

    const st = subscribeTemplateStatusForUser(openid, templateId);
    if (st === 'reject' || st === 'ban') {
      console.warn(
        '[订阅消息] 按用户授权状态跳过发送 openid=%s template=%s status=%s',
        maskOpenid(openid),
        templateId,
        st
      );
      return false;
    }

    console.log(
      '[订阅消息] 请求发送 → openid=%s template=%s state=%s page=%s',
      maskOpenid(openid),
      templateId,
      WECHAT_SUBSCRIBE_MINIPROGRAM_STATE,
      page
    );

    const accessToken = await getAccessToken();

    const response = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
      payload
    );

    if (response.data.errcode === 0) {
      console.log('[订阅消息] 发送成功 openid=%s template=%s', maskOpenid(openid), templateId);
      return true;
    }
    const err = response.data.errcode;
    const msg = response.data.errmsg || '';
    if (err === 43101) {
      console.error(
        '[订阅消息] 失败 43101（用户未授权该模板或一次性次数已用完）openid=%s template=%s',
        maskOpenid(openid),
        templateId
      );
    } else if (err === 47003) {
      console.error('[订阅消息] 失败 47003（模板字段/长度/格式）errmsg=%s data=%s', msg, JSON.stringify(data));
    } else {
      console.error('[订阅消息] 失败 errcode=%s errmsg=%s 完整响应=%s', err, msg, JSON.stringify(response.data));
    }
    return false;
  } catch (error) {
    console.error('[订阅消息] 请求异常 openid=%s template=%s err=%s', maskOpenid(openid), templateId, error.message);
    return false;
  }
}

// 发送排队提醒消息（还有5位）
// 模板字段: thing1(当前叫号), thing2(您的排号), thing3(前方等候人数), thing4(备注)
async function sendAhead5Reminder(openid, currentNumber, userNumber, aheadCount) {
  const data = {
    thing1: { value: String(currentNumber) }, // 当前叫号
    thing2: { value: String(userNumber) }, // 您的排号
    thing3: { value: String(aheadCount) }, // 前方等候人数
    thing4: { value: '请做好准备，即将到您' } // 备注
  };
  
  return await sendSubscribeMessage(openid, TEMPLATE_IDS.REMINDER_5, data);
}

function formatWeChatSubscribeTime(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) {
    return new Date().toLocaleString('zh-CN', { hour12: false });
  }
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const day = String(t.getDate()).padStart(2, '0');
  const h = String(t.getHours()).padStart(2, '0');
  const min = String(t.getMinutes()).padStart(2, '0');
  return `${y}年${m}月${day}日 ${h}:${min}`;
}

// 发送排队到号通知（模板：排队到号通知）
// 字段: character_string1、thing10、time6、character_string2（业务上均按产品要求填排号与叫号时间等）
async function sendCalledNotification(openid, userQueueNumber, calledAt) {
  const data = {
    character_string1: { value: String(userQueueNumber) },
    thing10: { value: '请尽快前往活动入口参加' },
    time6: { value: formatWeChatSubscribeTime(calledAt) },
    character_string2: { value: String(userQueueNumber) }
  };

  return await sendSubscribeMessage(openid, TEMPLATE_IDS.CALLED, data, SUBSCRIBE_MESSAGE_LANDING_PAGE);
}

// 发送过号通知
// 模板字段: character_string2(您的排号), phrase3(排队状态), time4(过号时间), thing5(备注说明)
async function sendMissedNotification(openid, userNumber) {
  const data = {
    character_string2: { value: String(userNumber) }, // 您的排号
    phrase3: { value: '已过号' }, // 排队状态
    time4: { value: new Date().toLocaleString('zh-CN') }, // 过号时间
    thing5: { value: '请联系工作人员重新安排' } // 备注说明
  };
  
  return await sendSubscribeMessage(openid, TEMPLATE_IDS.MISSED, data);
}

// 排队叫号提醒（前方第 3 人被叫号时）：thing1~thing4
async function sendQueueCallReminder(openid, currentCallNumber, userNumber, aheadCount) {
  const data = {
    thing1: { value: String(currentCallNumber) },
    thing2: { value: String(userNumber) },
    thing3: { value: String(aheadCount) },
    thing4: { value: '请尽快前往活动入口等候' }
  };
  return await sendSubscribeMessage(openid, TEMPLATE_IDS.QUEUE_REMINDER, data, SUBSCRIBE_MESSAGE_LANDING_PAGE);
}

/**
 * 叫号前 waiting 已排序；当被叫号者等于某用户「从本人往前数第 3 位」时发排队叫号提醒。
 * 例：顺序为 7,8,9,10 时叫 7 → 提醒 10 号；thing3 为叫号后该用户前方人数（与 my-queue-ahead 一致）。
 */
async function checkAndSendThirdAheadLineReminder(activity, calledQueue, waitingBefore) {
  const actKey = canonicalActivityIdForPersist(activity) || calledQueue.activityId;
  const calledId = String(calledQueue._id || calledQueue.id || '');
  const calledNumStr = String(queueNumberRaw(calledQueue));

  for (let j = 3; j < waitingBefore.length; j++) {
    const thirdAhead = waitingBefore[j - 3];
    if (String(thirdAhead._id || thirdAhead.id || '') !== calledId) continue;

    const recipient = waitingBefore[j];
    const openid = resolveCustomerOpenidForQueue(recipient);
    if (!openid) continue;
    if (!queueMatchesUserAsCustomer(recipient, openid)) continue;

    const aheadRes = getAheadCountForCustomerQueue(actKey, queueNumberRaw(recipient), openid);
    const aheadNow = aheadRes.inWaitingQueue && aheadRes.aheadCount != null ? aheadRes.aheadCount : 0;

    const ok = await sendQueueCallReminder(openid, calledNumStr, queueNumberRaw(recipient), aheadNow);
    if (ok) {
      console.log(
        `已发排队叫号提醒: 被叫=${calledNumStr}, 提醒用户排号=${queueNumberRaw(recipient)}, 前方=${aheadNow}`
      );
    }
  }
}

// 检查并发送提前5位提醒
async function checkAndSendAhead5Reminder(activityId, currentNumber) {
  try {
    const targetNumber = currentNumber + 5;
    
    // 查找目标用户的排队记录
    const targetQueue = queues.find(
      (q) =>
        activityIdMatches(q.activityId, activityId) &&
        queueNumberEq(q, targetNumber) &&
        isQueueBeforeCalled(q) &&
        !q.reminderSent
    );

    if (targetQueue) {
      const openid = resolveCustomerOpenidForQueue(targetQueue);

      if (openid) {
        const success = await sendAhead5Reminder(
          openid,
          currentNumber,
          queueNumberRaw(targetQueue),
          5
        );

        if (success) {
          targetQueue.reminderSent = true;
          saveData('queues.json', queues);
          console.log(`已发送提前5位提醒: 手环=${bKey}, 号码=${queueNumberRaw(targetQueue)}`);
        }
      }
    }
  } catch (error) {
    console.error('发送提前5位提醒失败:', error);
  }
}

// Generate activity ID with pattern: ACT{YYYYMMDD}{SEQ}
function generateActivityId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;
  
  // Count activities created today
  const todayActivities = activities.filter(a => {
    if (!a.createdAt) return false;
    const createdDate = new Date(a.createdAt);
    const createdYear = createdDate.getFullYear();
    const createdMonth = String(createdDate.getMonth() + 1).padStart(2, '0');
    const createdDay = String(createdDate.getDate()).padStart(2, '0');
    return `${createdYear}${createdMonth}${createdDay}` === dateStr;
  });
  
  const seq = String(todayActivities.length + 1).padStart(3, '0');
  return `ACT${dateStr}${seq}`;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  console.log('登录尝试:', username);

  const user = users.find(u => u.username === username && u.password === hashPassword(password));

  if (!user) {
    systemLogger.warn('auth/login', 'failed', {
      username: username != null ? String(username).slice(0, 64) : '',
      ip: req.socket?.remoteAddress || ''
    });
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  user.token = token;
  currentUser = user;

  systemLogger.info('auth/login', 'ok', { username: user.username, role: user.role });

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, permissions: user.permissions }
  });
});

function validateToken(token) {
  return users.find(user => user.token === token);
}

/** 管理员拉取系统日志（仅 JSON，不在管理后台做页面；可用浏览器控制台或 curl） */
app.get('/api/admin/system-logs', (req, res) => {
  const raw = req.headers.authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可查看系统日志' });
  }
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '200'), 10) || 200));
  const items = systemLogger.readRecent(limit);
  res.json({
    success: true,
    limit,
    count: items.length,
    file: 'backend/data/system_logs.jsonl',
    items
  });
});

/** 制作手环：可选「制作并登记」的活动下拉（须注册在 /bracelet-batches/:id 之前） */
app.get('/api/admin/bracelet-batches/eligible-bind-activities', (req, res) => {
  const raw = req.headers.authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  const user = validateToken(token);
  if (!user) return res.status(401).json({ error: '未授权' });
  if (!userCanManageBraceletBatches(user)) {
    return res.status(403).json({ error: '无权访问制作手环功能' });
  }
  const out = [];
  for (const a of activities) {
    if (!a || a.status === 'deleted') continue;
    if (a.status !== 'active') continue;
    if (a.batchBraceletBindDone === true) continue;
    const aid = canonicalActivityIdForPersist(a);
    if (!aid) continue;
    const cnt = queues.filter((q) => activityIdMatches(q.activityId, aid)).length;
    if (cnt > 0) continue;
    const used = braceletMakeBatches.some(
      (b) =>
        b && b.kind === 'bind_register' && activityIdMatches(String(b.activityId || ''), aid)
    );
    if (used) continue;
    out.push({ _id: a._id, name: a.name || aid });
  }
  res.json({ success: true, data: out });
});

/** 制作并登记：生成手环 + 排队记录（每活动仅一次） */
app.post('/api/admin/bracelet-batches/bind-register', (req, res) => {
  const raw = req.headers.authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  const user = validateToken(token);
  if (!user) return res.status(401).json({ error: '未授权' });
  if (!userCanManageBraceletBatches(user)) {
    return res.status(403).json({ error: '无权访问制作手环功能' });
  }
  const activityIdIn = String((req.body && req.body.activityId) || '').trim();
  const n = parseInt(String((req.body && req.body.count) != null ? req.body.count : '0'), 10);
  if (!activityIdIn) return res.status(400).json({ error: '请选择活动' });
  if (!Number.isFinite(n) || n < 1 || n > BRACELET_BATCH_MAX) {
    return res.status(400).json({ error: `数量须在 1～${BRACELET_BATCH_MAX}` });
  }
  const activity = findActivityByFlexibleId(activityIdIn);
  if (!activity) return res.status(404).json({ error: '活动不存在' });
  if (!activityEligibleForBindRegisterBatch(activity)) {
    return res
      .status(400)
      .json({ error: '该活动不符合「制作并登记」条件（须已启用、无登记、且未使用过本功能）' });
  }
  const aid = canonicalActivityIdForPersist(activity);
  try {
    const occupied = collectOccupiedBraceletIdSet();
    const ids = generateUniqueBraceletIds(n, occupied);
    const batchId = Date.now().toString();
    const queueNums = [];
    for (let i = 0; i < n; i++) {
      const numStr = String(i + 1);
      queueNums.push(numStr);
      const q = {
        _id: `${batchId}-${i}`,
        activityId: aid,
        手环编号: ids[i],
        号码: numStr,
        status: 'waiting',
        boundBy: user.username || 'admin',
        batchBindLocked: true,
        createdAt: new Date()
      };
      queues.push(q);
    }
    activity.batchBraceletBindDone = true;
    activity.currentNumber = Math.max(Number(activity.currentNumber) || 0, n);
    activity.updatedBy = user.username;
    activity.updatedAt = new Date();
    const batch = {
      _id: batchId,
      kind: 'bind_register',
      label: '制作并登记',
      count: n,
      createdAt: new Date(),
      createdBy: user.username || '',
      activityId: aid,
      activityName: activity.name || '',
      braceletIds: ids,
      queueNumbers: queueNums
    };
    braceletMakeBatches.push(batch);
    saveData('queues.json', queues);
    saveData('activities.json', activities);
    saveData('bracelet_make_batches.json', braceletMakeBatches);
    res.json({ success: true, count: n, batchId });
  } catch (e) {
    console.error('[POST /api/admin/bracelet-batches/bind-register]', e);
    res.status(500).json({ error: e.message || '生成失败' });
  }
});

app.post('/api/admin/bracelet-batches', (req, res) => {
  const raw = req.headers.authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  const user = validateToken(token);
  if (!user) return res.status(401).json({ error: '未授权' });
  if (!userCanManageBraceletBatches(user)) {
    return res.status(403).json({ error: '无权访问制作手环功能' });
  }
  const kind = (req.body && req.body.kind) || 'normal';
  const n = parseInt(String((req.body && req.body.count) != null ? req.body.count : '0'), 10);
  if (!Number.isFinite(n) || n < 1 || n > BRACELET_BATCH_MAX) {
    return res.status(400).json({ error: `数量须在 1～${BRACELET_BATCH_MAX}` });
  }
  try {
    const occupied = collectOccupiedBraceletIdSet();
    const ids = generateUniqueBraceletIds(n, occupied);
    const batch = {
      _id: Date.now().toString(),
      kind: kind === 'bind_register' ? 'bind_register' : 'normal',
      label:
        kind === 'bind_register'
          ? '制作并登记'
          : kind === 'normal'
            ? '普通手环'
            : '手环',
      count: ids.length,
      createdAt: new Date(),
      createdBy: user.username || '',
      braceletIds: ids
    };
    braceletMakeBatches.push(batch);
    saveData('bracelet_make_batches.json', braceletMakeBatches);
    res.json({ success: true, count: ids.length, _id: batch._id });
  } catch (e) {
    console.error('[POST /api/admin/bracelet-batches]', e);
    res.status(500).json({ error: e.message || '生成失败' });
  }
});

app.get('/api/admin/bracelet-batches/:id', (req, res) => {
  const raw = req.headers.authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  const user = validateToken(token);
  if (!user) return res.status(401).json({ error: '未授权' });
  if (!userCanManageBraceletBatches(user)) {
    return res.status(403).json({ error: '无权访问制作手环功能' });
  }
  const id = String(req.params.id || '');
  const b = braceletMakeBatches.find((x) => String(x._id) === id);
  if (!b) return res.status(404).json({ error: '批次不存在' });
  res.json({
    _id: b._id,
    kind: b.kind,
    braceletIds: Array.isArray(b.braceletIds) ? b.braceletIds : [],
    queueNumbers: Array.isArray(b.queueNumbers) ? b.queueNumbers : []
  });
});

/** 制作手环：批次列表（分页、排序） */
app.get('/api/admin/bracelet-batches', (req, res) => {
  const raw = req.headers.authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  const user = validateToken(token);
  if (!user) return res.status(401).json({ error: '未授权' });
  if (!userCanManageBraceletBatches(user)) {
    return res.status(403).json({ error: '无权访问制作手环功能' });
  }
  const skB = String(req.query.sortBy || 'createdAt').trim();
  const soB = String(req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const allowB = new Set(['createdAt', 'count', 'activityName', 'createdBy', '_id']);
  const keyB = allowB.has(skB) ? skB : 'createdAt';
  const list = [...(Array.isArray(braceletMakeBatches) ? braceletMakeBatches : [])].sort((a, b) => {
    let cmp = 0;
    if (keyB === 'createdAt') {
      cmp = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    } else if (keyB === 'count') {
      const ca = a.count != null ? a.count : Array.isArray(a.braceletIds) ? a.braceletIds.length : 0;
      const cb = b.count != null ? b.count : Array.isArray(b.braceletIds) ? b.braceletIds.length : 0;
      cmp = Number(ca) - Number(cb);
    } else if (keyB === 'activityName' || keyB === 'createdBy') {
      cmp = String(a[keyB] || '').localeCompare(String(b[keyB] || ''), 'zh-CN');
    } else if (keyB === '_id') {
      cmp = String(a._id || '').localeCompare(String(b._id || ''));
    }
    if (cmp === 0) cmp = String(a._id || '').localeCompare(String(b._id || ''));
    return cmp * soB;
  });
  const total = list.length;
  let pageNum = parseInt(String(req.query.page || '1'), 10);
  let pageSizeNum = parseInt(String(req.query.pageSize || '10'), 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) pageNum = 1;
  if (!Number.isFinite(pageSizeNum) || pageSizeNum < 1) pageSizeNum = 10;
  pageSizeNum = Math.min(100, pageSizeNum);
  const totalPages = Math.max(1, Math.ceil(total / pageSizeNum));
  if (pageNum > totalPages) pageNum = totalPages;
  const start = (pageNum - 1) * pageSizeNum;
  const slice = list.slice(start, start + pageSizeNum);
  res.json({
    data: slice.map((b) => ({
      _id: b._id,
      kind: b.kind || 'normal',
      label:
        b.label ||
        (b.kind === 'bind_register' ? '制作并登记' : b.kind === 'normal' ? '普通手环' : '手环'),
      count:
        b.count != null ? b.count : Array.isArray(b.braceletIds) ? b.braceletIds.length : 0,
      createdAt: b.createdAt,
      createdBy: b.createdBy || '',
      activityId: b.activityId || '',
      activityName: b.activityName || ''
    })),
    total,
    page: pageNum,
    pageSize: pageSizeNum,
    totalPages
  });
});

app.get('/api/auth/current', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  res.json({ user: { id: user.id, username: user.username, role: user.role, permissions: user.permissions } });
});

app.get('/api/activities', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  
  // 统一过滤掉已删除的活动，已删除的活动通过专门的接口获取
  let filteredActivities = activities.filter(a => a.status !== 'deleted');
  
  const { id, name, status, createdBy, startTime, endTime, page = 1, pageSize = 10 } = req.query;
  
  if (id) {
    filteredActivities = filteredActivities.filter(a => a._id.includes(id));
  }
  
  if (name) {
    filteredActivities = filteredActivities.filter(a => a.name.toLowerCase().includes(name.toLowerCase()));
  }
  
  if (status) {
    filteredActivities = filteredActivities.filter(a => a.status === status);
  }
  
  if (createdBy) {
    filteredActivities = filteredActivities.filter(a => a.createdBy && a.createdBy.includes(createdBy));
  }
  
  if (startTime) {
    const start = new Date(startTime);
    filteredActivities = filteredActivities.filter(a => a.createdAt && new Date(a.createdAt) >= start);
  }
  
  if (endTime) {
    const end = new Date(endTime);
    filteredActivities = filteredActivities.filter(a => a.createdAt && new Date(a.createdAt) <= end);
  }
  
  // 按创建时间降序排序（最新创建的在前面）
  filteredActivities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  const total = filteredActivities.length;
  const pageNum = parseInt(page);
  const pageSizeNum = parseInt(pageSize);
  const startIndex = (pageNum - 1) * pageSizeNum;
  const endIndex = startIndex + pageSizeNum;
  const paginatedActivities = filteredActivities.slice(startIndex, endIndex);
  
  res.json({
    data: paginatedActivities.map(a => ({
      _id: a._id,
      name: a.name,
      description: a.description || '',
      status: a.status,
      currentNumber: a.currentNumber,
      queuePaused: a.queuePaused || false,
      createdBy: a.createdBy || '',
      createdAt: a.createdAt || '',
      updatedBy: a.updatedBy || '',
      updatedAt: a.updatedAt || '',
      operationLogs: a.operationLogs || []
    })),
    total,
    page: pageNum,
    pageSize: pageSizeNum,
    totalPages: Math.ceil(total / pageSizeNum)
  });
});

app.post('/api/activities', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const activityId = generateActivityId();
  const activity = { 
    _id: activityId, 
    name: req.body.name, 
    description: req.body.description || '', 
    status: 'inactive', 
    currentNumber: 0, 
    mode: req.body.mode || 'sequential', 
    createdBy: user.username, 
    createdAt: new Date(),
    updatedBy: user.username,
    updatedAt: new Date(),
    operationLogs: [{
      operator: user.username,
      operation: '创建活动',
      timestamp: new Date(),
      detail: `创建活动: ${req.body.name}`
    }]
  };
  activities.push(activity);
  saveData('activities.json', activities);
  res.json(activity);
});

app.delete('/api/activities/:id', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ error: '只有管理员才能删除活动' });
  }
  const activity = activities.find(a => a._id === req.params.id);
  if (!activity) return res.status(404).json({ error: '活动不存在' });
  activity.status = 'deleted';
  activity.updatedBy = user.username;
  activity.updatedAt = new Date();
  if (!activity.operationLogs) activity.operationLogs = [];
  activity.operationLogs.push({
    operator: user.username,
    operation: '删除活动',
    timestamp: new Date(),
    detail: `删除活动: ${activity.name}`
  });
  saveData('activities.json', activities);
  res.json({ success: true });
});

// 获取已删除的活动（仅管理员可见）
app.get('/api/activities/deleted', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  
  if (!user || user.role !== 'admin') {
    return res.status(401).json({ error: '未授权' });
  }
  
  const { page = 1, pageSize = 10 } = req.query;
  
  let deletedActivities = activities.filter(a => a.status === 'deleted');
  
  // 按创建时间降序排序
  deletedActivities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  const total = deletedActivities.length;
  const pageNum = parseInt(page);
  const pageSizeNum = parseInt(pageSize);
  const startIndex = (pageNum - 1) * pageSizeNum;
  const endIndex = startIndex + pageSizeNum;
  const paginatedActivities = deletedActivities.slice(startIndex, endIndex);
  
  res.json({
    total,
    data: paginatedActivities.map(a => ({
      _id: a._id,
      name: a.name,
      description: a.description || '',
      status: a.status,
      createdBy: a.createdBy || '',
      createdAt: a.createdAt,
      updatedBy: a.updatedBy || '',
      updatedAt: a.updatedAt,
      operationLogs: a.operationLogs || []
    }))
  });
});

app.get('/api/activities/:id', (req, res) => {
  const activity = activities.find(a => a._id === req.params.id);
  if (!activity) return res.status(404).json({ error: '活动不存在' });
  res.json({
    _id: activity._id,
    name: activity.name,
    description: activity.description || '',
    status: activity.status,
    currentNumber: activity.currentNumber,
    createdBy: activity.createdBy || '',
    createdAt: activity.createdAt,
    updatedBy: activity.updatedBy || '',
    updatedAt: activity.updatedAt,
    operationLogs: activity.operationLogs || []
  });
});

app.put('/api/activities/:id/queue-pause', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  
  const activity = findActivityByFlexibleId(req.params.id);
  if (!activity) return res.status(404).json({ error: '活动不存在' });
  
  const { paused } = req.body;
  
  activity.queuePaused = paused;
  activity.updatedBy = user.username;
  activity.updatedAt = new Date();
  
  if (!activity.operationLogs) {
    activity.operationLogs = [];
  }
  
  activity.operationLogs.push({
    operator: user.username,
    operation: paused ? '暂停排队' : '继续排队',
    timestamp: new Date(),
    detail: paused ? '暂停活动排队' : '恢复活动排队'
  });
  
  saveData('activities.json', activities);
  res.json({ success: true, queuePaused: paused });
});

app.put('/api/activities/:id/status', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const { status } = req.body;
  if (!status || !['active', 'inactive', 'pending'].includes(status)) {
    return res.status(400).json({ error: '无效的状态' });
  }
  const activity = activities.find(a => a._id === req.params.id);
  if (!activity) return res.status(404).json({ error: '活动不存在' });
  
  const statusNames = { active: '启用', inactive: '禁用', pending: '待审核', deleted: '已删除' };
  const prevStatus = activity.status;
  
  activity.status = status;
  activity.updatedBy = user.username;
  activity.updatedAt = new Date();
  
  if (!activity.operationLogs) {
    activity.operationLogs = [];
  }
  
  // 判断是恢复操作还是普通状态变更
  if (prevStatus === 'deleted') {
    activity.operationLogs.push({
      operator: user.username,
      operation: '恢复活动',
      timestamp: new Date(),
      detail: `从回收站恢复活动: ${activity.name}`
    });
  } else {
    activity.operationLogs.push({
      operator: user.username,
      operation: '状态变更',
      timestamp: new Date(),
      detail: `状态从 "${statusNames[prevStatus] || prevStatus}" 变更为 "${statusNames[status] || status}"`
    });
  }
  
  saveData('activities.json', activities);
  res.json({ success: true, activity });
});

app.get('/api/queues/:activityId', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  res.json(
    queues
      .filter((q) => activityIdMatches(q.activityId, req.params.activityId))
      .map(normalizeQueueResponse)
  );
});

app.get('/api/queues', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  
  const { activityId, status, page = 1, pageSize = 10, bracelet, number, sortBy, sortOrder = 'asc' } = req.query;
  let filteredQueues = queues;
  
  if (activityId) {
    filteredQueues = filteredQueues.filter(q => activityIdMatches(q.activityId, activityId));
  }
  
  if (status) {
    filteredQueues = filteredQueues.filter(q => q.status === status);
  }
  
  if (bracelet) {
    filteredQueues = filteredQueues.filter(q => 
      (q['手环编号'] || '').toLowerCase().includes(bracelet.toLowerCase())
    );
  }
  
  if (number) {
    filteredQueues = filteredQueues.filter(q => 
      String(q.number || '').includes(number)
    );
  }
  
  // 支持自定义排序
  if (sortBy) {
    const order = sortOrder === 'desc' ? -1 : 1;
    filteredQueues.sort((a, b) => {
      const valA = a[sortBy] || 0;
      const valB = b[sortBy] || 0;
      if (sortBy === 'createdAt' || sortBy === 'calledAt' || sortBy === 'claimedAt') {
        const timeA = new Date(valA).getTime() || 0;
        const timeB = new Date(valB).getTime() || 0;
        return (timeA - timeB) * order;
      }
      if (typeof valA === 'number' && typeof valB === 'number') {
        return (valA - valB) * order;
      }
      return String(valA).localeCompare(String(valB)) * order;
    });
  } else if (status === 'called') {
    filteredQueues.sort((a, b) => {
      const timeA = new Date(a.calledAt).getTime() || 0;
      const timeB = new Date(b.calledAt).getTime() || 0;
      return timeB - timeA;
    });
  } else {
    filteredQueues.sort((a, b) => {
      const numA = parseInt(a.number) || 0;
      const numB = parseInt(b.number) || 0;
      return numA - numB;
    });
  }
  
  const pageNum = parseInt(page);
  const pageSizeNum = parseInt(pageSize);
  const total = filteredQueues.length;
  const startIndex = (pageNum - 1) * pageSizeNum;
  const endIndex = startIndex + pageSizeNum;
  const paginatedQueues = filteredQueues.slice(startIndex, endIndex);
  
  res.json({
    data: paginatedQueues.map(normalizeQueueResponse),
    total,
    page: pageNum,
    pageSize: pageSizeNum,
    totalPages: Math.ceil(total / pageSizeNum)
  });
});

app.post('/api/queue/bind', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const { activityId, mode, 号码, userId, openid } = req.body;
  const braceletCheck = validateBraceletIdStrictMg27(req.body.手环编号);
  if (!braceletCheck.ok) {
    return res.status(400).json({ error: braceletCheck.error });
  }
  const 手环编号 = braceletCheck.value;
  if (!activityId || !mode) return res.status(400).json({ error: '参数错误' });

  const activity = activities.find((a) => a._id === activityId || a.id === activityId);
  if (!activity) return res.status(404).json({ error: '活动不存在' });

  const resolvedActivityId = canonicalActivityIdForPersist(activity);

  let queueNumber;
  if (mode === 'auto') {
    queueNumber = allocateNextFreeQueueNumber(activity, resolvedActivityId);
    if (queueNumber == null) {
      return res.status(500).json({ error: '无法分配排号，请稍后重试' });
    }
    saveData('activities.json', activities);
  } else if (mode === 'manual') {
    if (号码 == null || String(号码).trim() === '') {
      return res.status(400).json({ error: '请输入号码' });
    }
    queueNumber = 号码;
  } else {
    return res.status(400).json({ error: '无效的填入方式' });
  }

  const conflict = getBindConflict(resolvedActivityId, 手环编号, queueNumber);
  if (conflict) return res.status(400).json({ error: conflict });

  // 保存userId用于后续查询用户绑定
  const queueUserId = userId || openid;
  
  const queue = { 
    _id: Date.now().toString(), 
    activityId: resolvedActivityId, 
    手环编号, 
    号码: queueNumber, 
    status: 'waiting', 
    boundBy: user.username, 
    userId: queueUserId,
    createdAt: new Date() 
  };
  queues.push(queue);
  saveData('queues.json', queues);
  res.json(queue);
});

app.post('/api/queue/call', async (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const { activityId, number } = req.body;
  
  const activity = findActivityByFlexibleId(activityId);
  if (!activity) {
    return res.status(404).json({ error: '活动不存在' });
  }
  
  if (activity.queuePaused) {
    return res.status(400).json({ error: '活动已暂停排队，无法叫号' });
  }
  
  const queue = queues.find(
    (q) => activityIdMatches(q.activityId, activityId) && queueNumberEq(q, number)
  );
  
  if (!queue) {
    return res.status(404).json({ error: '排队记录不存在' });
  }
  if (!isQueueBeforeCalled(queue)) {
    return res.status(400).json({ error: '该号码已叫号入场，无法重复叫号' });
  }
  
  const activityName = activity ? activity.name : '未知活动';
  
  // 检查是否过号（如果当前叫的号码比用户号码小很多，说明用户可能过号了）
  // 这里简单判断：如果当前号码已经超过用户号码+1，则认为过号
  const userNum = Number(queueNumberRaw(queue));
  const isMissed =
    !Number.isNaN(userNum) &&
    activity.currentNumber > userNum + 1 &&
    queue.status !== 'called';

  const actKeyForWait = canonicalActivityIdForPersist(activity) || queue.activityId;
  const waitingBeforeCall = getWaitingQueuesSortedForActivity(actKeyForWait);
  
  // 更新状态为已叫号入场（仍为 called，仅业务文案区分）
  queue.status = 'called';
  queue.calledAt = new Date();
  queue.calledBy = user.username;
  saveData('queues.json', queues);
  
  // 获取用户的 openid 并发送消息（bracelet_bindings 与 queue.openid 双通道）
  try {
    const bKey = queueBraceletKey(queue);
    const openid = resolveCustomerOpenidForQueue(queue);

    if (openid) {
      const numDisp = queueNumberRaw(queue);
      console.log(
        '[叫号/订阅] activity=%s 叫号=%s 手环=%s isMissed=%s → 接收 openid=%s',
        activity._id,
        String(number),
        bKey || '(空)',
        isMissed,
        maskOpenid(openid)
      );
      if (isMissed) {
        await sendMissedNotification(openid, numDisp);
      } else {
        await sendCalledNotification(openid, numDisp, queue.calledAt);
      }
    } else {
      const raw = queue.openid || queue.userId || '';
      const hint =
        String(raw).startsWith('temp_') || String(raw).startsWith('mock_')
          ? '（当前为 temp_/mock_ 临时身份，请重新打开小程序等待微信登录成功后再绑定）'
          : '';
      console.warn(
        '[叫号/订阅] 无法发送：无有效微信 openid。手环=%s 原始openid/userId=%s %s',
        bKey || '(空)',
        raw ? String(raw).slice(0, 28) : '(无)',
        hint
      );
    }

    await checkAndSendThirdAheadLineReminder(activity, queue, waitingBeforeCall);
  } catch (error) {
    console.error('发送叫号消息失败:', error);
    // 消息发送失败不影响叫号流程
  }
  
  // 更新活动的当前号码
  if (activity.currentNumber < number) {
    activity.currentNumber = number;
    saveData('activities.json', activities);
    
    // 检查并发送提前5位提醒
    await checkAndSendAhead5Reminder(activityId, number);
  }
  
  res.json({ success: true, calledNumber: number });
});

// 获取排队人数（小程序端用）
app.get('/api/queue/count', (req, res) => {
  const { activityId } = req.query;
  
  if (!activityId) {
    return res.status(400).json({ error: '缺少activityId参数' });
  }
  
  const count = queues.filter(
    (q) => activityIdMatches(q.activityId, activityId) && isQueueBeforeCalled(q)
  ).length;
  
  res.json({
    success: true,
    count: count
  });
});

app.get('/api/queue/status/:activityId', (req, res) => {
  const aid = String(req.params.activityId || '').trim();
  const activity = findActivityByFlexibleId(aid);

  const queueCount = queues.filter(
    (q) => activityIdMatches(q.activityId, aid) && isQueueBeforeCalled(q)
  ).length;

  const calledQueues = queues
    .filter((q) => activityIdMatches(q.activityId, aid) && q.status === 'called' && q.calledAt)
    .sort((a, b) => new Date(b.calledAt) - new Date(a.calledAt));

  const lastCalled = calledQueues.length > 0 ? queueNumberRaw(calledQueues[0]) : 0;

  const pace = computeActivityCallFlowPace(aid);
  const avgIntervalSeconds =
    pace.hasSamples && pace.secPerPersonCore != null && Number.isFinite(pace.secPerPersonCore)
      ? Math.round(pace.secPerPersonCore)
      : null;
  const avgIntervalMinutes =
    avgIntervalSeconds == null ? null : Math.round(avgIntervalSeconds / 60);
  /** 与小程序同一 pace：服务节奏偏慢或长时间未叫号且仍有排队 */
  const isSlow =
    !pace.hasSamples ||
    (pace.secPerPersonCore != null &&
      Number.isFinite(pace.secPerPersonCore) &&
      pace.secPerPersonCore >= 600) ||
    (pace.stallBoost >= 1.75 && queueCount > 0);

  const currentNumber = activity
    ? Number(activity.currentNumber) || 0
    : inferCurrentNumberFromQueues(aid);
  const queuePaused = activity ? Boolean(activity.queuePaused) : false;

  res.json({
    currentNumber,
    queueCount,
    lastCalled,
    avgIntervalSeconds,
    avgIntervalMinutes,
    hasPaceSamples: pace.hasSamples,
    isSlow,
    queuePaused,
    estimateComputedAt: pace.computedAt,
    estimateSource: pace.source
  });
});

/** 与后台解绑逻辑一致：删除 queues 记录并清理 braceletBindings 映射 */
function removeQueueEntryById(idStr) {
  const id = String(idStr || '');
  const idx = queues.findIndex(
    (q) => String(q._id || '') === id || String(q.id || '') === id
  );
  if (idx === -1) return { ok: false, error: '绑定不存在' };
  const removed = queues[idx];
  const bKey = queueBraceletKey(removed);
  if (bKey && braceletBindings[bKey]) {
    delete braceletBindings[bKey];
    saveData('bracelet_bindings.json', braceletBindings);
  }
  queues.splice(idx, 1);
  saveData('queues.json', queues);
  return { ok: true, removed };
}

app.delete('/api/queue/:id', (req, res) => {
  const rawAuth = req.headers.authorization || '';
  const token = rawAuth.replace(/^Bearer\s+/i, '').trim();
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const id = String(req.params.id || '');
  const r = removeQueueEntryById(id);
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ success: true });
});

app.get('/api/users', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  
  const { page = 1, pageSize = 10 } = req.query;
  const pageNum = parseInt(page);
  const pageSizeNum = parseInt(pageSize);
  
  const userList = users.map(u => ({ id: u.id, username: u.username, role: u.role, permissions: u.permissions, createdAt: u.createdAt }));
  const total = userList.length;
  const startIndex = (pageNum - 1) * pageSizeNum;
  const endIndex = startIndex + pageSizeNum;
  const paginatedUsers = userList.slice(startIndex, endIndex);
  
  res.json({
    data: paginatedUsers,
    total,
    page: pageNum,
    pageSize: pageSizeNum,
    totalPages: Math.ceil(total / pageSizeNum)
  });
});

app.post('/api/users', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const { username, password, role, permissions } = req.body;
  if (users.find(u => u.username === username)) return res.status(400).json({ error: '用户名已存在' });

  const newUser = { id: Date.now().toString(), username, password: hashPassword(password), role: role || 'staff', permissions: permissions || ['queue.bind', 'queue.view'], createdAt: new Date() };
  users.push(newUser);
  saveData('users.json', users);
  res.json({ id: newUser.id, username: newUser.username, role: newUser.role });
});

app.get('/api/permissions', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  res.json([
    { key: 'admin', name: '管理员' },
    { key: 'activity.manage', name: '活动管理' },
    { key: 'queue.bind', name: '手环绑定' },
    { key: 'queue.call', name: '叫号操作' },
    { key: 'queue.view', name: '排队查看' },
    { key: 'settings.manage', name: '系统设置' }
  ]);
});

app.get('/api/roles', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  
  const { page = 1, pageSize = 10 } = req.query;
  const pageNum = parseInt(page);
  const pageSizeNum = parseInt(pageSize);
  
  const total = roles.length;
  const startIndex = (pageNum - 1) * pageSizeNum;
  const endIndex = startIndex + pageSizeNum;
  const paginatedRoles = roles.slice(startIndex, endIndex);
  
  res.json({
    data: paginatedRoles,
    total,
    page: pageNum,
    pageSize: pageSizeNum,
    totalPages: Math.ceil(total / pageSizeNum)
  });
});

app.post('/api/roles', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const { name, permissions } = req.body;
  const role = { _id: Date.now().toString(), name, permissions: permissions || [] };
  roles.push(role);
  saveData('roles.json', roles);
  res.json(role);
});

app.delete('/api/roles/:id', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const idx = roles.findIndex(r => r._id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '角色不存在' });
  roles.splice(idx, 1);
  saveData('roles.json', roles);
  res.json({ success: true });
});

app.get('/api/queue/user/:activityId/:braceletId', (req, res) => {
  const { activityId } = req.params;
  const braceletIdRaw = decodeURIComponent(req.params.braceletId || '');
  const braceletCheck = validateBraceletIdCharsOnly(braceletIdRaw);
  if (!braceletCheck.ok) {
    return res.status(400).json({ error: braceletCheck.error });
  }
  const braceletId = braceletCheck.value;
  const queue = queues.find(
    (q) =>
      activityIdMatches(q.activityId, activityId) &&
      braceletKeyNormalize(queueBraceletKey(q)) === braceletKeyNormalize(braceletId)
  );
  if (!queue) return res.status(404).json({ error: '未找到绑定信息' });
  res.json(queue);
});

// 微信小程序登录 - 通过code获取openid
app.post('/api/wechat/login', async (req, res) => {
  const { code } = req.body || {};

  if (!code) {
    console.warn(
      '[wechat/login] 缺少 code；Content-Type=%s bodyKeys=%s',
      req.headers['content-type'],
      Object.keys(req.body || {}).join(',')
    );
    systemLogger.warn('wechat/login', 'missing_code', {
      rid: req._requestLogId,
      contentType: req.headers['content-type'],
      bodyKeys: Object.keys(req.body || {})
    });
    return res.status(400).json({
      success: false,
      error: 'missing_code',
      message:
        '缺少 code：请确认小程序请求带 Content-Type: application/json，且 body 为 {"code":"..."}'
    });
  }

  /** 空字符串视为未设置，回退占位，避免 .env 里写 WECHAT_APPID= 导致永远不请求微信 */
  const APPID =
    (process.env.WECHAT_APPID && String(process.env.WECHAT_APPID).trim()) || 'your_appid';
  const SECRET =
    (process.env.WECHAT_SECRET && String(process.env.WECHAT_SECRET).trim()) || 'your_secret';

  if (APPID === 'your_appid' || SECRET === 'your_secret') {
    console.error('[wechat/login] 未配置有效 WECHAT_APPID / WECHAT_SECRET（仍为占位符）');
    systemLogger.warn('wechat/login', 'wechat_not_configured', { rid: req._requestLogId });
    return res.status(503).json({
      success: false,
      error: 'wechat_not_configured',
      message:
        '服务器未配置微信 AppId/Secret：请在项目根目录或 backend 目录的 .env 中设置 WECHAT_APPID、WECHAT_SECRET 后重启 Node'
    });
  }

  try {
    // 调用微信接口获取openid和session_key
    const response = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: APPID,
        secret: SECRET,
        js_code: code,
        grant_type: 'authorization_code'
      }
    });

    let jw = response.data;
    if (typeof jw === 'string') {
      try {
        jw = JSON.parse(jw);
      } catch (pe) {
        console.error('[wechat/login] jscode2session 返回非 JSON:', String(jw).slice(0, 500));
        systemLogger.warn('wechat/login', 'upstream_not_json', { rid: req._requestLogId });
        return res.status(502).json({
          success: false,
          error: 'bad_upstream',
          message: '微信接口返回非 JSON（可能被公司代理/防火墙替换页面）'
        });
      }
    }
    if (!jw || typeof jw !== 'object') {
      return res.status(502).json({
        success: false,
        error: 'bad_upstream',
        message: '微信接口响应异常'
      });
    }

    const { openid, session_key, unionid, errcode, errmsg } = jw;

    if (errcode) {
      console.error('[wechat/login] 微信接口错误:', errcode, errmsg);
      systemLogger.warn('wechat/login', 'wechat_api_error', {
        rid: req._requestLogId,
        errcode,
        errmsg,
        appidTail: APPID.length > 8 ? APPID.slice(-6) : APPID
      });
      return res.status(400).json({
        success: false,
        error: 'wechat_api_error',
        code: errcode,
        message: errmsg || 'jscode2session 失败'
      });
    }

    if (!openid) {
      console.error('[wechat/login] 响应无 openid:', JSON.stringify(jw));
      systemLogger.warn('wechat/login', 'no_openid_in_response', {
        rid: req._requestLogId,
        keys: jw && typeof jw === 'object' ? Object.keys(jw) : []
      });
      return res.status(502).json({
        success: false,
        error: 'no_openid',
        message: '微信未返回 openid，请核对 AppId 与小程序是否一致'
      });
    }

    // 保存用户信息到本地（首次登录时创建）
    if (!wechatUsers[openid]) {
      wechatUsers[openid] = {
        openid,
        unionid: unionid || null,
        createdAt: new Date(),
        lastLoginAt: new Date()
      };
      saveData('wechat_users.json', wechatUsers);
    } else {
      wechatUsers[openid].lastLoginAt = new Date();
      // 更新unionid（如果有）
      if (unionid) {
        wechatUsers[openid].unionid = unionid;
      }
      saveData('wechat_users.json', wechatUsers);
    }

    // 生成token用于后续请求验证
    const token = crypto.randomBytes(32).toString('hex');
    wechatUsers[openid].token = token;
    saveData('wechat_users.json', wechatUsers);

    systemLogger.info('wechat/login', 'success', {
      rid: req._requestLogId,
      openidPrefix: String(openid).slice(0, 10) + '…',
      isNewUser:
        !Object.keys(wechatUsers[openid]).includes('createdAt') ||
        new Date(wechatUsers[openid].createdAt).getTime() ===
          new Date(wechatUsers[openid].lastLoginAt).getTime()
    });

    res.json({
      success: true,
      openid,
      unionid: unionid || null,
      token,
      isNewUser: !Object.keys(wechatUsers[openid]).includes('createdAt') || 
                 (new Date(wechatUsers[openid].createdAt)).getTime() === (new Date(wechatUsers[openid].lastLoginAt)).getTime()
    });

  } catch (error) {
    console.error('微信登录异常:', error.message);
    systemLogger.error('wechat/login', 'exception', {
      rid: req._requestLogId,
      message: error.message,
      stack: error.stack && String(error.stack).slice(0, 2500)
    });
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: '微信登录服务暂时不可用',
      detail: error.message
    });
  }
});

// 更新用户头像和昵称（支持创建新用户）
// 上传头像（通过URL下载方式）
app.post('/api/wechat/upload-avatar', async (req, res) => {
  console.log('【头像上传API】收到头像上传请求');
  console.log('【头像上传API】请求体:', req.body);
  
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    console.log('【头像上传API】未授权，缺少token');
    return res.status(401).json({ success: false, error: '未授权' });
  }

  const { avatarUrl } = req.body;
  
  if (!avatarUrl) {
    console.log('【头像上传API】头像URL为空');
    return res.status(400).json({ success: false, error: '头像URL不能为空' });
  }

  console.log('【头像上传API】开始下载头像:', avatarUrl);
  
  try {
    // 下载头像图片
    const response = await axios.get(avatarUrl, { responseType: 'stream' });
    
    // 生成唯一文件名
    const ext = avatarUrl.split('.').pop() || 'jpg';
    const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const filePath = path.join(AVATAR_DIR, filename);
    
    console.log('【头像上传API】保存文件:', filePath);
    
    // 保存文件
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    // 返回存储后的头像URL
    const storedUrl = `/avatars/${filename}`;
    
    console.log('【头像上传API】头像上传成功:', storedUrl);
    
    res.json({
      success: true,
      data: { avatarUrl: storedUrl }
    });
  } catch (error) {
    console.error('【头像上传API】头像上传失败:', error.message);
    res.status(500).json({ success: false, error: '头像上传失败' });
  }
});

// 上传头像（通过文件上传方式）
app.post('/api/wechat/upload-avatar-file', upload.single('avatar'), (req, res) => {
  console.log('【头像文件上传API】收到文件上传请求');
  
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    console.log('【头像文件上传API】未授权，缺少token');
    return res.status(401).json({ success: false, error: '未授权' });
  }

  if (!req.file) {
    console.log('【头像文件上传API】未上传文件');
    return res.status(400).json({ success: false, error: '未上传文件' });
  }

  const filename = req.file.filename;
  const storedUrl = `/avatars/${filename}`;
  
  console.log('【头像文件上传API】文件上传成功:', storedUrl);
  
  res.json({
    success: true,
    data: { avatarUrl: storedUrl }
  });
});

app.post('/api/wechat/user-info', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ success: false, error: '未授权' });
  }

  const { nickName, avatarUrl, openid, unionid } = req.body;
  
  console.log('【用户信息更新】收到请求:', { nickName, avatarUrl, openid, unionid });
  
  // 优先按openid查找用户（支持重新授权时更新同一用户）
  let user = Object.values(wechatUsers).find(u => u.openid === openid);
  
  // 如果按openid没找到，再按token查找
  if (!user) {
    user = Object.values(wechatUsers).find(u => u.token === token);
  }
  
  // 如果用户不存在，创建新用户记录
  if (!user) {
    console.log('用户不存在，创建新用户记录');
    const newOpenid = openid || 'temp_' + Date.now();
    wechatUsers[newOpenid] = {
      openid: newOpenid,
      unionid: unionid || null,
      token,
      createdAt: new Date(),
      lastLoginAt: new Date()
    };
    user = wechatUsers[newOpenid];
  }
  
  // 更新用户信息（覆盖旧数据）
  if (nickName) {
    user.nickName = nickName;
    console.log('【用户信息更新】更新昵称:', nickName);
  }
  
  if (avatarUrl) {
    user.avatarUrl = avatarUrl;
    console.log('【用户信息更新】更新头像:', avatarUrl);
  }
  
  if (unionid) {
    user.unionid = unionid;
    console.log('【用户信息更新】更新unionid:', unionid);
  }
  
  user.lastLoginAt = new Date();
  user.token = token; // 更新token
  
  saveData('wechat_users.json', wechatUsers);
  
  res.json({
    success: true,
    message: '用户信息更新成功'
  });
});

/**
 * 按本次 HTTP 请求的 Host 拼头像完整 URL，供小程序 <image> 使用（与后台列表同源且避免前端 API_URL 写错）。
 * 相对路径 /avatars/... 会变为 http(s)://当前请求的 host/avatars/...
 */
function computeAvatarDisplayUrlForRequest(req, storedPath) {
  const av = String(storedPath == null ? '' : storedPath).trim();
  if (!av) return '';
  if (/^https?:\/\//i.test(av)) return av;
  if (av.startsWith('wxfile://') || av.indexOf('http://tmp/') === 0) return av;
  const host = typeof req.get === 'function' ? req.get('host') : req.headers.host;
  if (!host) return '';
  const xf = typeof req.get === 'function' ? req.get('x-forwarded-proto') : '';
  const proto = String(xf || '').split(',')[0].trim() || req.protocol || 'http';
  const origin = `${proto}://${host}`;
  if (av.startsWith('/')) return origin + av;
  return `${origin}/${av.replace(/^\//, '')}`;
}

// 获取当前用户信息（含数据库中的昵称、头像、员工标记，供个人中心展示）
app.get('/api/wechat/user', (req, res) => {
  const token = readBearerToken(req);

  if (!token) {
    return res.status(401).json({ success: false, error: '未授权' });
  }

  const user = Object.values(wechatUsers).find((u) => u.token === token);

  if (!user) {
    return res.status(401).json({ success: false, error: '用户不存在或已过期' });
  }

  const storedAvatar = user.avatarUrl || '';

  res.json({
    success: true,
    openid: user.openid,
    nickName: user.nickName || '',
    avatarUrl: storedAvatar,
    avatarDisplayUrl: computeAvatarDisplayUrlForRequest(req, storedAvatar),
    isStaff: !!user.isStaff,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  });
});

/**
 * 小程序静默上报 wx.requestSubscribeMessage 各模板结果（accept/reject/ban），
 * 用于后端 send 前跳过 reject/ban，并累计粗略统计。
 */
app.post('/api/wechat/subscribe-report', (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: '未授权' });
  }
  const user = Object.values(wechatUsers).find((u) => u.token === token);
  if (!user || !user.openid) {
    return res.status(401).json({ success: false, error: '用户不存在或已过期' });
  }
  const oid = String(user.openid);
  const results = req.body && req.body.results;
  if (!results || typeof results !== 'object') {
    return res.status(400).json({ success: false, error: '缺少 results 对象' });
  }
  if (!wechatUsers[oid]) {
    wechatUsers[oid] = user;
  }
  if (!wechatUsers[oid].subscribeTemplates || typeof wechatUsers[oid].subscribeTemplates !== 'object') {
    wechatUsers[oid].subscribeTemplates = {};
  }
  if (!wechatUsers[oid].subscribeStats || typeof wechatUsers[oid].subscribeStats !== 'object') {
    wechatUsers[oid].subscribeStats = { accept: 0, reject: 0, ban: 0, other: 0, reports: 0 };
  }
  const stats = wechatUsers[oid].subscribeStats;
  stats.reports = (Number(stats.reports) || 0) + 1;
  Object.keys(results).forEach((tid) => {
    const v = String(results[tid] || '').trim();
    if (!tid || !v) return;
    wechatUsers[oid].subscribeTemplates[tid] = v;
    if (v === 'accept') stats.accept = (Number(stats.accept) || 0) + 1;
    else if (v === 'reject') stats.reject = (Number(stats.reject) || 0) + 1;
    else if (v === 'ban') stats.ban = (Number(stats.ban) || 0) + 1;
    else stats.other = (Number(stats.other) || 0) + 1;
  });
  wechatUsers[oid].subscribeTemplatesUpdatedAt = new Date().toISOString();
  saveData('wechat_users.json', wechatUsers);
  res.json({ success: true });
});

// ========== 后台管理API ==========

// 获取所有微信用户列表（后台管理用）
app.get('/api/wechat/users', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const adminUser = validateToken(token);
  
  if (!adminUser) {
    return res.status(401).json({ error: '未授权' });
  }

  const { nickname, openid, page = 1, pageSize = 10 } = req.query;

  // 构建用户列表，包含活动参与统计
  let userList = Object.values(wechatUsers).map(user => {
    // 统计该用户参与的活动数量
    const userBindings = queues.filter(q => q.userId === user.openid);
    const uniqueActivities = [...new Set(userBindings.map(q => q.activityId))];
    
    return {
      openid: user.openid,
      nickName: user.nickName || '',
      avatarUrl: user.avatarUrl || '',
      unionid: user.unionid || '',
      isStaff: user.isStaff || false,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      activityCount: uniqueActivities.length,
      bindingCount: userBindings.length
    };
  });

  // 模糊查询筛选
  if (nickname) {
    userList = userList.filter(user => 
      user.nickName && user.nickName.toLowerCase().includes(nickname.toLowerCase())
    );
  }
  
  if (openid) {
    userList = userList.filter(user => 
      user.openid.toLowerCase().includes(openid.toLowerCase())
    );
  }

  // 按创建时间降序排列，最近的在最前面
  userList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // 分页处理
  const total = userList.length;
  const pageNum = parseInt(page);
  const pageSizeNum = parseInt(pageSize);
  const startIndex = (pageNum - 1) * pageSizeNum;
  const endIndex = startIndex + pageSizeNum;
  const paginatedUsers = userList.slice(startIndex, endIndex);

  res.json({
    success: true,
    data: paginatedUsers,
    total,
    page: pageNum,
    pageSize: pageSizeNum,
    totalPages: Math.ceil(total / pageSizeNum)
  });
});

// 校验当前用户是否为员工（小程序端调用）
app.get('/api/wechat/user/staff-check', (req, res) => {
  const token = readBearerToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: '未授权' });
  }

  const user = Object.values(wechatUsers).find((u) => u.token === token);

  if (!user) {
    return res.status(404).json({ success: false, message: '用户不存在' });
  }

  res.json({
    success: true,
    isStaff: !!user.isStaff
  });
});

/**
 * 小程序员工端：返回已启用活动列表（独立接口，不改动 /api/activities）
 * 校验：Bearer token 有效、用户存在、且 isStaff 为员工。
 */
app.get('/api/wechat/staff/enabled-activities', (req, res) => {
  const token = readBearerToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: '未授权' });
  }

  const user = Object.values(wechatUsers).find((u) => u.token === token);
  if (!user) {
    return res.status(404).json({ success: false, message: '用户不存在' });
  }
  if (!user.isStaff) {
    return res.status(403).json({ success: false, message: '权限不足，非员工账号' });
  }

  const src = Array.isArray(activities) ? activities : [];
  const list = src
    .filter((a) => a && a.status === 'active')
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map((a) => ({
      _id: a._id,
      id: a.id || a._id,
      name: a.name,
      status: a.status,
      description: a.description || '',
      currentNumber: a.currentNumber
    }));

  return res.json({
    success: true,
    data: list,
    total: list.length
  });
});

/**
 * 小程序员工端：叫号验证——在已启用活动下按手环查询排队状态、排号、叫号时间
 */
app.post('/api/wechat/staff/verify-queue', (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: '未授权' });
  }
  const user = Object.values(wechatUsers).find((u) => u.token === token);
  if (!user) {
    return res.status(404).json({ success: false, message: '用户不存在' });
  }
  if (!user.isStaff) {
    return res.status(403).json({ success: false, message: '权限不足，非员工账号' });
  }

  const { activityId } = req.body || {};
  const rawBracelet =
    req.body && req.body.braceletCode != null && req.body.braceletCode !== ''
      ? req.body.braceletCode
      : req.body && req.body['手环编号'];

  const braceletCheck = validateBraceletIdStrictMg27(rawBracelet);
  if (!braceletCheck.ok) {
    return res.status(400).json({ success: false, message: braceletCheck.error });
  }
  const braceletCode = braceletCheck.value;

  if (!activityId) {
    return res.status(400).json({ success: false, message: '请选择活动' });
  }

  const activity = findActivityByFlexibleId(activityId);
  if (!activity || activity.status !== 'active') {
    return res.status(400).json({ success: false, message: '活动不存在或未启用' });
  }
  const resolvedActivityId = canonicalActivityIdForPersist(activity);

  /** 与登记数据大小写不一致时仍能匹配（如 mg# 与 MG#） */
  const key = braceletKeyNormalize(braceletCode).toUpperCase();
  const matches = queues.filter(
    (q) =>
      activityIdMatches(q.activityId, resolvedActivityId) &&
      braceletKeyNormalize(queueBraceletKey(q)).toUpperCase() === key
  );

  if (!matches.length) {
    return res.json({
      success: false,
      message: '该活动下未找到此手环的排队记录'
    });
  }

  matches.sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });
  const row = matches[0];

  let calledAtIso = null;
  if (row.status === 'called' && row.calledAt) {
    const t = new Date(row.calledAt);
    if (!Number.isNaN(t.getTime())) {
      calledAtIso = t.toISOString();
    }
  }

  return res.json({
    success: true,
    data: {
      activityName: activity.name || '未命名活动',
      activityId: resolvedActivityId,
      braceletCode,
      queueNumber: queueNumberRaw(row),
      status: row.status,
      calledAt: calledAtIso
    }
  });
});

// 员工手动绑定（小程序端员工调用）
app.post('/api/wechat/user/bind-manual', (req, res) => {
  const token = readBearerToken(req);
  
  if (!token) {
    return res.status(401).json({ success: false, message: '未授权' });
  }

  // 根据token查找用户
  const user = Object.values(wechatUsers).find(u => u.token === token);
  
  if (!user) {
    return res.status(404).json({ success: false, message: '用户不存在' });
  }

  // 验证是否为员工
  if (!user.isStaff) {
    return res.status(403).json({ success: false, message: '权限不足，非员工账号' });
  }

  const { activityId, queueCode } = req.body;
  const braceletCheck = validateBraceletIdStrictMg27(req.body.braceletCode);
  if (!braceletCheck.ok) {
    return res.status(400).json({ success: false, message: braceletCheck.error });
  }
  const braceletCode = braceletCheck.value;

  // 验证参数
  if (!activityId || !queueCode) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  // 验证活动是否存在且已启用
  const activity = activities.find(a => a._id === activityId || a.id === activityId);
  if (!activity || activity.status !== 'active') {
    return res.status(400).json({ success: false, message: '活动不存在或未启用' });
  }

  const resolvedActivityId = canonicalActivityIdForPersist(activity);

  const conflict = getBindConflict(resolvedActivityId, braceletCode, queueCode);
  if (conflict) {
    return res.status(400).json({ success: false, message: conflict });
  }

  // 创建绑定记录
  const bindingId = `${Date.now()}`;

  // 添加手环绑定
  braceletBindings[braceletCode] = {
    openid: user.openid,
    activityId: resolvedActivityId,
    braceletCode,
    queueCode,
    createdAt: new Date().toISOString()
  };

  // 排队记录：与后台 /api/queue/bind 一致；小程序员工绑定人记 openid
  queues.push({
    _id: bindingId,
    id: bindingId,
    activityId: resolvedActivityId,
    openid: user.openid,
    userId: user.openid,
    手环编号: braceletCode,
    号码: queueCode,
    braceletCode,
    queueCode,
    status: 'waiting',
    boundBy: user.openid,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  // 保存数据
  saveData('bracelet_bindings.json', braceletBindings);
  saveData('queues.json', queues);

  res.json({
    success: true,
    message: '绑定成功',
    data: {
      activityId: resolvedActivityId,
      braceletCode,
      queueCode
    }
  });
});

/** 小程序员工中心：最近绑定记录（仅本人 boundBy） */
app.get('/api/wechat/staff/recent-bindings', (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: '未授权' });
  }
  const user = Object.values(wechatUsers).find((u) => u.token === token);
  if (!user) {
    return res.status(404).json({ success: false, message: '用户不存在' });
  }
  if (!user.isStaff) {
    return res.status(403).json({ success: false, message: '权限不足，非员工账号' });
  }

  const rows = queues
    .filter((q) => String(q.boundBy || '') === String(user.openid))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 5)
    .map((q) => {
      const activity = findActivityByFlexibleId(q.activityId);
      return {
        id: q._id || q.id || '',
        activityId: q.activityId,
        activityName: activity ? activity.name : '',
        braceletId: queueBraceletKey(q),
        queueNumber: queueNumberRaw(q),
        status: q.status,
        staffRegisteredAt: q.createdAt || null,
        userScanBoundAt: q.claimedAt || null
      };
    });

  res.json({ success: true, data: rows });
});

/** 小程序员工中心：解绑最近记录（与后台 /api/queue/:id 删除逻辑一致） */
app.delete('/api/wechat/staff/recent-bindings/:id', (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: '未授权' });
  }
  const user = Object.values(wechatUsers).find((u) => u.token === token);
  if (!user) {
    return res.status(404).json({ success: false, message: '用户不存在' });
  }
  if (!user.isStaff) {
    return res.status(403).json({ success: false, message: '权限不足，非员工账号' });
  }

  const id = String(req.params.id || '');
  const row = queues.find(
    (q) =>
      (String(q._id || '') === id || String(q.id || '') === id) &&
      String(q.boundBy || '') === String(user.openid)
  );
  if (!row) {
    return res.status(404).json({ success: false, message: '绑定不存在或无权限' });
  }

  const removed = removeQueueEntryById(id);
  if (!removed.ok) {
    return res.status(404).json({ success: false, message: removed.error });
  }
  res.json({ success: true, message: '解绑成功' });
});

// 设置/取消用户员工身份（后台管理用）
app.put('/api/wechat/user/:openid/staff', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const adminUser = validateToken(token);
  
  if (!adminUser) {
    return res.status(401).json({ error: '未授权' });
  }

  const { openid } = req.params;
  const { isStaff } = req.body;

  if (!wechatUsers[openid]) {
    return res.status(404).json({ error: '用户不存在' });
  }

  wechatUsers[openid].isStaff = isStaff;
  saveData('wechat_users.json', wechatUsers);

  res.json({
    success: true,
    message: isStaff ? '已设为员工' : '已取消员工身份',
    data: { openid, isStaff }
  });
});

function mapQueueRowForAdminUserActivity(binding) {
  const activity = findActivityByFlexibleId(binding.activityId);
  return {
    activityId: binding.activityId,
    activityName: activity ? activity.name : '未知活动',
    braceletId: queueBraceletKey(binding),
    number: queueNumberRaw(binding),
    status: binding.status,
    /** 员工登记排队 / 手环绑定写入时间 */
    staffRegisteredAt: binding.createdAt,
    /** 用户小程序扫码领取（待发放→用户已扫码绑定）时间 */
    userScanBoundAt: binding.claimedAt || null,
    boundAt: binding.createdAt,
    calledAt: binding.calledAt
  };
}

/** 作为用户：排队归属自己，且非「自己当员工刚绑完尚待用户扫码」的 waiting */
function queueMatchesUserAsCustomer(q, openid) {
  const oid = String(openid);
  const uid = String(q.userId || '');
  const qoid = String(q.openid || '');
  const oby = String(q.boundBy || '');
  
  // 记录必须归属用户自己
  if (!(uid === oid || qoid === oid)) return false;
  
  // 必须有用户扫码时间（claimedAt），排除员工登记但用户未扫码的记录
  // 只有用户自己扫码领取的记录才显示在这里
  if (!q.claimedAt) return false;
  
  // 排除用户作为员工为他人绑定的 waiting 记录（虽然有 claimedAt 检查，这里作为双重保险）
  if (q.status === 'waiting' && oby === oid && uid !== oid) return false;
  
  return true;
}

/** 作为员工：小程序员工端 bind-manual 写入的 boundBy 为该 openid */
function queueMatchesUserAsStaffBinder(q, openid) {
  return String(q.boundBy || '') === String(openid);
}

/**
 * 同活动内「等待叫号」记录（waiting/claimed）排序：排号为纯数字时按数值升序，否则按字符串（numeric locale）再按登记时间。
 * 与现场「发号顺序 / 叫号顺序」一致时，第 k 位前的 k-1 条即前方人数。
 */
function compareWaitingQueueOrder(a, b) {
  const ra = String(queueNumberRaw(a) == null ? '' : queueNumberRaw(a)).trim();
  const rb = String(queueNumberRaw(b) == null ? '' : queueNumberRaw(b)).trim();
  const na = Number(ra);
  const nb = Number(rb);
  const aPure = ra !== '' && Number.isFinite(na) && String(na) === ra;
  const bPure = rb !== '' && Number.isFinite(nb) && String(nb) === rb;
  if (aPure && bPure && na !== nb) return na - nb;
  if (ra !== rb) return ra.localeCompare(rb, undefined, { numeric: true });
  const ta = new Date(a.createdAt || 0).getTime();
  const tb = new Date(b.createdAt || 0).getTime();
  return ta - tb;
}

function getWaitingQueuesSortedForActivity(activityId) {
  return queues
    .filter((q) => activityIdMatches(q.activityId, activityId) && isQueueBeforeCalled(q))
    .sort(compareWaitingQueueOrder);
}

/**
 * 前方还有 X 人：该用户在等待队列中的 0-based 下标（第 2 位 → X=1）。
 * 返回 positionInQueue 为 1-based 位次，便于展示或扩展。
 */
function getAheadCountForCustomerQueue(activityId, queueNumber, openid) {
  const waiting = getWaitingQueuesSortedForActivity(activityId);
  const me = waiting.find(
    (q) => queueNumberEq(q, queueNumber) && queueMatchesUserAsCustomer(q, openid)
  );
  if (!me) {
    return {
      inWaitingQueue: false,
      aheadCount: null,
      positionInQueue: null,
      waitingTotal: waiting.length
    };
  }
  const myId = String(me._id || me.id || '');
  const idx = waiting.findIndex((q) => String(q._id || q.id || '') === myId);
  if (idx < 0) {
    return {
      inWaitingQueue: false,
      aheadCount: null,
      positionInQueue: null,
      waitingTotal: waiting.length
    };
  }
  return {
    inWaitingQueue: true,
    aheadCount: idx,
    positionInQueue: idx + 1,
    waitingTotal: waiting.length
  };
}

/** 叫号流速：批量叫号（时间戳几乎相同）聚成一批；批与批之间的墙钟间隔 ÷ 本批人数 → 单人吞吐；近期样本指数加权 */
const PACE_WINDOW_MS = 90 * 60 * 1000;
const PACE_BATCH_GAP_MS = 5000;
const PACE_MIN_STEP_MS = 3000;
const PACE_TAU_MS = 15 * 60 * 1000;
const PACE_MIN_SEC_PER_PERSON = 12;
const PACE_MAX_SEC_PER_PERSON = 3600;
/** 近窗内无任何已叫号样本时：不臆造人均秒数，用极大吞吐占位使 waitEstimate 落入「1小时以上」 */
const PACE_NO_SAMPLE_ESTIMATE_SEC = PACE_MAX_SEC_PER_PERSON * 2;

/**
 * 队伍「卡住」：距上次叫号越久，人均估算秒数逐渐顶到 cap，便于前端显示「1小时以上」。
 * @param {number} secPerPersonCore 已夹在 [PACE_MIN_SEC_PER_PERSON, PACE_MAX_SEC_PER_PERSON]
 * @param {number} stallSec 距最后一次叫号的秒数
 */
function applyStallIdleInflation(secPerPersonCore, stallSec) {
  const cap = PACE_NO_SAMPLE_ESTIMATE_SEC;
  const floor = Math.max(PACE_MIN_SEC_PER_PERSON, secPerPersonCore);

  if (stallSec <= 120) {
    const est = Math.min(cap, floor);
    return {
      secPerPersonForEstimate: est,
      stallBoost: secPerPersonCore > 1e-9 ? est / secPerPersonCore : 1
    };
  }

  if (stallSec <= 300) {
    const u = (stallSec - 120) / (300 - 120);
    const mult = 1 + u * 2;
    const est = Math.min(cap, Math.max(PACE_MIN_SEC_PER_PERSON, floor * mult));
    return {
      secPerPersonForEstimate: est,
      stallBoost: secPerPersonCore > 1e-9 ? est / secPerPersonCore : mult
    };
  }

  const v = Math.min(1, (stallSec - 300) / 300);
  const mid = Math.min(cap, floor * 3);
  const eased = v * v;
  const est = Math.min(
    cap,
    Math.max(PACE_MIN_SEC_PER_PERSON, mid + (cap - mid) * eased)
  );
  return {
    secPerPersonForEstimate: est,
    stallBoost: secPerPersonCore > 1e-9 ? est / secPerPersonCore : 1 + eased * 100
  };
}

function computeActivityCallFlowPace(activityId) {
  const now = Date.now();
  const computedAt = new Date().toISOString();
  const called = queues.filter(
    (q) => activityIdMatches(q.activityId, activityId) && q.status === 'called' && q.calledAt
  );
  const events = called
    .map((q) => ({ t: new Date(q.calledAt).getTime() }))
    .filter((e) => !Number.isNaN(e.t) && e.t <= now && e.t >= now - PACE_WINDOW_MS)
    .sort((a, b) => a.t - b.t);

  if (events.length === 0) {
    return {
      hasSamples: false,
      secPerPersonCore: null,
      stallBoost: 1,
      secPerPersonForEstimate: PACE_NO_SAMPLE_ESTIMATE_SEC,
      source: 'no_samples',
      batchCount: 0,
      lastCallAtMs: null,
      computedAt
    };
  }

  const batchRanges = [];
  let lo = 0;
  for (let i = 1; i <= events.length; i++) {
    if (i === events.length || events[i].t - events[i - 1].t > PACE_BATCH_GAP_MS) {
      batchRanges.push({ lo, hi: i - 1 });
      lo = i;
    }
  }
  const batchMeta = batchRanges.map(({ lo, hi }) => ({
    tFirst: events[lo].t,
    tLast: events[hi].t,
    count: hi - lo + 1
  }));

  let secPerPersonCore;
  let source;

  if (batchMeta.length >= 2) {
    let wSum = 0;
    let rSum = 0;
    for (let i = 1; i < batchMeta.length; i++) {
      const prev = batchMeta[i - 1];
      const cur = batchMeta[i];
      const deltaMs = Math.max(PACE_MIN_STEP_MS, cur.tLast - prev.tLast);
      const r = cur.count / (deltaMs / 1000);
      const age = now - cur.tLast;
      const w = Math.exp(-age / PACE_TAU_MS);
      wSum += w;
      rSum += w * r;
    }
    if (wSum > 1e-9) {
      const weightedR = rSum / wSum;
      if (weightedR > 1e-9) {
        secPerPersonCore = 1 / weightedR;
        source = 'weighted_batches';
      }
    }
    if (secPerPersonCore == null) {
      const spanSec = Math.max(PACE_MIN_STEP_MS / 1000, (now - events[0].t) / 1000);
      secPerPersonCore = spanSec / Math.max(1, events.length);
      source = 'window_total_fallback';
    }
  } else {
    const b = batchMeta[0];
    const spanSec = Math.max(180, (now - b.tFirst) / 1000);
    secPerPersonCore = spanSec / Math.max(1, b.count);
    source = 'single_batch_window';
  }

  secPerPersonCore = Math.min(
    PACE_MAX_SEC_PER_PERSON,
    Math.max(PACE_MIN_SEC_PER_PERSON, secPerPersonCore)
  );

  const lastCallAtMs = batchMeta[batchMeta.length - 1].tLast;
  const stallSec = (now - lastCallAtMs) / 1000;
  const { secPerPersonForEstimate, stallBoost } = applyStallIdleInflation(secPerPersonCore, stallSec);

  return {
    hasSamples: true,
    secPerPersonCore,
    stallBoost,
    secPerPersonForEstimate,
    source,
    batchCount: batchMeta.length,
    lastCallAtMs,
    computedAt
  };
}

/**
 * 小程序 my-queue-ahead：在 ahead 结果上附加 queuePaused、waitEstimate（后端统一口径，含千人千面区间）
 */
function buildMyQueueAheadPayload(resolvedActivityId, queueNumber, qOpenid) {
  const activity = findActivityByFlexibleId(resolvedActivityId);
  const queuePaused = activity ? Boolean(activity.queuePaused) : false;
  const pace = computeActivityCallFlowPace(resolvedActivityId);
  const aheadOut = getAheadCountForCustomerQueue(resolvedActivityId, queueNumber, qOpenid);

  let waitEstimate;
  if (queuePaused) {
    waitEstimate = { kind: 'paused', computedAt: pace.computedAt };
  } else if (!aheadOut.inWaitingQueue) {
    waitEstimate = { kind: 'not_in_queue', computedAt: pace.computedAt };
  } else if (aheadOut.aheadCount == null) {
    waitEstimate = { kind: 'unknown', computedAt: pace.computedAt };
  } else if (aheadOut.aheadCount <= 0) {
    waitEstimate = { kind: 'range', minMinutes: 1, maxMinutes: 2, computedAt: pace.computedAt };
  } else {
    const a = aheadOut.aheadCount;
    const baseSec = a * pace.secPerPersonForEstimate;
    const minM = Math.max(1, Math.floor((baseSec * 0.85) / 60));
    const maxM = Math.max(minM, Math.ceil((baseSec * 1.22) / 60));
    if (maxM > 60) {
      waitEstimate = { kind: 'long_wait', computedAt: pace.computedAt };
    } else {
      waitEstimate = {
        kind: 'range',
        minMinutes: minM,
        maxMinutes: maxM,
        computedAt: pace.computedAt
      };
    }
  }

  return {
    queuePaused,
    waitEstimate,
    ...aheadOut
  };
}

/** boundBy 为已注册微信用户 openid 时，视为小程序员工端 bind-manual 登记（与后台「作为员工」一致） */
function isRegisteredByStaffMiniProgram(q) {
  const oby = String(q.boundBy || '');
  if (!oby) return false;
  return Boolean(wechatUsers[oby]);
}

/**
 * 小程序 bindingKind，与后台「查看活动」两 Tab 语义对齐：
 * - user：作为用户 · 扫码领取（含待发归属用户侧；已认领/已叫号为首页绑定结果）
 * - staff：作为员工 · 小程序绑定（boundBy 为当前查看者）
 */
function wechatBindingKindForViewer(q, viewerOpenid) {
  const oid = String(viewerOpenid);
  const userClaimed =
    queueMatchesUserAsCustomer(q, oid) &&
    (q.status === 'claimed' || q.status === 'called');
  if (userClaimed) return 'user';
  if (queueMatchesUserAsStaffBinder(q, oid)) return 'staff';
  if (queueMatchesUserAsCustomer(q, oid) && q.status === 'waiting') return 'staff';
  return 'user';
}

/** 小程序 user-bindings 列表项（与后台 asCustomer 同源过滤时 viewerOpenid 即该用户 openid） */
function serializeWechatUserBindingsRows(rows, viewerOpenid, scopeStr) {
  return rows.map((binding) => {
    const activity = findActivityByFlexibleId(binding.activityId);
    const bindingKind =
      scopeStr === 'customer'
        ? 'user'
        : wechatBindingKindForViewer(binding, viewerOpenid);
    return {
      activityId: binding.activityId,
      activityName: activity ? activity.name : '',
      braceletId: queueBraceletKey(binding),
      queueNumber: queueNumberRaw(binding),
      status: binding.status,
      createdAt: binding.createdAt,
      claimedAt: binding.claimedAt || null,
      calledAt: binding.calledAt,
      staffRegisteredAt: binding.createdAt || null,
      userScanBoundAt: binding.claimedAt || null,
      registeredByStaffMini: isRegisteredByStaffMiniProgram(binding),
      bindingKind
    };
  });
}

// 获取指定用户的活动详情（后台管理用）
app.get('/api/wechat/user/:openid/activities', (req, res) => {
  const token = req.headers.authorization;
  const adminUser = validateToken(token);
  
  if (!adminUser) {
    return res.status(401).json({ error: '未授权' });
  }

  const { openid } = req.params;
  
  // 查找用户
  const user = wechatUsers[openid];
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const asCustomer = queues
    .filter((q) => queueMatchesUserAsCustomer(q, openid))
    .map(mapQueueRowForAdminUserActivity);
  const asStaff = queues
    .filter((q) => queueMatchesUserAsStaffBinder(q, openid))
    .map(mapQueueRowForAdminUserActivity);

  const activitiesMerged = [...asCustomer, ...asStaff].filter(
    (row, i, arr) =>
      i ===
      arr.findIndex(
        (r) =>
          r.activityId === row.activityId &&
          r.braceletId === row.braceletId &&
          r.number === row.number &&
          r.boundAt === row.boundAt
      )
  );

  res.json({
    success: true,
    user: {
      openid: user.openid,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt
    },
    asCustomer,
    asStaff,
    activities: activitiesMerged,
    totalAsCustomer: asCustomer.length,
    totalAsStaff: asStaff.length,
    total: activitiesMerged.length
  });
});

// 绑定手环到微信用户（用于消息推送）
app.post('/api/wechat/bind-bracelet', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: '未授权' });
  }

  const user = Object.values(wechatUsers).find(u => u.token === token);
  
  if (!user) {
    return res.status(401).json({ error: '用户不存在或已过期' });
  }

  const braceletCheck = validateBraceletIdStrictMg27(req.body.braceletId);
  if (!braceletCheck.ok) {
    return res.status(400).json({ error: braceletCheck.error });
  }
  const braceletId = braceletCheck.value;

  if (!isRealWechatMiniOpenid(user.openid)) {
    return res.status(400).json({
      error:
        '微信登录未完成（临时账号无法接收排队通知）。请重新打开小程序并等待登录成功后再试。'
    });
  }

  // 保存手环和openid的绑定关系
  braceletBindings[braceletId] = {
    openid: user.openid,
    braceletId,
    boundAt: new Date()
  };
  
  saveData('bracelet_bindings.json', braceletBindings);
  
  console.log(`手环 ${braceletId} 已绑定到微信用户 ${user.openid}`);
  
  res.json({
    success: true,
    message: '绑定成功',
    braceletId
  });
});

// 小程序端绑定手环（用户扫码：待发放给用户 -> 用户已扫码绑定）
app.post('/api/wechat/bind', (req, res) => {
  const { openid } = req.body;
  const braceletCheck = validateBraceletIdStrictMg27(req.body.braceletId);
  if (!braceletCheck.ok) {
    return res.status(400).json({ success: false, message: braceletCheck.error });
  }
  const braceletId = braceletCheck.value;

  if (!openid) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }
  if (!isRealWechatMiniOpenid(openid)) {
    return res.status(400).json({
      success: false,
      message:
        '微信登录未完成（临时账号无法接收排队通知）。请关闭小程序重新进入，在网络良好处稍等登录后再扫码绑定。'
    });
  }

  const bidNorm = braceletKeyNormalize(braceletId);
  let existingQueue = queues.find(
    (q) =>
      braceletKeyNormalize(queueBraceletKey(q)) === bidNorm && q.status === 'waiting'
  );

  if (!existingQueue) {
    const claimedQ = queues.find(
      (q) =>
        braceletKeyNormalize(queueBraceletKey(q)) === bidNorm && q.status === 'claimed'
    );
    if (claimedQ) {
      if (claimedQ.openid === openid || claimedQ.userId === openid) {
        const act0 = activities.find((a) => a._id === claimedQ.activityId);
        return res.json({
          success: true,
          message: '用户已扫码绑定',
          data: {
            activityId: claimedQ.activityId,
            activityName: act0 ? act0.name : '',
            braceletId: queueBraceletKey(claimedQ),
            queueNumber: queueNumberRaw(claimedQ),
            status: 'claimed'
          }
        });
      }
      return res.status(400).json({
        success: false,
        message: '该手环已被其他用户领取'
      });
    }
    return res.status(400).json({
      success: false,
      message: '手环未绑定到任何活动或已不可领取'
    });
  }

  existingQueue.openid = openid;
  existingQueue.userId = openid;
  existingQueue.status = 'claimed';
  existingQueue.claimedAt = new Date().toISOString();
  existingQueue.updatedAt = new Date().toISOString();

  braceletBindings[braceletId] = {
    openid: openid,
    braceletId: braceletId,
    boundAt: new Date()
  };

  saveData('queues.json', queues);
  saveData('bracelet_bindings.json', braceletBindings);

  const activity = activities.find((a) => a._id === existingQueue.activityId);

  res.json({
    success: true,
    message: '绑定成功',
    data: {
      activityId: existingQueue.activityId,
      activityName: activity ? activity.name : '',
      braceletId: queueBraceletKey(existingQueue),
      queueNumber: queueNumberRaw(existingQueue),
      status: 'claimed'
    }
  });
});

/**
 * 小程序：前方还有几人（独立接口）。
 * 按活动内「等待叫号」队列中的位次计算，不是 queueCount，也不是 currentNumber 与排号的差。
 * query: activityId, queueNumber, openid（须与 Bearer 一致）
 */
app.get('/api/wechat/my-queue-ahead', (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: '未授权' });
  }
  const sessionUser = Object.values(wechatUsers).find((u) => u.token === token);
  if (!sessionUser || !sessionUser.openid) {
    return res.status(401).json({ success: false, error: '用户不存在或已过期' });
  }
  const qOpenid = String(req.query.openid || '').trim();
  const activityIdRaw = Array.isArray(req.query.activityId)
    ? String(req.query.activityId[0] != null ? req.query.activityId[0] : '').trim()
    : String(req.query.activityId || '').trim();
  const queueNumRaw = Array.isArray(req.query.queueNumber)
    ? req.query.queueNumber[0]
    : req.query.queueNumber;
  const queueNumber = queueNumRaw == null ? '' : String(queueNumRaw).trim();
  if (!qOpenid) {
    return res.status(400).json({ success: false, error: '缺少 openid 参数' });
  }
  if (!activityIdRaw || queueNumber === '') {
    return res.status(400).json({ success: false, error: '缺少 activityId 或 queueNumber' });
  }
  if (String(sessionUser.openid) !== qOpenid) {
    return res.status(403).json({
      success: false,
      error: 'openid 与当前登录不一致，请重新进入小程序或下拉刷新'
    });
  }
  /**
   * 活动未录入 activities 时，queues 里仍可能有该 activityId（测试数据或历史不一致）。
   * 此时仍用请求里的 activityId 与队列匹配，避免误报「活动不存在」导致小程序无法算前方人数。
   */
  const activity = findActivityByFlexibleId(activityIdRaw);
  const resolvedId = activity ? canonicalActivityIdForPersist(activity) : activityIdRaw;
  const merged = buildMyQueueAheadPayload(resolvedId, queueNumber, qOpenid);
  res.json({
    success: true,
    activityId: resolvedId,
    queueNumber: String(queueNumber),
    ...merged
  });
});

// 小程序「我的绑定」：只返回用户自己通过首页扫码领取的手环记录
// 只有用户自己扫码绑定的记录（有 claimedAt）才显示，排除员工登记但用户未扫码的记录
app.get('/api/wechat/my-customer-bindings', (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: '未授权' });
  }
  const sessionUser = Object.values(wechatUsers).find((u) => u.token === token);
  if (!sessionUser || !sessionUser.openid) {
    return res.status(401).json({ success: false, error: '用户不存在或已过期' });
  }
  const qOpenid = String(req.query.openid || '').trim();
  if (!qOpenid) {
    return res.status(400).json({ success: false, error: '缺少 openid 参数' });
  }
  if (String(sessionUser.openid) !== qOpenid) {
    return res.status(403).json({
      success: false,
      error: 'openid 与当前登录不一致，请重新进入小程序或下拉刷新'
    });
  }
  
  // 只返回用户自己作为客户绑定的记录，且必须是用户已经扫码领取的（有 claimedAt）
  const userBindings = queues.filter((q) => {
    const userId = String(q.userId || '');
    const openid = String(q.openid || '');
    
    // 归属用户自己（userId 或 openid 等于当前用户）
    if (!(userId === qOpenid || openid === qOpenid)) return false;
    
    // 必须有用户扫码时间（claimedAt），排除员工登记但用户未扫码的记录
    if (!q.claimedAt) return false;
    
    return true;
  });
  
  const data = serializeWechatUserBindingsRows(userBindings, qOpenid, 'customer');
  res.json({ success: true, data });
});

// 【小程序专用】我的绑定 - 只显示用户自己扫码绑定的记录
// 与后台逻辑完全独立，专门用于小程序"我的绑定"页面
app.get('/api/wechat/my-scanned-bindings', (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: '未授权' });
  }
  
  const sessionUser = Object.values(wechatUsers).find((u) => u.token === token);
  if (!sessionUser || !sessionUser.openid) {
    return res.status(401).json({ success: false, error: '用户不存在或已过期' });
  }
  
  const openid = String(sessionUser.openid);
  
  // 只返回用户自己扫码绑定的记录
  // 条件：
  // 1. userId 或 openid 等于当前用户（记录归属用户）
  // 2. 有 claimedAt（用户已经扫码领取）
  const userBindings = queues.filter((q) => {
    const userId = String(q.userId || '');
    const qOpenid = String(q.openid || '');
    
    // 记录必须归属当前用户
    if (!(userId === openid || qOpenid === openid)) return false;
    
    // 用户必须已经扫码（有 claimedAt 时间）
    if (!q.claimedAt) return false;
    
    // 排除已叫号入场的记录（called 状态不展示）
    if (q.status === 'called') return false;
    
    return true;
  });
  
  // 序列化返回数据
  const data = userBindings.map((q) => {
    const activity = findActivityByFlexibleId(q.activityId);
    return {
      activityId: q.activityId,
      activityName: activity ? activity.name : '',
      braceletId: q.braceletId || q['手环编号'] || '',
      queueNumber: String(q.queueNumber || q['号码'] || ''),
      status: q.status,
      claimedAt: q.claimedAt,
      userScanBoundAt: q.userScanBoundAt || q.claimedAt,
      createdAt: q.createdAt
    };
  });
  
  res.json({ success: true, data });
});

/** 小程序「我的绑定」：当日已叫号（与 queueMatchesUserAsCustomer 一致；calledAt 落在当天 0:00～24:00，服务器本地时区） */
app.get(['/api/wechat/my-called-today', '/api/wechat/my-customer-called-today'], (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: '未授权' });
  }
  const sessionUser = Object.values(wechatUsers).find((u) => u.token === token);
  if (!sessionUser || !sessionUser.openid) {
    return res.status(401).json({ success: false, error: '用户不存在或已过期' });
  }
  const qOpenid = String(req.query.openid || '').trim() || String(sessionUser.openid);
  if (String(sessionUser.openid) !== qOpenid) {
    return res.status(403).json({
      success: false,
      error: 'openid 与当前登录不一致，请重新进入小程序或下拉刷新'
    });
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const endMs = start.getTime() + 86400000;

  const rows = queues.filter((q) => {
    if (q.status !== 'called') return false;
    if (!q.calledAt) return false;
    const t = new Date(q.calledAt).getTime();
    if (Number.isNaN(t) || t < start.getTime() || t >= endMs) return false;
    return queueMatchesUserAsCustomer(q, qOpenid);
  });
  const data = rows
    .map((q) => {
      const activity = findActivityByFlexibleId(q.activityId);
      return {
        activityId: q.activityId,
        activityName: activity ? activity.name : '',
        braceletId: q.braceletId || q['手环编号'] || '',
        queueNumber: String(q.queueNumber || q['号码'] || ''),
        status: q.status,
        calledAt: q.calledAt,
        userScanBoundAt: q.userScanBoundAt || q.claimedAt,
        /** 与历史小程序字段对齐，等同 userScanBoundAt（扫码领取时间） */
        claimedAt: q.userScanBoundAt || q.claimedAt
      };
    })
    .sort((a, b) => new Date(b.calledAt) - new Date(a.calledAt));
  res.json({ success: true, data });
});

// 获取用户的手环绑定列表（小程序端用）
// query:
//   scope=customer — 与后台 asCustomer 一致（queueMatchesUserAsCustomer）；若带 Bearer 则以 token 内 openid 为准
//   不传 scope — userId/openid 命中的全部排队（首页「是否有绑定」等）；bindingKind 区分展示
app.get('/api/wechat/user-bindings', (req, res) => {
  let { openid, scope } = req.query;
  const scopeStr = String(scope || '').trim();

  if (scopeStr === 'customer') {
    const token = readBearerToken(req);
    if (token) {
      const sessionUser = Object.values(wechatUsers).find((u) => u.token === token);
      if (sessionUser && sessionUser.openid) {
        openid = sessionUser.openid;
      }
    }
  }

  if (!openid) {
    return res.status(400).json({ error: '缺少openid参数' });
  }

  let userBindings;
  if (scopeStr === 'customer') {
    userBindings = queues.filter((q) => queueMatchesUserAsCustomer(q, openid));
  } else {
    userBindings = queues.filter((q) => q.userId === openid || q.openid === openid);
  }

  const data = serializeWechatUserBindingsRows(userBindings, openid, scopeStr);
  res.json({ success: true, data });
});

// 通过openid获取用户的绑定信息
app.get('/api/queue/bindings/:openid', (req, res) => {
  const { openid } = req.params;
  
  const bindings = queues.filter(
    (q) =>
      (q.userId === openid || q.openid === openid) &&
      (q.status === 'waiting' || q.status === 'claimed')
  );
  
  if (bindings.length === 0) {
    return res.json({ success: true, bindings: [] });
  }
  
  // 返回最新的绑定信息
  const latestBinding = bindings[bindings.length - 1];
  const activity = activities.find(a => a._id === latestBinding.activityId);
  
  res.json({
    success: true,
    binding: {
      activityId: latestBinding.activityId,
      activityName: activity ? activity.name : '',
      braceletId: queueBraceletKey(latestBinding),
      number: queueNumberRaw(latestBinding),
      status: latestBinding.status,
      createdAt: latestBinding.createdAt
    }
  });
});

process.on('uncaughtException', (err) => {
  try {
    systemLogger.error('process', 'uncaughtException', {
      message: err && err.message,
      stack: err && err.stack && String(err.stack).slice(0, 3000)
    });
  } catch (_) {
    /* ignore */
  }
  console.error('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  try {
    const msg =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack || ''}`.slice(0, 3000)
        : String(reason).slice(0, 2000);
    systemLogger.error('process', 'unhandledRejection', { message: msg });
  } catch (_) {
    /* ignore */
  }
  console.error('unhandledRejection', reason);
});

app.listen(PORT, LISTEN_HOST, () => {
  ensureActivitiesReferencedByQueues();
  console.log(`[本机]   http://localhost:${PORT}/admin/`);
  console.log(`[局域网] http://${LAN_IPV4}:${PORT}/admin/`);
  console.log(`[API]    http://localhost:${PORT}/api  |  http://${LAN_IPV4}:${PORT}/api`);
  console.log('默认管理员: admin / admin123');
  console.log('数据存储目录:', DATA_DIR);
});