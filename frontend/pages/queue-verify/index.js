// queue-verify/index.js
const app = getApp();
const { validateBraceletIdStrictMg27 } = require('../../utils/braceletId.js');

function statusLabel(status) {
  const m = {
    waiting: '待发放给用户',
    claimed: '用户已扫码绑定',
    called: '已叫号入场'
  };
  return m[status] || status || '—';
}

function formatCalledTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${M}-${D} ${h}:${m}:${s}`;
  } catch (e) {
    return '';
  }
}

/** 兼容部分环境下 res.data 为字符串或未解析 JSON */
function parseResponseData(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return {};
    try {
      return JSON.parse(s);
    } catch (e) {
      return {};
    }
  }
  return {};
}

function pickServerMessage(body, fallback) {
  if (!body || typeof body !== 'object') return fallback;
  if (body.message != null && String(body.message).trim() !== '') {
    return String(body.message);
  }
  if (body.error != null && String(body.error).trim() !== '') {
    return String(body.error);
  }
  return fallback;
}

function buildVerifyOk(dataFragment) {
  return {
    success: true,
    headerClass: 'success',
    headerIcon: '✓',
    headerTitle: '查询成功',
    data: dataFragment,
    message: '',
    msgClass: ''
  };
}

/** 业务上无排队记录，不算「接口报错」 */
function buildVerifyNotFound(msg) {
  return {
    success: false,
    notFound: true,
    headerClass: 'neutral',
    headerIcon: 'ⓘ',
    headerTitle: '未查到记录',
    data: null,
    message: msg,
    msgClass: 'is-muted'
  };
}

function buildVerifyError(msg) {
  return {
    success: false,
    notFound: false,
    headerClass: 'error',
    headerIcon: '✗',
    headerTitle: '验证失败',
    data: null,
    message: msg,
    msgClass: 'is-error'
  };
}

Page({
  data: {
    activities: [],
    activityNames: [],
    selectedActivityId: '',
    selectedActivityName: '',

    braceletCode: '',
    isScanning: false,
    isSubmitting: false,
    verifyResult: null
  },

  onLoad() {
    try {
      app.getUserInfo();
    } catch (e) {
      console.warn('getUserInfo:', e);
    }
    this.loadActivities();
  },

  async loadActivities() {
    try {
      const cached = wx.getStorageSync('userInfo') || {};
      const token = app.globalData.token || cached.token || '';
      const base = String(app.globalData.API_URL || '').replace(/\/$/, '');
      const url = `${base}/wechat/staff/enabled-activities`;
      const res = await new Promise((resolve, reject) => {
        wx.request({
          url,
          method: 'GET',
          dataType: 'json',
          timeout: 12000,
          header: token ? { Authorization: `Bearer ${token}` } : {},
          success: resolve,
          fail: reject
        });
      });

      if (res.statusCode === 401 || res.statusCode === 404) {
        wx.showToast({
          title: (res.data && res.data.message) || '请先登录',
          icon: 'none'
        });
        return;
      }
      if (res.statusCode === 403) {
        wx.showToast({
          title: (res.data && res.data.message) || '非员工账号',
          icon: 'none'
        });
        return;
      }
      if (res.statusCode !== 200) {
        console.warn('[queue-verify] 活动列表 HTTP', res.statusCode, res.data);
        wx.showToast({
          title: (res.data && res.data.message) || `请求失败(${res.statusCode})`,
          icon: 'none'
        });
        return;
      }

      const body = res.data;
      if (!body || !body.success) {
        wx.showToast({ title: (body && body.message) || '加载活动失败', icon: 'none' });
        return;
      }
      const list = Array.isArray(body.data) ? body.data : [];
      const activityNames = list.map((a) => a.name);
      this.setData({
        activities: list,
        activityNames
      });
      if (activityNames.length === 0) {
        wx.showToast({ title: '暂无已启用活动', icon: 'none' });
      }
    } catch (error) {
      console.error('加载活动列表失败:', error);
      const msg = (error && (error.errMsg || error.message)) || '';
      const hint =
        msg.indexOf('domain') >= 0 || msg.indexOf('合法域名') >= 0
          ? '请在开发者工具中勾选不校验合法域名，或配置 request 域名'
          : msg.indexOf('fail') >= 0
            ? '无法连接服务器，请检查 API 地址与网络'
            : '加载活动失败';
      wx.showToast({ title: hint, icon: 'none', duration: 2800 });
    }
  },

  selectActivity(e) {
    const index = parseInt(String(e.detail.value), 10);
    if (Number.isNaN(index) || index < 0) return;
    const activity = this.data.activities[index];
    if (activity) {
      const activityId = activity._id || activity.id;
      this.setData({
        selectedActivityId: activityId,
        selectedActivityName: activity.name,
        verifyResult: null
      });
    }
  },

  inputBraceletCode(e) {
    this.setData({
      braceletCode: e.detail.value,
      verifyResult: null
    });
  },

  scanBracelet() {
    if (this.data.isScanning) return;

    this.setData({ isScanning: true });

    wx.scanCode({
      success: (res) => {
        const bc = validateBraceletIdStrictMg27(res.result);
        if (!bc.ok) {
          this.setData({ isScanning: false });
          wx.showToast({ title: bc.error, icon: 'none', duration: 2800 });
          return;
        }
        this.setData({
          braceletCode: bc.value,
          isScanning: false,
          verifyResult: null
        });
      },
      fail: (error) => {
        console.error('扫码失败:', error);
        this.setData({ isScanning: false });
        wx.showToast({
          title: '扫码失败',
          icon: 'none'
        });
      }
    });
  },

  async verifyQueue() {
    const { selectedActivityId, braceletCode } = this.data;

    if (!selectedActivityId) {
      wx.showToast({
        title: '请选择活动',
        icon: 'none'
      });
      return;
    }

    const bc = validateBraceletIdStrictMg27(braceletCode);
    if (!bc.ok) {
      wx.showToast({ title: bc.error, icon: 'none', duration: 2800 });
      return;
    }

    this.setData({ isSubmitting: true });

    try {
      const cached = wx.getStorageSync('userInfo') || {};
      const token = app.globalData.token || cached.token || '';

      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.API_URL}/wechat/staff/verify-queue`,
          method: 'POST',
          dataType: 'json',
          timeout: 12000,
          header: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          data: {
            activityId: selectedActivityId,
            braceletCode: bc.value
          },
          success: resolve,
          fail: reject
        });
      });

      const body = parseResponseData(res.data);

      if (res.statusCode === 401) {
        wx.showToast({ title: pickServerMessage(body, '请先登录'), icon: 'none' });
        this.setData({ isSubmitting: false });
        return;
      }

      if (res.statusCode === 403) {
        wx.showToast({ title: pickServerMessage(body, '非员工账号'), icon: 'none' });
        this.setData({ isSubmitting: false });
        return;
      }

      if (res.statusCode !== 200) {
        console.warn('[verify] HTTP', res.statusCode, res.data);
        const msg = pickServerMessage(body, `请求失败(${res.statusCode})`);
        this.setData({
          isSubmitting: false,
          verifyResult: buildVerifyError(msg)
        });
        return;
      }

      if (!body || typeof body !== 'object') {
        this.setData({
          isSubmitting: false,
          verifyResult: buildVerifyError('响应数据异常')
        });
        return;
      }

      if (!body.success) {
        const msg = pickServerMessage(body, '验证失败');
        const isNotFound = msg.indexOf('未找到') !== -1;
        this.setData({
          isSubmitting: false,
          verifyResult: isNotFound ? buildVerifyNotFound(msg) : buildVerifyError(msg)
        });
        return;
      }

      const data = body.data || {};
      const calledAt = data.calledAt || '';
      this.setData({
        isSubmitting: false,
        verifyResult: buildVerifyOk({
          activityName: data.activityName || '未命名活动',
          braceletCode: data.braceletCode || bc.value,
          queueNumber: data.queueNumber || '—',
          status: data.status || '',
          statusText: statusLabel(data.status),
          calledAtText:
            data.status === 'called' && calledAt
              ? formatCalledTime(calledAt)
              : data.status === 'called'
                ? '—'
                : '尚未叫号'
        })
      });
    } catch (error) {
      console.error('验证失败:', error);
      this.setData({
        isSubmitting: false,
        verifyResult: buildVerifyError('网络异常，验证失败')
      });
    }
  }
});
