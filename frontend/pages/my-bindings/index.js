// pages/my-bindings/index.js — GET /wechat/user → my-scanned-bindings + my-customer-called-today；
// 每 2 秒静默刷新；前方人数与预计等候区间均由 GET /wechat/my-queue-ahead 返回（与后台 pace 同源）。
const app = getApp();

/** 进行中列表不展示已叫号；已叫号仅「今日已叫号」区块展示 */
function isBindingVisible(row) {
  return row && row.status !== 'called';
}

function formatScanTime(iso) {
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

/** 预计等候文案完全由 GET /wechat/my-queue-ahead 返回的 waitEstimate 驱动（与后台 queue/status 同源 pace） */

function requestGet(url, header = {}) {
  return new Promise((resolve) => {
    wx.request({
      url,
      method: 'GET',
      header,
      dataType: 'json',
      timeout: 12000,
      success: (r) => resolve(r),
      fail: () => resolve({ statusCode: 0, data: null })
    });
  });
}

function mapRowToListItem(row, idx, aheadByKey) {
  const aid = row.activityId != null ? String(row.activityId) : '';
  const qn = row.queueNumber;
  const aKey = `${aid}_${qn}`;
  const pack = aheadByKey[aKey];
  const aheadRes = pack && pack.ahead;

  /** 未拿到 /wechat/my-queue-ahead 成功结果时：多为网络、登录过期、参数错误等 */
  let aheadLine = '暂时无法获取前方排队人数，请下拉刷新重试';
  let aheadParts = null;
  if (aheadRes && aheadRes.inWaitingQueue === true && aheadRes.aheadCount != null) {
    const n = aheadRes.aheadCount;
    aheadLine = `前方还有 ${n} 人`;
    aheadParts = { pre: '前方还有 ', num: String(n), post: ' 人' };
  } else if (aheadRes && aheadRes.inWaitingQueue === false) {
    aheadLine = '当前不在等待叫号队列';
  } else if (pack && pack.hint) {
    aheadLine = pack.hint;
  }

  const paused = !!(aheadRes && aheadRes.queuePaused);
  const est = (aheadRes && aheadRes.waitEstimate) || {};

  let queueStateKind = 'unknown';
  let queueStateTitle = '排队状态获取失败';
  let etaRangeMin = null;
  let etaRangeMax = null;
  let etaSingleText = '';

  if (paused || est.kind === 'paused') {
    queueStateKind = 'paused';
    queueStateTitle = '暂停排队';
  } else if (aheadRes && aheadRes.inWaitingQueue === true) {
    if (est.kind === 'long_wait') {
      queueStateKind = 'longWait';
      queueStateTitle = '';
    } else if (est.kind === 'range' && est.minMinutes != null && est.maxMinutes != null) {
      queueStateKind = 'normal';
      queueStateTitle = '';
      etaRangeMin = est.minMinutes;
      etaRangeMax = est.maxMinutes;
    } else {
      queueStateKind = 'normal';
      queueStateTitle = '';
      etaSingleText = '暂时无法预估等候时间';
    }
  } else if (aheadRes && aheadRes.inWaitingQueue === false) {
    queueStateKind = 'notWaiting';
    queueStateTitle = '当前不在等待叫号队列';
  } else {
    queueStateKind = 'unknown';
    queueStateTitle = '请下拉刷新或稍后再试';
  }

  return {
    rowKey: `${aKey}_${idx}`,
    activityName: row.activityName || '',
    queueNumber: row.queueNumber,
    userScanBoundText: row.userScanBoundAt
      ? formatScanTime(row.userScanBoundAt)
      : row.status === 'waiting'
        ? '未扫码'
        : '—',
    showAhead: true,
    aheadLine,
    aheadParts,
    queueStateKind,
    queueStateTitle,
    etaRangeMin,
    etaRangeMax,
    etaSingleText
  };
}

function mapCalledTodayItem(row, idx) {
  return {
    rowKey: `ct_${idx}_${String(row.calledAt || '')}_${String(row.queueNumber || '')}`,
    cardKind: 'calledToday',
    activityName: row.activityName || '',
    userScanBoundText: formatScanTime(row.claimedAt || row.userScanBoundAt),
    queueNumber: row.queueNumber,
    statusText: '已叫号',
    calledAtText: formatScanTime(row.calledAt)
  };
}

Page({
  data: {
    loading: true,
    refreshing: false,
    list: [],
    calledTodayList: [],
    empty: false
  },

  onLoad() {
    this._loadBindingsGen = 0;
  },

  onShow() {
    // 首次进入全屏加载；从子页返回等再次 onShow 时用静默请求，避免整页闪「加载中」
    this.loadBindings({ silent: Boolean(this._myBindingsHasLoaded) });
    this.startAutoRefresh();
  },

  onHide() {
    this.clearAutoRefresh();
    if (this.data.refreshing) {
      try {
        wx.hideNavigationBarLoading();
      } catch (e) {
        /* ignore */
      }
      this.setData({ refreshing: false });
    }
    try {
      wx.stopPullDownRefresh();
    } catch (e) {
      /* ignore */
    }
  },

  onUnload() {
    this.clearAutoRefresh();
    if (this.data.refreshing) {
      try {
        wx.hideNavigationBarLoading();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      wx.stopPullDownRefresh();
    } catch (e) {
      /* ignore */
    }
  },

  /** 每 2 秒静默拉取列表与排队状态（离开页面务必清除） */
  startAutoRefresh() {
    this.clearAutoRefresh();
    this._refreshTimer = setInterval(() => {
      this.loadBindings({ silent: true });
    }, 2000);
  },

  clearAutoRefresh() {
    if (this._refreshTimer != null) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  },

  loadBindings(opts = {}) {
    const pullDown = Boolean(opts.pullDown);
    const silent = Boolean(opts.silent);
    const myGen = (this._loadBindingsGen = (this._loadBindingsGen || 0) + 1);
    const isStale = () => myGen !== this._loadBindingsGen;

    const finishPull = () => {
      if (pullDown) {
        wx.stopPullDownRefresh();
        try {
          wx.hideNavigationBarLoading();
        } catch (e) {
          /* ignore */
        }
        this.setData({ refreshing: false });
      }
    };

    /** 手动下拉成功后再给 Toast，略延迟，避免与收起动画叠在一起显得「没反馈」 */
    const schedulePullSuccessFeedback = () => {
      if (!pullDown) return;
      setTimeout(() => {
        if (isStale()) return;
        wx.showToast({
          title: '刷新成功',
          icon: 'success',
          duration: 1500
        });
      }, 280);
    };

    const cached = wx.getStorageSync('userInfo') || {};
    const token = app.globalData.token || cached.token || '';
    if (!token) {
      this.clearAutoRefresh();
      this._myBindingsHasLoaded = false;
      this.setData({ loading: false, list: [], calledTodayList: [], empty: true });
      wx.showToast({ title: '请先登录', icon: 'none' });
      finishPull();
      return;
    }

    if (!pullDown && !silent) {
      this.setData({ loading: true });
    }
    if (pullDown) {
      this.setData({ refreshing: true });
      try {
        wx.showNavigationBarLoading();
      } catch (e) {
        /* ignore */
      }
    }
    const base = String(app.globalData.API_URL || '').replace(/\/$/, '');
    const authHeader = { Authorization: `Bearer ${token}` };

    const failEmpty = (toast, wipeList = true) => {
      if (isStale()) {
        finishPull();
        return;
      }
      if (wipeList) {
        this._myBindingsHasLoaded = false;
        this.setData({ loading: false, list: [], calledTodayList: [], empty: true });
      } else {
        this.setData({ loading: false });
      }
      if (toast) wx.showToast({ title: toast, icon: 'none' });
      finishPull();
    };

    const afterBindings = (visible, openid) => {
      const calledPromise = requestGet(
        `${base}/wechat/my-customer-called-today?openid=${encodeURIComponent(openid)}`,
        authHeader
      ).then((r) => {
        if (r.statusCode === 200 && r.data && r.data.success && Array.isArray(r.data.data)) {
          return r.data.data;
        }
        return [];
      });

      if (!visible.length) {
        calledPromise.then((calledRows) => {
          if (isStale()) {
            finishPull();
            return;
          }
          const calledTodayList = (calledRows || []).map((row, idx) => mapCalledTodayItem(row, idx));
          const empty = calledTodayList.length === 0;
          this.setData({ loading: false, list: [], calledTodayList, empty });
          this._myBindingsHasLoaded = true;
          finishPull();
          schedulePullSuccessFeedback();
        });
        return;
      }

      const aheadPromise = Promise.all(
        visible.map((row) => {
          const aid = row.activityId != null ? String(row.activityId) : '';
          const qn = row.queueNumber;
          const url = `${base}/wechat/my-queue-ahead?activityId=${encodeURIComponent(aid)}&queueNumber=${encodeURIComponent(qn)}&openid=${encodeURIComponent(openid)}`;
          return requestGet(url, authHeader).then((r) => {
            const key = `${aid}_${qn}`;
            if (r.statusCode === 200 && r.data && r.data.success) {
              return { key, ahead: r.data, hint: null };
            }
            const serverMsg = (r.data && (r.data.error || r.data.message)) || '';
            let hint =
              serverMsg ||
              (r.statusCode === 401 ? '登录已过期，请重新进入小程序' : '') ||
              (r.statusCode === 403 ? '身份校验失败，请重新登录' : '') ||
              (r.statusCode === 404 ? '活动不存在或参数有误' : '') ||
              (r.statusCode ? `服务暂时不可用（${r.statusCode}）` : '') ||
              '网络连接失败，请检查网络';
            if (hint.length > 36) {
              hint = '暂时无法获取前方排队人数，请下拉刷新重试';
            }
            return { key, ahead: null, hint };
          });
        })
      );

      Promise.all([aheadPromise, calledPromise]).then(([aheadResults, calledRows]) => {
        if (isStale()) {
          finishPull();
          return;
        }
        const aheadByKey = {};
        aheadResults.forEach(({ key, ahead, hint }) => {
          aheadByKey[key] = { ahead, hint };
        });
        const list = visible.map((row, idx) => mapRowToListItem(row, idx, aheadByKey));
        const calledTodayList = (calledRows || []).map((row, idx) => mapCalledTodayItem(row, idx));
        const empty = list.length === 0 && calledTodayList.length === 0;
        this.setData({ loading: false, list, calledTodayList, empty });
        this._myBindingsHasLoaded = true;
        finishPull();
        schedulePullSuccessFeedback();
      });
    };

    wx.request({
      url: `${base}/wechat/user`,
      method: 'GET',
      header: authHeader,
      dataType: 'json',
      timeout: 12000,
      success: (rUser) => {
        let serverOpenid = '';
        if (rUser.statusCode === 200 && rUser.data && rUser.data.success && rUser.data.openid) {
          serverOpenid = String(rUser.data.openid);
          try {
            wx.setStorageSync('userInfo', { ...cached, openid: serverOpenid });
            app.globalData.openid = serverOpenid;
          } catch (e) {
            /* ignore */
          }
        }
        const openid = serverOpenid || cached.openid || app.globalData.openid || '';
        if (!openid) {
          failEmpty('请先登录', true);
          return;
        }
        wx.request({
          url: `${base}/wechat/my-scanned-bindings`,
          method: 'GET',
          header: authHeader,
          dataType: 'json',
          timeout: 12000,
          success: (res) => {
            if (isStale()) {
              finishPull();
              return;
            }
            if (res.statusCode === 401) {
              this.clearAutoRefresh();
              failEmpty('请先登录', true);
              return;
            }
            if (res.statusCode !== 200 || !res.data || !res.data.success) {
              const err = (res.data && (res.data.error || res.data.message)) || '';
              if (silent) {
                finishPull();
                return;
              }
              failEmpty(err ? String(err) : '', true);
              return;
            }
            const raw = Array.isArray(res.data.data) ? res.data.data : [];
            const visible = raw.filter(isBindingVisible);
            afterBindings(visible, openid);
          },
          fail: () => {
            if (isStale()) {
              finishPull();
              return;
            }
            if (silent) {
              finishPull();
              return;
            }
            failEmpty('网络异常', true);
          }
        });
      },
      fail: () => {
        if (isStale()) {
          finishPull();
          return;
        }
        if (silent) {
          finishPull();
          return;
        }
        failEmpty('网络异常', true);
      }
    });
  },

  onPullDownRefresh() {
    this.loadBindings({ pullDown: true });
  },

  /** scroll-view 自定义下拉（与页面级下拉二选一触发即可） */
  onRefresherRefresh() {
    this.loadBindings({ pullDown: true });
  }
});
