// staff-center/index.js
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

function formatShortTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const M = d.getMonth() + 1;
    const D = d.getDate();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${M}/${D} ${h}:${m}`;
  } catch (e) {
    return '';
  }
}

Page({
  data: {
    // 活动列表（picker 的 range 只能是字符串数组，不能在 wxml 里写 .map）
    activities: [],
    activityNames: [],
    selectedActivityId: '',
    selectedActivityName: '',
    /** 自动递增模式下展示的「下一个排队码」 */
    nextAutoQueueCode: '',
    
    // 手环编码
    braceletCode: '',
    
    // 排队码
    queueCode: '',
    lastQueueCode: '', // 记录上次绑定的排队码，用于自动递增
    /** 排队码方式：与 queueModeIndex 同步，custom | auto */
    inputMode: 'custom',
    queueModeLabels: ['自定义', '自动递增'],
    queueModeIndex: 0,
    queueModeDisplay: '自定义',
    
    // 按钮状态
    isScanning: false,
    isSubmitting: false,

    // 最近绑定（仅本人）
    recentBindings: [],
    recentLoading: false
  },

  async onLoad() {
    try {
      await app.getUserInfo();
    } catch (e) {
      console.warn('getUserInfo:', e);
    }
    this.setData({
      inputMode: 'custom',
      queueModeIndex: 0,
      queueModeDisplay: this.data.queueModeLabels[0],
      queueCode: ''
    });
    this.loadLastQueueCode();
    this.loadActivities();
    this.loadRecentBindings();
  },

  onShow() {
    this.loadRecentBindings();
  },

  // 员工端专用接口：后台校验 token + isStaff 后返回已启用活动
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
          fail: (err) => reject(err)
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
        console.warn('[staff] 活动列表 HTTP', res.statusCode, res.data);
        wx.showToast({
          title: (res.data && res.data.message) || `请求失败(${res.statusCode})`,
          icon: 'none'
        });
        return;
      }

      const body = res.data;
      if (!body || !body.success) {
        console.warn('[staff] 活动列表响应异常', body);
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

  // 加载上次绑定的排队码（用于自动递增）
  loadLastQueueCode() {
    const lastCode = wx.getStorageSync('lastQueueCode');
    if (lastCode) {
      const n = parseInt(String(lastCode), 10);
      this.setData({
        lastQueueCode: lastCode,
        nextAutoQueueCode: Number.isNaN(n) ? '' : String(n + 1)
      });
    }
  },

  // 选择活动
  selectActivity(e) {
    const index = e.detail.value;
    const activity = this.data.activities[index];
    if (activity) {
      const activityId = activity._id || activity.id;
      this.setData({
        selectedActivityId: activityId,
        selectedActivityName: activity.name
      });
    }
  },

  // 扫码识别手环编码
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
          isScanning: false
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

  // 手动输入手环编码
  inputBraceletCode(e) {
    this.setData({
      braceletCode: e.detail.value
    });
  },

  // 排队码方式：picker 单列二选一，默认 index 0 = 自定义
  onQueueModePick(e) {
    const idx = Number(e.detail.value);
    const labels = this.data.queueModeLabels;
    const mode = idx === 0 ? 'custom' : 'auto';
    const patch = {
      queueModeIndex: idx,
      queueModeDisplay: labels[idx] || labels[0],
      inputMode: mode,
      queueCode: ''
    };
    if (mode === 'auto' && this.data.lastQueueCode) {
      const n = parseInt(String(this.data.lastQueueCode), 10);
      patch.queueCode = Number.isNaN(n) ? '' : String(n + 1);
    }
    this.setData(patch);
  },

  // 输入排队码（自定义模式）
  inputQueueCode(e) {
    if (this.data.inputMode === 'custom') {
      this.setData({
        queueCode: e.detail.value
      });
    }
  },

  loadRecentBindings() {
    const cached = wx.getStorageSync('userInfo') || {};
    const token = app.globalData.token || cached.token || '';
    if (!token) {
      this.setData({ recentBindings: [], recentLoading: false });
      return;
    }
    this.setData({ recentLoading: true });
    wx.request({
      url: `${app.globalData.API_URL}/wechat/staff/recent-bindings`,
      method: 'GET',
      timeout: 12000,
      dataType: 'json',
      header: { Authorization: `Bearer ${token}` },
      success: (res) => {
        if (res.statusCode !== 200 || !res.data || !res.data.success) {
          this.setData({ recentBindings: [], recentLoading: false });
          return;
        }
        const rows = Array.isArray(res.data.data) ? res.data.data : [];
        const recentBindings = rows.map((row, idx) => ({
          ...row,
          rowKey: `${row.id || ''}_${row.braceletId || ''}_${idx}`,
          statusText: statusLabel(row.status),
          staffTimeText: formatShortTime(row.staffRegisteredAt) || '—',
          userBindText: row.userScanBoundAt
            ? formatShortTime(row.userScanBoundAt)
            : row.status === 'waiting'
              ? '未扫码'
              : '—'
        }));
        this.setData({ recentBindings, recentLoading: false });
      },
      fail: () => {
        this.setData({ recentBindings: [], recentLoading: false });
      }
    });
  },

  unbindRecent(e) {
    const id = String((e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || '');
    if (!id) return;
    const cached = wx.getStorageSync('userInfo') || {};
    const token = app.globalData.token || cached.token || '';
    if (!token) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认解绑',
      content: '确定要解绑该手环吗？',
      success: (r) => {
        if (!r.confirm) return;
        wx.request({
          url: `${app.globalData.API_URL}/wechat/staff/recent-bindings/${encodeURIComponent(id)}`,
          method: 'DELETE',
          timeout: 12000,
          dataType: 'json',
          header: { Authorization: `Bearer ${token}` },
          success: (res) => {
            if (res.statusCode === 200 && res.data && res.data.success) {
              wx.showToast({ title: '解绑成功', icon: 'success' });
              this.loadRecentBindings();
              return;
            }
            wx.showToast({
              title: (res.data && (res.data.message || res.data.error)) || '解绑失败',
              icon: 'none'
            });
          },
          fail: () => {
            wx.showToast({ title: '网络异常', icon: 'none' });
          }
        });
      }
    });
  },

  // 确认登记
  async confirmBinding() {
    const { selectedActivityId, braceletCode, queueCode } = this.data;
    
    // 验证输入
    if (!selectedActivityId) {
      wx.showToast({
        title: '请选择活动',
        icon: 'none'
      });
      return;
    }
    
    if (!braceletCode) {
      wx.showToast({
        title: '请扫描或输入手环编码',
        icon: 'none'
      });
      return;
    }

    const bc = validateBraceletIdStrictMg27(braceletCode);
    if (!bc.ok) {
      wx.showToast({ title: bc.error, icon: 'none', duration: 2800 });
      return;
    }

    if (this.data.inputMode !== 'custom' && this.data.inputMode !== 'auto') {
      wx.showToast({ title: '请选择排队码方式', icon: 'none' });
      return;
    }

    if (!queueCode) {
      wx.showToast({
        title: this.data.inputMode === 'auto' ? '自动递增需先有上次排队码，请先自定义绑定一次' : '请输入排队码',
        icon: 'none'
      });
      return;
    }
    
    this.setData({ isSubmitting: true });
    
    try {
      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.API_URL}/wechat/user/bind-manual`,
          method: 'POST',
          timeout: 12000,
          header: {
            'Authorization': 'Bearer ' + app.globalData.token,
            'Content-Type': 'application/json'
          },
          data: {
            activityId: selectedActivityId,
            braceletCode: bc.value,
            queueCode: queueCode
          },
          success: resolve,
          fail: reject
        });
      });
      
      if (res.data.success) {
        wx.showToast({
          title: '绑定成功',
          icon: 'success'
        });
        this.loadRecentBindings();

        // 保存当前排队码用于下次自动递增
        const n = parseInt(String(queueCode), 10);
        this.setData({
          lastQueueCode: queueCode,
          nextAutoQueueCode: Number.isNaN(n) ? '' : String(n + 1)
        });
        wx.setStorageSync('lastQueueCode', queueCode);
        
        // 如果是自动模式，自动填充下一个号码
        if (this.data.inputMode === 'auto') {
          const nextCode = parseInt(queueCode) + 1;
          this.setData({
            queueCode: nextCode.toString(),
            braceletCode: ''
          });
        } else {
          // 重置表单
          this.setData({
            braceletCode: '',
            queueCode: ''
          });
        }
      } else {
        wx.showToast({
          title: res.data.message || '绑定失败',
          icon: 'none'
        });
      }
    } catch (error) {
      console.error('绑定失败:', error);
      wx.showToast({
        title: '绑定失败',
        icon: 'none'
      });
    } finally {
      this.setData({ isSubmitting: false });
    }
  },

});