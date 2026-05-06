// test-login/index.js - 微信登录测试页面
const app = getApp();

Page({
  data: {
    loginStatus: '未登录',
    openid: '',
    token: '',
    userInfo: null,
    loading: false
  },

  onLoad() {
    this.checkLoginStatus();
  },

  // 检查登录状态
  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo.openid) {
      this.setData({
        loginStatus: '已登录',
        openid: userInfo.openid,
        token: userInfo.token || '',
        userInfo: userInfo
      });
    }
  },

  // 重新登录
  reLogin() {
    this.setData({ loading: true });
    
    // 清除缓存
    wx.removeStorageSync('userInfo');
    app.globalData.openid = null;
    app.globalData.token = null;
    app.globalData.userInfo = null;
    
    // 重新获取用户信息
    app.getWechatUserInfo();
    
    setTimeout(() => {
      this.checkLoginStatus();
      this.setData({ loading: false });
    }, 2000);
  },

  // 查看全局数据
  showGlobalData() {
    console.log('全局用户信息:', app.globalData);
    wx.showModal({
      title: '全局数据',
      content: JSON.stringify(app.globalData, null, 2),
      showCancel: false
    });
  },

  // 复制openid
  copyOpenid() {
    if (this.data.openid) {
      wx.setClipboardData({
        data: this.data.openid,
        success: () => {
          wx.showToast({
            title: '已复制',
            icon: 'success'
          });
        }
      });
    }
  }
})
