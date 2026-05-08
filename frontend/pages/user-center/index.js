// pages/user-center/index.js
const app = getApp();

/** 将数据库中的头像路径转为小程序 <image> 可用的完整 URL */
function resolveAvatarDisplayUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('wxfile://') || t.indexOf('http://tmp/') === 0) return t;
  const api = String(app.globalData.API_URL || '').replace(/\/$/, '');
  const origin = api.replace(/\/api$/i, '');
  if (!origin) return t;
  if (t.startsWith('/')) return `${origin}${t}`;
  return `${origin}/${t.replace(/^\//, '')}`;
}

Page({
  data: {
    userName: '',
    userId: '',
    avatarUrl: '',
    // 隐藏功能：登记手环、叫号验证
    showStaffMenu: false,
    avatarClickCount: 0,
    idClickCount: 0,
    lastClickTime: 0,
    avatarClickedTwice: false // 标记是否已完成头像的2次点击
  },

  onLoad() {
    this.loadUserInfo();
  },

  onShow() {
    // 从服务端同步昵称、头像、员工标记（覆盖本地过期 wxfile 路径）
    this.refreshProfileFromServer();
  },

  loadUserInfo() {
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      this.setData({
        userName: userInfo.nickName || '',
        userId: userInfo.openid || '',
        avatarUrl: resolveAvatarDisplayUrl(userInfo.avatarUrl) || ''
      });
    }
  },

  /** 拉取数据库中的用户资料并更新展示与本地缓存 */
  async refreshProfileFromServer() {
    try {
      await app.getUserInfo();
    } catch (e) {
      console.warn('getUserInfo', e);
    }
    const cached = wx.getStorageSync('userInfo') || {};
    const token = app.globalData.token || cached.token || '';
    if (!token) return;

    try {
      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.API_URL}/wechat/user`,
          method: 'GET',
          header: { Authorization: `Bearer ${token}` },
          dataType: 'json',
          timeout: 12000,
          success: resolve,
          fail: reject
        });
      });

      if (res.statusCode !== 200 || !res.data || !res.data.success) {
        return;
      }

      const d = res.data;
      const displayAvatar = resolveAvatarDisplayUrl(d.avatarDisplayUrl || d.avatarUrl);
      const merged = {
        ...cached,
        openid: d.openid || cached.openid,
        nickName: d.nickName != null ? d.nickName : cached.nickName,
        avatarUrl: d.avatarUrl != null ? d.avatarUrl : cached.avatarUrl,
        token: cached.token || app.globalData.token
      };
      wx.setStorageSync('userInfo', merged);
      if (app.globalData.userInfo) {
        app.globalData.userInfo = { ...app.globalData.userInfo, ...merged };
      }

      this.setData({
        userName: merged.nickName || '',
        userId: merged.openid || '',
        avatarUrl: displayAvatar
      });
    } catch (err) {
      const em = (err && err.errMsg) || '';
      console.error(
        '同步用户资料失败',
        em,
        '→ 真机请改 frontend/config.js 中 API_URL 为电脑局域网 IP，并与手机同一 Wi‑Fi'
      );
    }
  },

  // 重置所有点击状态
  resetClickState() {
    this.setData({
      avatarClickCount: 0,
      idClickCount: 0,
      lastClickTime: 0,
      avatarClickedTwice: false
    });
  },

  // 头像点击处理（隐藏功能入口）- 无感触发
  handleAvatarClick() {
    const now = Date.now();
    const { avatarClickCount, lastClickTime, showStaffMenu } = this.data;

    if (showStaffMenu) {
      return;
    }

    if (now - lastClickTime > 3000) {
      this.setData({
        avatarClickCount: 1,
        idClickCount: 0,
        avatarClickedTwice: false,
        lastClickTime: now
      });
      return;
    }

    const newCount = avatarClickCount + 1;
    this.setData({ avatarClickCount: newCount, lastClickTime: now });

    if (newCount === 2) {
      this.setData({
        avatarClickCount: 0,
        avatarClickedTwice: true
      });
    }
  },

  // ID 点击处理（隐藏功能入口）- 无感触发
  handleIdClick() {
    const now = Date.now();
    const { showStaffMenu, avatarClickedTwice } = this.data;
    let { idClickCount, lastClickTime } = this.data;

    if (showStaffMenu) {
      return;
    }

    if (!avatarClickedTwice) {
      return;
    }

    // 已完成头像阶段后：超时只清空 ID 连点计数，不撤销头像阶段（避免稍停顿就无法触发员工校验）
    if (now - lastClickTime > 3000) {
      idClickCount = 0;
    }

    const nextIdCount = idClickCount + 1;
    this.setData({ idClickCount: nextIdCount, lastClickTime: now });

    if (nextIdCount === 2) {
      this.checkStaffStatus();
    }
  },

  // 校验员工身份（无感）
  async checkStaffStatus() {
    try {
      await app.getUserInfo();
      const cached = wx.getStorageSync('userInfo') || {};
      const token = app.globalData.token || cached.token || '';
      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.API_URL}/wechat/user/staff-check`,
          method: 'GET',
          dataType: 'json',
          timeout: 12000,
          header: token ? { Authorization: `Bearer ${token}` } : {},
          success: resolve,
          fail: reject
        });
      });

      if (res.statusCode === 200 && res.data && res.data.success && res.data.isStaff) {
        this.setData({ showStaffMenu: true });
      } else {
        console.warn(
          '[staff-check] 未通过',
          'http',
          res.statusCode,
          res.data
        );
      }
    } catch (error) {
      console.error('员工身份校验失败:', error);
    }

    this.resetClickState();
  },

  goToStaffCenter() {
    wx.navigateTo({
      url: '/pages/staff-center/index'
    });
  },

  goToQueueVerify() {
    wx.navigateTo({
      url: '/pages/queue-verify/index'
    });
  },

  goToMyBindings() {
    wx.navigateTo({
      url: '/pages/my-bindings/index'
    });
  },

  goToHistory() {
    wx.showToast({
      title: '功能开发中',
      icon: 'none'
    });
  },

  goToSettings() {
    wx.showToast({
      title: '功能开发中',
      icon: 'none'
    });
  },

  goToAbout() {
    wx.navigateTo({
      url: '/pages/about/index'
    });
  },

  logout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出登录吗？',
      confirmColor: '#07c160',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('token');
          wx.removeStorageSync('userInfo');
          wx.removeStorageSync('bindingInfo');

          app.globalData.userInfo = null;
          app.globalData.token = null;
          app.globalData.openid = null;
          app.globalData.unionid = null;
          app.globalData.hasAuth = false;
          app.globalData._wechatLoginPromise = null;

          wx.showLoading({ title: '正在重新登录…', mask: true });
          app
            .getWechatUserInfo()
            .catch(() => {})
            .finally(() => {
              wx.hideLoading();
              wx.reLaunch({ url: '/pages/index/index' });
            });
        }
      }
    });
  }
});
