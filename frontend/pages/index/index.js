// index.js
const app = getApp();

Page({
  data: {
    userId: '',
    openid: '',
    hasBinding: false,
    activityName: '',
    braceletId: '',
    userNumber: 0,
    queueCount: 0,
    loading: true  // 添加加载状态
  },

  async onLoad() {
    // 显示加载提示
    wx.showLoading({ title: '初始化中...' });
    
    // 等待获取用户信息
    try {
      const userInfo = await app.getUserInfo();
      this.setData({ 
        userId: userInfo.openid,
        openid: userInfo.openid,
        loading: false,
        isTempId: userInfo.isTemp || false
      });
      console.log('用户信息已获取:', userInfo);
      
      // 隐藏加载提示
      wx.hideLoading();
      
      // 如果是临时ID，给出提示
      if (userInfo.isTemp) {
        console.warn('使用临时ID，部分功能可能受限');
      }
      
      // 检查用户是否有绑定
      this.checkUserBinding(userInfo.openid);
    } catch (error) {
      wx.hideLoading();
      console.error('获取用户信息异常:', error);
      this.setData({ loading: false });
      // 不显示错误提示，让用户可以继续使用
    }
  },

  // 检查用户是否有绑定
  checkUserBinding(openid) {
    wx.showLoading({ title: '加载中...' });
    
    wx.request({
      url: app.globalData.API_URL + `/queue/bindings/${openid}`,
      method: 'GET',
      success: (res) => {
        wx.hideLoading();
        
        if (res.statusCode === 200 && res.data.success) {
          if (res.data.binding) {
            // 用户有绑定，显示排队状态
            const binding = res.data.binding;
            this.setData({
              hasBinding: true,
              activityName: binding.activityName,
              braceletId: binding.braceletId,
              userNumber: binding.number
            });
            
            // 获取当前排队状态
            this.getQueueStatus(binding.activityId);
          } else {
            // 用户没有绑定，显示扫码按钮
            this.setData({ hasBinding: false });
          }
        } else {
          console.error('获取绑定信息失败:', res.data);
          this.setData({ hasBinding: false });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('请求失败:', err);
        this.setData({ hasBinding: false });
      }
    });
  },

  // 获取排队状态
  getQueueStatus(activityId) {
    wx.request({
      url: app.globalData.API_URL + `/queue/status/${activityId}`,
      method: 'GET',
      success: (res) => {
        if (res.statusCode === 200) {
          const data = res.data;
          const aheadCount = data.queueCount || 0;
          
          this.setData({
            queueCount: aheadCount
          });
        }
      },
      fail: (err) => {
        console.error('获取排队状态失败:', err);
      }
    });
  },

  scanCode() {
    wx.scanCode({
      success: (res) => {
        // 解析二维码内容
        // 假设二维码格式：activityId,braceletId
        const qrContent = res.result;
        const [activityId, braceletId] = qrContent.split(',');
        
        if (activityId && braceletId) {
          this.bindBracelet(activityId, braceletId);
        } else {
          wx.showToast({ title: '二维码格式错误', icon: 'none' });
        }
      },
      fail: () => {
        wx.showToast({ title: '扫码失败', icon: 'none' });
      }
    });
  },

  bindBracelet(activityId, braceletId) {
    const openid = this.data.openid || app.globalData.openid;
    
    if (!openid) {
      wx.showToast({ 
        title: '用户信息未就绪', 
        icon: 'none' 
      });
      return;
    }
    
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
        if (res.statusCode === 200) {
          wx.showToast({ 
            title: '绑定成功', 
            icon: 'success',
            duration: 2000,
            success: () => {
              // 重新检查绑定状态
              setTimeout(() => {
                this.checkUserBinding(openid);
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
  },

  // 刷新状态
  refreshStatus() {
    if (this.data.hasBinding && this.data.activityName) {
      wx.showLoading({ title: '刷新中...' });
      
      wx.request({
        url: app.globalData.API_URL + `/queue/bindings/${this.data.openid}`,
        method: 'GET',
        success: (res) => {
          wx.hideLoading();
          
          if (res.statusCode === 200 && res.data.success && res.data.binding) {
            this.getQueueStatus(res.data.binding.activityId);
          }
        },
        fail: () => {
          wx.hideLoading();
          wx.showToast({ title: '刷新失败', icon: 'none' });
        }
      });
    }
  }
})