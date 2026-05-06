// app.js
App({
  onLaunch() {
    console.log('App launched');
    // 应用启动时静默获取微信用户信息
    this.getWechatUserInfo();
  },
  
  globalData: {
    API_URL: 'http://localhost:3000/api',
    userInfo: null,
    openid: null,
    token: null
  },
  
  // 静默获取微信用户信息
  getWechatUserInfo() {
    const that = this;
    
    // 先检查本地是否有缓存的用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    if (cachedUserInfo && cachedUserInfo.openid && cachedUserInfo.token) {
      console.log('使用缓存的用户信息');
      that.globalData.userInfo = cachedUserInfo;
      that.globalData.openid = cachedUserInfo.openid;
      that.globalData.token = cachedUserInfo.token;
      return;
    }
    
    console.log('开始微信登录流程...');
    
    // 没有缓存，调用微信登录
    wx.login({
      success(res) {
        if (res.code) {
          console.log('获取到code:', res.code);
          
          // 将code发送到后端换取openid
          wx.request({
            url: that.globalData.API_URL + '/wechat/login',
            method: 'POST',
            data: {
              code: res.code
            },
            timeout: 10000, // 设置10秒超时
            success(loginRes) {
              console.log('后端响应:', loginRes);
              
              if (loginRes.statusCode === 200 && loginRes.data.success) {
                const { openid, token, isNewUser } = loginRes.data;
                
                console.log('微信登录成功, openid:', openid);
                console.log('是否新用户:', isNewUser);
                
                // 保存用户信息到全局数据
                that.globalData.openid = openid;
                that.globalData.token = token;
                that.globalData.userInfo = {
                  openid,
                  token,
                  isNewUser
                };
                
                // 保存到本地存储
                wx.setStorageSync('userInfo', {
                  openid,
                  token,
                  isNewUser,
                  loginTime: new Date().getTime()
                });
                
              } else {
                console.error('微信登录失败:', loginRes.data);
                // 不显示toast，让页面自己处理
              }
            },
            fail(err) {
              console.error('请求失败:', err);
              console.warn('后端服务不可用，使用临时ID');
              // 不显示toast，使用临时方案
            }
          });
        } else {
          console.error('登录失败！' + res.errMsg);
        }
      },
      fail(err) {
        console.error('wx.login失败:', err);
      }
    });
  },
  
  // 获取当前用户信息（供页面调用）
  getUserInfo() {
    return new Promise((resolve, reject) => {
      // 如果已有用户信息，直接返回
      if (this.globalData.openid && this.globalData.token) {
        resolve({
          openid: this.globalData.openid,
          token: this.globalData.token,
          userInfo: this.globalData.userInfo
        });
        return;
      }
      
      console.log('等待微信登录完成...');
      
      // 否则等待登录完成
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (this.globalData.openid && this.globalData.token) {
          clearInterval(checkInterval);
          console.log('登录完成，返回用户信息');
          resolve({
            openid: this.globalData.openid,
            token: this.globalData.token,
            userInfo: this.globalData.userInfo
          });
        }
        
        // 超时检查
        const elapsed = Date.now() - startTime;
        if (elapsed > 5000) {
          clearInterval(checkInterval);
          console.warn('登录超时，使用临时ID');
          
          // 降级方案：生成临时ID
          const tempId = 'temp_' + Date.now();
          const tempToken = 'temp_token_' + Math.random().toString(36).substr(2);
          
          this.globalData.openid = tempId;
          this.globalData.token = tempToken;
          this.globalData.userInfo = {
            openid: tempId,
            token: tempToken,
            isNewUser: true,
            isTemp: true
          };
          
          wx.setStorageSync('userInfo', {
            openid: tempId,
            token: tempToken,
            isNewUser: true,
            isTemp: true,
            loginTime: Date.now()
          });
          
          resolve({
            openid: tempId,
            token: tempToken,
            userInfo: this.globalData.userInfo,
            isTemp: true
          });
        }
      }, 100);
    });
  }
})