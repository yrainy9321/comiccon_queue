// app.js
const appConfig = require('./config.js');

/** 兼容部分环境下 data 为字符串或非 JSON 的情况 */
function parseWxResponseData(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const s = String(raw);
  try {
    return JSON.parse(s);
  } catch (e) {
    return { success: false, message: 'invalid_json_response', _rawSnippet: s.slice(0, 160) };
  }
}

App({
  onLaunch() {
    this.globalData.API_URL = appConfig.resolveRuntimeApiUrl();
    try {
      const p = appConfig.getMiniProgramHostPlatform && appConfig.getMiniProgramHostPlatform();
      const ev = appConfig.getMiniProgramEnvVersion && appConfig.getMiniProgramEnvVersion();
      console.log('[启动] env=%s platform=%s API_URL=%s', ev, p || '(empty)', this.globalData.API_URL);
      if ((ev === 'trial' || ev === 'release') && !String(appConfig.PRODUCTION_API_URL || '').trim()) {
        console.warn(
          '[启动] 当前为体验版/正式版但未配置 config.js 的 PRODUCTION_API_URL（https 合法域名），真机非「真机调试」时请求会被微信拦截。'
        );
      }
    } catch (_) {
      console.log('[启动] API_URL=', this.globalData.API_URL);
    }
    this.getWechatUserInfo().catch((e) => console.warn('[微信登录] onLaunch 预登录未完成', e && e.message));
  },

  globalData: {
    API_URL: appConfig.resolveRuntimeApiUrl(),
    userInfo: null,
    openid: null,
    unionid: null,
    token: null,
    hasAuth: false, // 用户是否已授权
    /** 进行中的 wx.login + /wechat/login，避免退出后重复请求竞态 */
    _wechatLoginPromise: null
  },

  /**
   * 静默拉取微信 session：读缓存（丢弃 temp_）→ wx.login → /wechat/login。
   * 同一时刻多次调用会共用同一个 Promise。
   */
  getWechatUserInfo() {
    if (this.globalData._wechatLoginPromise) {
      return this.globalData._wechatLoginPromise;
    }

    const that = this;
    that.globalData.API_URL = appConfig.resolveRuntimeApiUrl();

    const p = new Promise((resolve, reject) => {
      let cachedUserInfo = wx.getStorageSync('userInfo') || {};
      let oid = String(cachedUserInfo.openid || '');
      let tok = String(cachedUserInfo.token || '');
      const badTemp =
        cachedUserInfo.isTemp === true ||
        oid.startsWith('temp_') ||
        oid.startsWith('mock_') ||
        tok.startsWith('temp_token_');

      if (badTemp && (oid || tok)) {
        console.warn('[微信登录] 清除无效的临时登录缓存');
        wx.removeStorageSync('userInfo');
        cachedUserInfo = {};
        oid = '';
        tok = '';
      }

      if (oid && tok && !oid.startsWith('temp_') && !oid.startsWith('mock_')) {
        console.log('[微信登录] 使用缓存 openid');
        that.globalData.userInfo = cachedUserInfo;
        that.globalData.openid = oid;
        that.globalData.unionid = cachedUserInfo.unionid || null;
        that.globalData.token = tok;
        that.globalData.hasAuth = cachedUserInfo.hasAuth || false;
        resolve({ fromCache: true, openid: oid });
        return;
      }

      console.log('[微信登录] 开始 wx.login → /wechat/login');

      const postWechatLogin = (apiBase, loginCode) =>
        new Promise((resv, rej) => {
          const base = String(apiBase || '').replace(/\/+$/, '');
          wx.request({
            url: `${base}/wechat/login`,
            method: 'POST',
            data: { code: loginCode },
            header: {
              'Content-Type': 'application/json; charset=utf-8'
            },
            dataType: 'json',
            timeout: 15000,
            success(loginRes) {
              const d = parseWxResponseData(loginRes.data);
              console.log('[微信登录] 后端响应 status=', loginRes.statusCode, d);
              if (loginRes.statusCode === 200 && d.success) {
                resv(d);
                return;
              }
              const msg =
                d.message ||
                d.error ||
                (d.code != null ? `wechat_${d.code}` : '') ||
                `HTTP_${loginRes.statusCode}`;
              const er = new Error(String(msg || 'wechat_login_fail'));
              er._kind = 'http';
              rej(er);
            },
            fail(err) {
              const m = (err && err.errMsg) || 'request_fail';
              const er = new Error(m);
              er._kind = 'net';
              rej(er);
            }
          });
        });

      const wxLoginThenPost = (apiBase) =>
        new Promise((resv, rej) => {
          wx.login({
            success(res) {
              if (!res.code) {
                rej(new Error('wx.login 未返回 code'));
                return;
              }
              postWechatLogin(apiBase, res.code).then(resv).catch(rej);
            },
            fail(err) {
              rej(new Error((err && err.errMsg) || 'wx.login 失败'));
            }
          });
        });

      const applyLoginData = (d) => {
        const { openid, unionid, token, isNewUser } = d;
        that.globalData.openid = openid;
        that.globalData.unionid = unionid || null;
        that.globalData.token = token;
        that.globalData.userInfo = {
          openid,
          unionid: unionid || null,
          token,
          isNewUser,
          hasAuth: false
        };
        that.globalData.hasAuth = false;
        wx.setStorageSync('userInfo', {
          openid,
          unionid: unionid || null,
          token,
          isNewUser,
          hasAuth: false,
          loginTime: Date.now()
        });
      };

      const firstBase = that.globalData.API_URL;
      wxLoginThenPost(firstBase)
        .catch((e) => {
          const msg = String((e && e.message) || '');
          const domainHit =
            e &&
            e._kind === 'net' &&
            /domain|合法域名|url not in\s+domain|not\s+in\s+domain/i.test(msg);
          const connHit =
            e &&
            e._kind === 'net' &&
            /(fail\s+connect|connection\s+refused|timeout|ERR_CONNECTION)/i.test(msg);
          const notLocal =
            firstBase &&
            !/127\.0\.0\.1|localhost/i.test(String(firstBase));
          if (
            (domainHit || connHit) &&
            notLocal &&
            appConfig.shouldAttemptLocalhostAfterDomainError()
          ) {
            that.globalData.API_URL = appConfig.DEVTOOLS_API_URL;
            console.warn('[微信登录] 域名失败，改本机回环并重新 wx.login');
            return wxLoginThenPost(that.globalData.API_URL);
          }
          throw e;
        })
        .then((d) => {
          applyLoginData(d);
          resolve({ openid: d.openid, token: d.token });
        })
        .catch(reject);
    });

    this.globalData._wechatLoginPromise = p.finally(() => {
      that.globalData._wechatLoginPromise = null;
    });

    return this.globalData._wechatLoginPromise;
  },
  
  // 请求用户授权获取头像、昵称
  requestUserProfile() {
    const that = this;
    
    return new Promise((resolve, reject) => {
      wx.getUserProfile({
        desc: '用于完善会员资料',
        success: (res) => {
          console.log('用户授权成功:', res);
          
          const userInfo = res.userInfo;
          const openid = that.globalData.openid;
          const token = that.globalData.token;
          
          // 更新全局数据
          that.globalData.userInfo = {
            ...that.globalData.userInfo,
            ...userInfo,
            hasAuth: true
          };
          that.globalData.hasAuth = true;
          
          // 保存到本地存储
          wx.setStorageSync('userInfo', {
            ...wx.getStorageSync('userInfo'),
            ...userInfo,
            hasAuth: true
          });
          
          // 发送用户信息到后端
          that.uploadUserInfo(userInfo);
          
          resolve(userInfo);
        },
        fail: (err) => {
          console.error('用户授权失败:', err);
          reject(err);
        }
      });
    });
  },
  
  // 上传用户信息到后端
  uploadUserInfo(userInfo) {
    const that = this;
    
    console.log('【上传用户信息】开始上传');
    console.log('【上传用户信息】URL:', that.globalData.API_URL + '/wechat/user-info');
    console.log('【上传用户信息】数据:', {
      nickName: userInfo.nickName,
      avatarUrl: userInfo.avatarUrl,
      openid: that.globalData.openid,
      unionid: that.globalData.unionid,
      token: that.globalData.token
    });
    
    wx.request({
      url: that.globalData.API_URL + '/wechat/user-info',
      method: 'POST',
      data: {
        nickName: userInfo.nickName,
        avatarUrl: userInfo.avatarUrl,
        openid: that.globalData.openid,  // 传递openid用于用户匹配
        unionid: that.globalData.unionid  // 传递unionid
      },
      header: {
        'Authorization': `Bearer ${that.globalData.token}`
      },
      success: (res) => {
        console.log('【上传用户信息】响应:', res);
        if (res.statusCode === 200 && res.data.success) {
          console.log('用户信息上传成功');
        } else {
          console.error('用户信息上传失败:', res.data);
        }
      },
      fail: (err) => {
        console.error('【上传用户信息】网络请求失败:', err);
      }
    });
  },
  
  /** 是否已具备真实微信登录态（非 temp_ 降级） */
  _hasRealWechatSession() {
    const oid = String(this.globalData.openid || '');
    const tok = String(this.globalData.token || '');
    return Boolean(
      oid &&
        tok &&
        !oid.startsWith('temp_') &&
        !oid.startsWith('mock_') &&
        !tok.startsWith('temp_token_')
    );
  },

  // 获取当前用户信息（供页面调用）：主动走 /wechat/login，不再长时间空等 onLaunch
  getUserInfo() {
    if (this._hasRealWechatSession()) {
      return Promise.resolve({
        openid: this.globalData.openid,
        token: this.globalData.token,
        userInfo: this.globalData.userInfo,
        hasAuth: this.globalData.hasAuth
      });
    }

    /** 仅作兜底：正常 wx.login 数秒内应完成；过长易误以为卡死 */
    const loginMs = 12000;
    return Promise.race([
      this.getWechatUserInfo()
        .then(() => ({
          openid: this.globalData.openid,
          token: this.globalData.token,
          userInfo: this.globalData.userInfo,
          hasAuth: this.globalData.hasAuth,
          isTemp: false
        }))
        .catch((err) => ({
          _loginFail: true,
          _msg: (err && err.message) || String(err)
        })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ loginTimedOut: true }), loginMs)
      )
    ]).then((out) => {
      if (out && out.loginTimedOut) {
        console.error('[微信登录] 超时 %sms API_URL=%s', loginMs, this.globalData.API_URL);
        return {
          openid: '',
          token: '',
          userInfo: this.globalData.userInfo,
          hasAuth: false,
          loginTimedOut: true
        };
      }
      if (out && out._loginFail) {
        const text = String(out._msg || '登录失败').slice(0, 200);
        console.error('[微信登录] 失败 API_URL=%s %s', this.globalData.API_URL, text);
        return {
          openid: '',
          token: '',
          userInfo: this.globalData.userInfo,
          hasAuth: false,
          loginFailed: true
        };
      }
      return out;
    });
  }
})
