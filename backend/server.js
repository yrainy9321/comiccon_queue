require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

app.use(cors());
app.use(express.json());
app.use('/admin', express.static(path.join(__dirname, '../admin')));
app.use(express.static(path.join(__dirname, '..')));

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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

let currentUser = null;

// 微信消息推送配置
const WECHAT_APPID = process.env.WECHAT_APPID || 'your_appid';
const WECHAT_SECRET = process.env.WECHAT_SECRET || 'your_secret';
const TEMPLATE_IDS = {
  REMINDER_5: process.env.WECHAT_TEMPLATE_REMINDER_5 || 'Ahead5ReminderTemplateId', // 还有5位提醒
  CALLED: process.env.WECHAT_TEMPLATE_CALLED || 'CalledTemplateId', // 叫号通知
  MISSED: process.env.WECHAT_TEMPLATE_MISSED || 'MissedTemplateId' // 过号通知
};

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

// 发送订阅消息
async function sendSubscribeMessage(openid, templateId, data, page = '/pages/status/index') {
  try {
    const accessToken = await getAccessToken();
    
    const response = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
      {
        touser: openid,
        template_id: templateId,
        page: page,
        data: data,
        miniprogram_state: 'formal' // formal-正式版, trial-体验版, developer-开发版
      }
    );
    
    if (response.data.errcode === 0) {
      console.log(`消息发送成功: openid=${openid}, template=${templateId}`);
      return true;
    } else {
      console.error(`消息发送失败:`, response.data);
      return false;
    }
  } catch (error) {
    console.error('发送订阅消息异常:', error.message);
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

// 发送叫号通知
// 模板字段: character_string1(当前叫号), thing10(温馨提醒), time6(到号时间), character_string2(您的排号)
async function sendCalledNotification(openid, currentNumber, userNumber) {
  const data = {
    character_string1: { value: String(currentNumber) }, // 当前叫号
    thing10: { value: '请您尽快前往办理' }, // 温馨提醒
    time6: { value: new Date().toLocaleString('zh-CN') }, // 到号时间
    character_string2: { value: String(userNumber) } // 您的排号
  };
  
  return await sendSubscribeMessage(openid, TEMPLATE_IDS.CALLED, data, '/pages/status/index');
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

// 检查并发送提前5位提醒
async function checkAndSendAhead5Reminder(activityId, currentNumber) {
  try {
    const targetNumber = currentNumber + 5;
    
    // 查找目标用户的排队记录
    const targetQueue = queues.find(q => 
      q.activityId === activityId && 
      q.号码 === targetNumber && 
      q.status === 'waiting' &&
      !q.reminderSent // 避免重复发送
    );
    
    if (targetQueue) {
      // 获取用户的openid
      const binding = braceletBindings[targetQueue.手环编号];
      
      if (binding && binding.openid) {
        const success = await sendAhead5Reminder(
          binding.openid,
          currentNumber, // 当前叫号
          targetQueue.号码, // 用户排号
          5 // 前方等候人数
        );
        
        if (success) {
          // 标记已发送提醒
          targetQueue.reminderSent = true;
          saveData('queues.json', queues);
          console.log(`已发送提前5位提醒: 手环=${targetQueue.手环编号}, 号码=${targetQueue.号码}`);
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
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  user.token = token;
  currentUser = user;

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, permissions: user.permissions }
  });
});

function validateToken(token) {
  return users.find(user => user.token === token);
}

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
  
  let filteredActivities;
  if (user && user.role === 'admin') {
    filteredActivities = activities;
  } else {
    filteredActivities = activities.filter(a => a.status !== 'deleted');
  }
  
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
    status: 'pending', 
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
  saveData('activities.json', activities);
  res.json({ success: true });
});

app.get('/api/activities/:id', (req, res) => {
  const activity = activities.find(a => a._id === req.params.id);
  if (!activity) return res.status(404).json({ error: '活动不存在' });
  res.json({
    _id: activity._id,
    name: activity.name,
    status: activity.status,
    currentNumber: activity.currentNumber
  });
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
  
  const statusNames = { active: '启用', inactive: '禁用', pending: '待审核' };
  const prevStatus = activity.status;
  
  activity.status = status;
  activity.updatedBy = user.username;
  activity.updatedAt = new Date();
  
  if (!activity.operationLogs) {
    activity.operationLogs = [];
  }
  activity.operationLogs.push({
    operator: user.username,
    operation: `状态变更`,
    timestamp: new Date(),
    detail: `状态从 "${statusNames[prevStatus] || prevStatus}" 变更为 "${statusNames[status] || status}"`
  });
  
  saveData('activities.json', activities);
  res.json({ success: true, activity });
});

app.get('/api/queues/:activityId', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  res.json(queues.filter(q => q.activityId === req.params.activityId));
});

app.get('/api/queues', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  res.json(queues);
});

app.post('/api/queue/bind', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const { activityId, 手环编号, mode, 号码, userId, openid } = req.body;
  if (!activityId || !手环编号 || !mode) return res.status(400).json({ error: '参数错误' });

  const activity = activities.find(a => a._id === activityId);
  if (!activity) return res.status(404).json({ error: '活动不存在' });

  let queueNumber;
  if (mode === 'auto') {
    queueNumber = activity.currentNumber + 1;
    activity.currentNumber = queueNumber;
    saveData('activities.json', activities);
  } else if (mode === 'manual') {
    if (!号码) return res.status(400).json({ error: '请输入号码' });
    queueNumber = 号码;
  } else {
    return res.status(400).json({ error: '无效的填入方式' });
  }

  // 保存userId用于后续查询用户绑定
  const queueUserId = userId || openid;
  
  const queue = { 
    _id: Date.now().toString(), 
    activityId, 
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
  const queue = queues.find(q => q.activityId === activityId && q.号码 === number);
  
  if (!queue) {
    return res.status(404).json({ error: '排队记录不存在' });
  }
  
  // 获取活动信息
  const activity = activities.find(a => a._id === activityId);
  const activityName = activity ? activity.name : '未知活动';
  
  // 检查是否过号（如果当前叫的号码比用户号码小很多，说明用户可能过号了）
  // 这里简单判断：如果当前号码已经超过用户号码+1，则认为过号
  const isMissed = activity.currentNumber > queue.号码 + 1 && queue.status !== 'called';
  
  // 更新状态为已叫号
  queue.status = 'called';
  queue.calledAt = new Date();
  queue.calledBy = user.username;
  saveData('queues.json', queues);
  
  // 获取用户的openid并发送消息
  try {
    const binding = braceletBindings[queue.手环编号];
    
    if (binding && binding.openid) {
      if (isMissed) {
        // 发送过号通知
        console.log(`发送过号通知: 手环=${queue.手环编号}, 号码=${queue.号码}`);
        await sendMissedNotification(binding.openid, activityName, queue.号码);
      } else {
        // 发送叫号通知
        console.log(`发送叫号通知: 手环=${queue.手环编号}, 号码=${queue.号码}`);
        await sendCalledNotification(binding.openid, activityName, queue.号码);
      }
    } else {
      console.log(`未找到手环 ${queue.手环编号} 绑定的微信用户`);
    }
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

app.get('/api/queue/status/:activityId', (req, res) => {
  const activity = activities.find(a => a._id === req.params.activityId);
  if (!activity) return res.status(404).json({ error: '活动不存在' });

  const queueCount = queues.filter(q => q.activityId === req.params.activityId && q.status === 'waiting').length;
  const lastCalled = queues.filter(q => q.activityId === req.params.activityId && q.status === 'called').pop();
  res.json({ currentNumber: activity.currentNumber, queueCount, lastCalled: lastCalled ? lastCalled.号码 : 0 });
});

app.delete('/api/queue/:id', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  const idx = queues.findIndex(q => q._id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '绑定不存在' });
  queues.splice(idx, 1);
  saveData('queues.json', queues);
  res.json({ success: true });
});

app.get('/api/users', (req, res) => {
  const token = req.headers.authorization;
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: '未授权' });
  }
  res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, permissions: u.permissions, createdAt: u.createdAt })));
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
  res.json(roles);
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
  const { activityId, braceletId } = req.params;
  const queue = queues.find(q => q.activityId === activityId && q.手环编号 === braceletId);
  if (!queue) return res.status(404).json({ error: '未找到绑定信息' });
  res.json(queue);
});

// 微信小程序登录 - 通过code获取openid
app.post('/api/wechat/login', async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: '缺少code参数' });
  }

  // 从环境变量或配置文件中读取（实际部署时需要配置）
  const APPID = process.env.WECHAT_APPID || 'your_appid';
  const SECRET = process.env.WECHAT_SECRET || 'your_secret';

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

    const { openid, session_key, errcode, errmsg } = response.data;

    if (errcode) {
      console.error('微信登录失败:', errcode, errmsg);
      return res.status(400).json({ 
        error: '微信登录失败', 
        code: errcode, 
        message: errmsg 
      });
    }

    // 保存用户信息到本地（首次登录时创建）
    if (!wechatUsers[openid]) {
      wechatUsers[openid] = {
        openid,
        createdAt: new Date(),
        lastLoginAt: new Date()
      };
      saveData('wechat_users.json', wechatUsers);
    } else {
      wechatUsers[openid].lastLoginAt = new Date();
      saveData('wechat_users.json', wechatUsers);
    }

    // 生成token用于后续请求验证
    const token = crypto.randomBytes(32).toString('hex');
    wechatUsers[openid].token = token;
    saveData('wechat_users.json', wechatUsers);

    res.json({
      success: true,
      openid,
      token,
      isNewUser: !Object.keys(wechatUsers[openid]).includes('createdAt') || 
                 (new Date(wechatUsers[openid].createdAt)).getTime() === (new Date(wechatUsers[openid].lastLoginAt)).getTime()
    });

  } catch (error) {
    console.error('微信登录异常:', error.message);
    res.status(500).json({ 
      error: '服务器错误', 
      message: '微信登录服务暂时不可用' 
    });
  }
});

// 获取当前用户信息
app.get('/api/wechat/user', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: '未授权' });
  }

  const user = Object.values(wechatUsers).find(u => u.token === token);
  
  if (!user) {
    return res.status(401).json({ error: '用户不存在或已过期' });
  }

  res.json({
    success: true,
    openid: user.openid,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  });
});

// ========== 后台管理API ==========

// 获取所有微信用户列表（后台管理用）
app.get('/api/wechat/users', (req, res) => {
  const token = req.headers.authorization;
  const adminUser = validateToken(token);
  
  if (!adminUser) {
    return res.status(401).json({ error: '未授权' });
  }

  // 构建用户列表，包含活动参与统计
  const userList = Object.values(wechatUsers).map(user => {
    // 统计该用户参与的活动数量
    const userBindings = queues.filter(q => q.openid === user.openid);
    const uniqueActivities = [...new Set(userBindings.map(q => q.activityId))];
    
    return {
      openid: user.openid,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      activityCount: uniqueActivities.length,
      bindingCount: userBindings.length
    };
  });

  // 按最后登录时间排序
  userList.sort((a, b) => new Date(b.lastLoginAt) - new Date(a.lastLoginAt));

  res.json({
    success: true,
    users: userList,
    total: userList.length
  });
});

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

  // 查找该用户的所有绑定记录
  const userBindings = queues.filter(q => q.openid === openid);
  
  // 构建活动详情列表
  const activitiesList = userBindings.map(binding => {
    const activity = activities.find(a => a._id === binding.activityId);
    return {
      activityId: binding.activityId,
      activityName: activity ? activity.name : '未知活动',
      braceletId: binding.手环编号,
      number: binding.号码,
      status: binding.status,
      boundAt: binding.createdAt,
      calledAt: binding.calledAt
    };
  });

  res.json({
    success: true,
    user: {
      openid: user.openid,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt
    },
    activities: activitiesList,
    total: activitiesList.length
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

  const { braceletId } = req.body;
  
  if (!braceletId) {
    return res.status(400).json({ error: '缺少手环编号' });
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

// 通过openid获取用户的绑定信息
app.get('/api/queue/bindings/:openid', (req, res) => {
  const { openid } = req.params;
  
  // 查找该用户的所有绑定记录（通过userId字段）
  const bindings = queues.filter(q => q.userId === openid && q.status === 'waiting');
  
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
      braceletId: latestBinding.手环编号,
      number: latestBinding.号码,
      status: latestBinding.status,
      createdAt: latestBinding.createdAt
    }
  });
});

app.listen(PORT, () => {
  console.log('服务器运行在 http://localhost:' + PORT);
  console.log('默认管理员: admin / admin123');
  console.log('数据存储目录:', DATA_DIR);
});