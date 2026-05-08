// index.js
const app = getApp();
const { validateBraceletIdStrictMg27 } = require('../../utils/braceletId.js');
const {
  SUBSCRIBE_TMPL_QUEUE_CALLED,
  SUBSCRIBE_TMPL_QUEUE_REMINDER
} = require('../../config.js');

Page({
  data: {
    userId: '',
    openid: '',
    hasBinding: false,
    /** 与「我的绑定」一致：my-customer-bindings 中排除已叫号入场后的条数 */
    boundBraceletCount: 0,
    showBindingBanner: false,
    hasAuth: false,
    userAvatar: '',
    userNickName: '',
    activityName: '',
    braceletId: '',
    userNumber: 0,
    queueCount: 0,
    loading: true,
    
    // 授权弹窗状态
    showAuthModal1: false,  // 授权提示弹窗
    showAuthModal2: false,  // 昵称头像填写表单弹窗
    
    // 临时表单数据
    tempAvatar: '',
    tempNickName: ''
  },

  async onLoad() {
    wx.showLoading({ title: '初始化中...' });
    
    try {
      const userInfo = await app.getUserInfo();
      console.log('【页面初始化】用户信息:', userInfo);
      
      this.setData({ 
        userId: userInfo.openid,
        openid: userInfo.openid,
        hasAuth: userInfo.hasAuth || false,
        userAvatar: userInfo.userInfo?.avatarUrl || userInfo.avatarUrl || '',
        userNickName: userInfo.userInfo?.nickName || userInfo.nickName || '',
        loading: false
      });
      
      wx.hideLoading();
      
      if (this.data.hasAuth) {
        this.checkUserBinding(userInfo.openid);
        this.refreshBindingBanner();
      }
    } catch (error) {
      wx.hideLoading();
      console.error('获取用户信息异常:', error);
      this.setData({ loading: false });
    }
  },

  onShow() {
    if (this.data.hasAuth && (this.data.openid || app.globalData.openid)) {
      const oid = this.data.openid || app.globalData.openid;
      this.checkUserBinding(oid);
      this.refreshBindingBanner();
    }
  },

  /** 拉取与「我的绑定」一致的列表条数（需登录态） */
  refreshBindingBanner() {
    if (!this.data.hasAuth) {
      this.setData({ boundBraceletCount: 0, showBindingBanner: false });
      return;
    }
    const cached = wx.getStorageSync('userInfo') || {};
    const token = app.globalData.token || cached.token || '';
    if (!token) {
      this.setData({ boundBraceletCount: 0, showBindingBanner: false });
      return;
    }
    const base = String(app.globalData.API_URL || '').replace(/\/$/, '');
    const authHeader = { Authorization: `Bearer ${token}` };
    wx.request({
      url: `${base}/wechat/user`,
      method: 'GET',
      header: authHeader,
      dataType: 'json',
      timeout: 12000,
      success: (ru) => {
        let oid = '';
        if (ru.statusCode === 200 && ru.data && ru.data.success && ru.data.openid) {
          oid = String(ru.data.openid);
        }
        if (!oid) oid = this.data.openid || cached.openid || app.globalData.openid || '';
        if (!oid) {
          this.setData({ boundBraceletCount: 0, showBindingBanner: false });
          return;
        }
        wx.request({
          url: `${base}/wechat/my-customer-bindings?openid=${encodeURIComponent(oid)}`,
          method: 'GET',
          header: authHeader,
          dataType: 'json',
          timeout: 12000,
          success: (rb) => {
            if (rb.statusCode === 200 && rb.data && rb.data.success && Array.isArray(rb.data.data)) {
              const n = rb.data.data.filter((row) => row && row.status !== 'called').length;
              this.setData({
                boundBraceletCount: n,
                showBindingBanner: n > 0
              });
            } else {
              this.setData({ boundBraceletCount: 0, showBindingBanner: false });
            }
          },
          fail: () => {
            this.setData({ boundBraceletCount: 0, showBindingBanner: false });
          }
        });
      },
      fail: () => {
        this.setData({ boundBraceletCount: 0, showBindingBanner: false });
      }
    });
  },

  goToMyBindings() {
    if (!this.data.hasAuth) {
      wx.showToast({ title: '请先完成授权', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/my-bindings/index' });
  },
  
  // 全局点击事件 - 未授权时显示授权弹窗
  handleGlobalClick() {
    console.log('【全局点击】用户点击了页面');
    
    if (!this.data.hasAuth && !this.data.showAuthModal2) {
      console.log('【全局点击】用户未授权，显示授权提示弹窗');
      wx.showModal({
        title: '提示',
        content: '授权后即可完成排队登记，并接收实时叫号与排队进度通知。',
        confirmText: '去授权',
        cancelText: '暂不授权',
        confirmColor: '#07c160',
        success: (res) => {
          if (res.confirm) {
            console.log('【授权流程】用户点击去授权');
            this.setData({ 
              showAuthModal2: true,
              tempAvatar: '',
              tempNickName: ''
            });
          }
        }
      });
    }
  },
  
  // 关闭授权弹窗 2
  closeAuthModal2() {
    this.setData({ showAuthModal2: false });
  },
  
  // 弹窗容器点击事件 - 阻止事件冒泡
  onModalContainerTap() {
    // 空函数，用于阻止事件冒泡到遮罩层
  },
  
  // 选择头像（微信原生新 API: chooseAvatar）
  onChooseAvatar(e) {
    console.log('【头像选择】选择头像成功:', e.detail.avatarUrl);
    this.setData({
      tempAvatar: e.detail.avatarUrl
    });
  },
  
  // 昵称输入事件
  onNickNameInput(e) {
    this.setData({
      tempNickName: e.detail.value
    });
  },
  
  // 昵称失焦事件
  onNickNameBlur(e) {
    this.setData({
      tempNickName: e.detail.value
    });
  },
  
  // 提交授权表单
  async submitAuthForm() {
    const { tempNickName, tempAvatar } = this.data;
    
    if (!tempNickName || !tempAvatar) {
      wx.showToast({
        title: '请填写完整信息',
        icon: 'none'
      });
      return;
    }
    
    console.log('【授权】提交表单，昵称:', tempNickName, '头像:', tempAvatar);
    
    wx.showLoading({ title: '授权中...' });
    
    try {
      // 先上传头像到服务器获取永久 URL
      let storedAvatarUrl = tempAvatar;
      console.log('【头像上传】原始头像 URL:', tempAvatar);
      console.log('【头像上传】API_URL:', app.globalData.API_URL);
      
      // 判断是否需要上传（临时路径或微信路径）
      const needUpload = tempAvatar.startsWith('http://tmp/') || 
                         tempAvatar.startsWith('wxfile://') || 
                         tempAvatar.startsWith('tmp_') ||
                         (tempAvatar.startsWith('http') && tempAvatar.includes('/tmp/'));
      
      console.log('【头像上传】是否需要上传:', needUpload);
      
      if (needUpload && app.globalData.token) {
        console.log('【头像上传】开始上传临时头像到服务器');
        try {
          const uploadResult = await this.uploadAvatar(tempAvatar);
          if (uploadResult && uploadResult.success) {
            storedAvatarUrl = uploadResult.data.avatarUrl;
            console.log('【头像上传成功】存储 URL:', storedAvatarUrl);
          } else {
            console.warn('【头像上传失败】使用原始 URL:', tempAvatar);
          }
        } catch (uploadError) {
          console.warn('【头像上传异常】使用原始 URL:', uploadError.message);
          // 头像上传失败不影响授权流程，使用原始 URL
        }
      } else if (!app.globalData.token) {
        console.warn('【头像上传跳过】没有 token，跳过上传');
      }
      
      // 更新全局数据
      app.globalData.userInfo = {
        ...app.globalData.userInfo,
        nickName: tempNickName,
        avatarUrl: storedAvatarUrl,
        hasAuth: true
      };
      app.globalData.hasAuth = true;
      
      // 保存到本地存储
      wx.setStorageSync('userInfo', {
        ...wx.getStorageSync('userInfo'),
        nickName: tempNickName,
        avatarUrl: storedAvatarUrl,
        hasAuth: true,
        openid: app.globalData.openid
      });
      
      // 发送用户信息到后端
      app.uploadUserInfo({ nickName: tempNickName, avatarUrl: storedAvatarUrl });
      
      wx.hideLoading();
      
      wx.showToast({
        title: '授权成功',
        icon: 'success'
      });
      
      // 更新页面数据
      this.setData({
        hasAuth: true,
        userAvatar: storedAvatarUrl,
        userNickName: tempNickName,
        userId: app.globalData.openid,
        openid: app.globalData.openid,
        showAuthModal2: false,
        tempAvatar: '',
        tempNickName: ''
      });
      
      // 检查绑定状态
      this.checkUserBinding(app.globalData.openid);
      this.refreshBindingBanner();
    } catch (error) {
      wx.hideLoading();
      console.error('【授权失败】', error);
      wx.showToast({
        title: '授权失败，请重试',
        icon: 'none'
      });
    }
  },
  
  // 上传头像到服务器（使用 wx.uploadFile）
  uploadAvatar(avatarUrl) {
    return new Promise((resolve, reject) => {
      console.log('【头像上传 API】开始上传文件:', avatarUrl);
      
      wx.uploadFile({
        url: `${app.globalData.API_URL}/wechat/upload-avatar-file`,
        filePath: avatarUrl,
        name: 'avatar',
        header: {
          'Authorization': 'Bearer ' + app.globalData.token
        },
        success: (res) => {
          console.log('【头像上传 API】响应:', res);
          try {
            const data = JSON.parse(res.data);
            if (data.success) {
              resolve(data);
            } else {
              reject(new Error(data.error || '头像上传失败'));
            }
          } catch (e) {
            reject(new Error('响应解析失败'));
          }
        },
        fail: (err) => {
          console.error('【头像上传 API】上传失败:', err);
          reject(new Error('上传失败：' + err.errMsg));
        }
      });
    });
  },

  checkUserBinding(openid) {
    wx.showLoading({ title: '加载中...' });

    wx.request({
      url: `${app.globalData.API_URL}/wechat/user-bindings`,
      method: 'GET',
      data: { openid: openid },
      timeout: 12000,
      success: (res) => {
        if (res.statusCode !== 200 || !res.data || !res.data.success) {
          this.setData({ hasBinding: false });
          return;
        }

        const list = (res.data.data || []).filter(
          (b) => b.status === 'waiting' || b.status === 'claimed'
        );
        if (list.length > 0) {
          list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
          const binding = list[0];
          this.setData({
            hasBinding: true,
            activityName: binding.activityName || '',
            braceletId: binding.braceletId || '',
            userNumber: binding.queueNumber || 0
          });

          this.getQueueCount(binding.activityId);
        } else {
          this.setData({ hasBinding: false });
        }
      },
      fail: (err) => {
        console.warn('【绑定查询】网络失败', err && err.errMsg);
        this.setData({ hasBinding: false });
      },
      complete: () => {
        wx.hideLoading();
      }
    });
  },

  getQueueCount(activityId) {
    wx.request({
      url: `${app.globalData.API_URL}/queue/count`,
      method: 'GET',
      timeout: 12000,
      data: { activityId: activityId },
      success: (res) => {
        if (res.data.success) {
          this.setData({ queueCount: res.data.count });
        }
      }
    });
  },

  scanCode() {
    wx.scanCode({
      success: (res) => {
        const bc = validateBraceletIdStrictMg27(res.result);
        if (!bc.ok) {
          wx.showToast({ title: bc.error, icon: 'none', duration: 2800 });
          return;
        }
        const braceletId = bc.value;
        const tmplIds = [SUBSCRIBE_TMPL_QUEUE_CALLED, SUBSCRIBE_TMPL_QUEUE_REMINDER].filter(
          (id) => typeof id === 'string' && id.length > 0
        );
        /**
         * wx.requestSubscribeMessage 必须在用户点击触发的同步链路里调用；
         * 放在 wx.request 的 success 里会被微信拦截，弹不出授权面板。
         */
        wx.showModal({
          title: '绑定手环',
          content: '开启订阅消息，排队进度更新后将第一时间通知您。',
          showCancel: false,
          confirmText: '继续',
          success: () => {
            if (tmplIds.length === 0) {
              this.runBindBraceletApi(braceletId);
              return;
            }
            wx.requestSubscribeMessage({
              tmplIds,
              complete: () => {
                this.runBindBraceletApi(braceletId);
              }
            });
          }
        });
      },
      fail: () => {
        wx.showToast({ title: '扫码失败', icon: 'none' });
      }
    });
  },
  
  // 扫码绑定手环码（按钮调用的方法）
  scanQRCode() {
    this.scanCode();
  },
  
  // 处理绑定手环码按钮点击
  handleBindBracelet() {
    if (!this.data.hasAuth) {
      wx.showToast({
        title: '请先完成授权',
        icon: 'none'
      });
      // 显示授权弹窗
      this.setData({ showAuthModal1: true });
      return;
    }
    // 已授权，直接扫码
    this.scanQRCode();
  },

  /** 仅请求绑定接口（订阅已在扫码后的「继续」手势里完成） */
  runBindBraceletApi(braceletId) {
    const oid = String(this.data.openid || app.globalData.openid || '');
    const cached = wx.getStorageSync('userInfo') || {};
    if (!oid || oid.startsWith('temp_') || oid.startsWith('mock_') || cached.isTemp) {
      wx.showModal({
        title: '无法绑定',
        content:
          '未拿到微信用户身份（请先等首页「初始化」完成，或检查网络与后端 /wechat/login）。完全关闭小程序再打开，确认 .env 已配置 WECHAT_APPID/SECRET 后重试。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }

    wx.showLoading({ title: '绑定中...' });

    const afterBindSuccess = () => {
      wx.showToast({ title: '绑定成功', icon: 'success', duration: 2000 });
      this.checkUserBinding(this.data.openid);
      this.refreshBindingBanner();
    };

    wx.request({
      url: `${app.globalData.API_URL}/wechat/bind`,
      method: 'POST',
      timeout: 12000,
      data: { openid: this.data.openid, braceletId: braceletId },
      success: (res) => {
        wx.hideLoading();

        if (res.data.success) {
          afterBindSuccess();
        } else {
          wx.showToast({ title: res.data.message || '绑定失败', icon: 'none' });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '绑定失败', icon: 'none' });
      }
    });
  },

  refreshStatus() {
    if (this.data.hasBinding && this.data.openid) {
      this.checkUserBinding(this.data.openid);
    }
    if (this.data.hasAuth) {
      this.refreshBindingBanner();
    }
  },

  goToUserCenter() {
    if (!this.data.hasAuth) {
      wx.showToast({
        title: '请先完成授权',
        icon: 'none'
      });
      this.setData({ showAuthModal1: true });
      return;
    }
    wx.navigateTo({ url: '/pages/user-center/index' });
  }
});