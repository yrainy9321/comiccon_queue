// status.js
const app = getApp();

Page({
  data: {
    activityId: '',
    activityName: '',
    currentNumber: 0,
    userNumber: 0,
    queueCount: 0,
    estimatedTime: 0,
    braceletId: ''
  },

  onLoad(options) {
    this.setData({ 
      activityId: options.activityId,
      braceletId: options.braceletId 
    });
    this.loadActivityInfo();
  },

  loadActivityInfo() {
    wx.request({
      url: app.globalData.API_URL + `/activities/${this.data.activityId}`,
      method: 'GET',
      success: (res) => {
        if (res.statusCode === 200) {
          this.setData({ activityName: res.data.name });
        }
      }
    });
    this.refreshStatus();
  },

  refreshStatus() {
    wx.request({
      url: app.globalData.API_URL + `/queue/status/${this.data.activityId}`,
      method: 'GET',
      success: (res) => {
        if (res.statusCode === 200) {
          const data = res.data;
          this.setData({
            currentNumber: data.currentNumber || 0,
            queueCount: data.queueCount || 0,
            estimatedTime: Math.round((data.queueCount || 0) * 3) // 假设每个号3分钟
          });
        }
      },
      fail: () => {
        wx.showToast({ title: '刷新失败', icon: 'none' });
      }
    });
    
    // 获取用户的排队号码
    if (this.data.braceletId) {
      this.getUserNumber();
    }
  },

  getUserNumber() {
    wx.request({
      url: app.globalData.API_URL + `/queue/user/${this.data.activityId}/${this.data.braceletId}`,
      method: 'GET',
      success: (res) => {
        if (res.statusCode === 200 && res.data) {
          this.setData({
            userNumber: res.data.号码 || 0
          });
        }
      }
    });
  }
})