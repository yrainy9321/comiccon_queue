// bind.js
const app = getApp();

Page({
  data: {
    activities: [],
    activityIndex: 0,
    selectedActivity: null,
    braceletId: '',
    modes: ['顺序', '随机'],
    modeIndex: 0,
    randomNumber: ''
  },

  onLoad(options) {
    if (options.activityId) {
      this.loadActivities(options.activityId);
    } else {
      this.loadActivities();
    }
  },

  // 扫码功能
  scanCode() {
    wx.scanCode({
      success: (res) => {
        console.log('扫码结果:', res.result);
        // 解析二维码内容
        // 假设二维码格式：activityId,braceletId
        const qrContent = res.result;
        const parts = qrContent.split(',');
        
        if (parts.length >= 2) {
          const activityId = parts[0];
          const braceletId = parts[1];
          this.bindBraceletWithInfo(activityId, braceletId);
        } else {
          wx.showToast({ title: '二维码格式错误', icon: 'none' });
        }
      },
      fail: (err) => {
        console.error('扫码失败:', err);
        wx.showToast({ title: '扫码失败', icon: 'none' });
      }
    });
  },

  // 使用扫码信息绑定
  bindBraceletWithInfo(activityId, braceletId) {
    wx.showLoading({ title: '绑定中...' });
    
    app.getUserInfo().then(userInfo => {
      const openid = userInfo ? userInfo.openid : null;
      
      wx.request({
        url: app.globalData.API_URL + '/queue/bind',
        method: 'POST',
        data: {
          activityId: activityId,
          手环编号: braceletId,
          mode: 'auto',
          userId: openid,
          openid: openid
        },
        header: {
          'Authorization': `Bearer ${app.globalData.token}`
        },
        success: (res) => {
          wx.hideLoading();
          
          if (res.statusCode === 200) {
            wx.showToast({ 
              title: '绑定成功', 
              icon: 'success',
              duration: 2000,
              success: () => {
                setTimeout(() => {
                  wx.redirectTo({
                    url: `/pages/status/index?activityId=${activityId}&braceletId=${braceletId}`
                  });
                }, 1000);
              }
            });
          } else {
            wx.showToast({ title: res.data.error || '绑定失败', icon: 'none' });
          }
        },
        fail: () => {
          wx.hideLoading();
          wx.showToast({ title: '网络错误', icon: 'none' });
        }
      });
    }).catch(err => {
      wx.hideLoading();
      console.error('获取用户信息失败:', err);
      wx.showToast({ title: '初始化失败', icon: 'none' });
    });
  },

  loadActivities(selectedId) {
    wx.request({
      url: app.globalData.API_URL + '/activities',
      method: 'GET',
      success: (res) => {
        if (res.statusCode === 200) {
          this.setData({ activities: res.data });
          if (selectedId) {
            const index = res.data.findIndex(a => a._id === selectedId);
            if (index !== -1) {
              this.setData({ activityIndex: index, selectedActivity: res.data[index] });
            }
          }
        }
      },
      fail: () => {
        wx.showToast({ title: '加载活动失败', icon: 'none' });
      }
    });
  },

  bindActivityChange(e) {
    const index = e.detail.value;
    this.setData({ 
      activityIndex: index, 
      selectedActivity: this.data.activities[index] 
    });
  },

  bindModeChange(e) {
    const index = e.detail.value;
    this.setData({ modeIndex: index });
    if (index === 1) { // 随机模式
      this.generateRandom();
    }
  },

  inputBraceletId(e) {
    this.setData({ braceletId: e.detail.value });
  },

  generateRandom() {
    const random = Math.floor(Math.random() * 1000) + 1;
    this.setData({ randomNumber: random });
  },

  bindBracelet() {
    if (!this.data.selectedActivity) {
      wx.showToast({ title: '请选择活动', icon: 'none' });
      return;
    }
    if (!this.data.braceletId) {
      wx.showToast({ title: '请输入手环编号', icon: 'none' });
      return;
    }

    const data = {
      activityId: this.data.selectedActivity._id,
      braceletId: this.data.braceletId,
      mode: this.data.modeIndex === 0 ? 'sequential' : 'random'
    };
    
    if (this.data.modeIndex === 1) {
      data.randomNumber = this.data.randomNumber;
    }

    // 先绑定手环到微信用户（用于消息推送）
    this.bindBraceletToWechat(() => {
      // 然后绑定排队
      wx.request({
        url: app.globalData.API_URL + '/queue/bind',
        method: 'POST',
        data: data,
        success: (res) => {
          if (res.statusCode === 200) {
            wx.showToast({ 
              title: '绑定成功', 
              icon: 'success',
              duration: 2000,
              success: () => {
                setTimeout(() => {
                  wx.navigateTo({
                    url: `/pages/status/index?activityId=${this.data.selectedActivity._id}&braceletId=${this.data.braceletId}`
                  });
                }, 1000);
              }
            });
          } else {
            wx.showToast({ title: res.data.error || '绑定失败', icon: 'none' });
          }
        },
        fail: () => {
          wx.showToast({ title: '网络错误', icon: 'none' });
        }
      });
    });
  },

  // 绑定手环到微信用户（用于接收消息推送）
  bindBraceletToWechat(callback) {
    app.getUserInfo().then(userInfo => {
      if (!userInfo || !userInfo.token) {
        console.log('未获取到微信用户信息，跳过手环绑定');
        if (callback) callback();
        return;
      }

      wx.request({
        url: app.globalData.API_URL + '/wechat/bind-bracelet',
        method: 'POST',
        header: {
          'Authorization': `Bearer ${userInfo.token}`
        },
        data: {
          braceletId: this.data.braceletId
        },
        success: (res) => {
          if (res.statusCode === 200 && res.data.success) {
            console.log('手环已绑定到微信用户，将接收消息推送');
          } else {
            console.log('手环绑定微信失败:', res.data);
          }
          if (callback) callback();
        },
        fail: (err) => {
          console.error('手环绑定微信请求失败:', err);
          if (callback) callback();
        }
      });
    }).catch(err => {
      console.error('获取用户信息失败:', err);
      if (callback) callback();
    });
  }
})