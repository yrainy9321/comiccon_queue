// pages/my-bindings/index.js — GET /wechat/user 取 openid → GET /wechat/my-scanned-bindings；
// 每 2 秒静默刷新：绑定列表 + /queue/status/:activityId + /wechat/my-queue-ahead；已叫号入场不展示。
const app = getApp();

/** 我的绑定：已叫号入场不展示、不计入条数 */
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

/**
 * 排队状态来自 GET /api/queue/status/:activityId（queuePaused、isSlow、avgIntervalSeconds）。
 * 前方人数来自 /wechat/my-queue-ahead 的 aheadCount。
 * 仅当平均叫号间隔小于 10 分钟（avgIntervalSeconds < 600）且能拿到前方人数时，
 * 用「前方还有 X 人 × 平均间隔秒」估算总等待时长并换算为分钟展示。
 */
function computeQueueFields(statusJson, aheadCountForEta) {
  const unknown = {
    queueStateKind: 'unknown',
    queueStateTitle: '排队状态获取失败',
    etaText: '请下拉刷新或稍后再试',
    etaMinutes: null
  };

  if (!statusJson || typeof statusJson !== 'object') {
    return unknown;
  }

  const paused = Boolean(statusJson.queuePaused);
  const slow = Boolean(statusJson.isSlow);
  const avgSec = Number(statusJson.avgIntervalSeconds) || 0;
  /** 与后台「排队缓慢」阈值对齐：间隔在 10 分钟内才给出数值化总等待时长 */
  const intervalUnder10Min = avgSec > 0 && avgSec < 600;

  function buildWaitDisplay() {
    let etaText = '—';
    let etaMinutes = null;

    if (aheadCountForEta == null) {
      etaText = '暂无前方人数数据';
      return { etaText, etaMinutes };
    }
    if (aheadCountForEta <= 0) {
      etaText = '即将轮到您';
      return { etaText, etaMinutes };
    }
    if (avgSec <= 0) {
      etaText = '预估时间计算中（叫号样本不足）';
      return { etaText, etaMinutes };
    }
    if (!intervalUnder10Min) {
      etaText = '叫号间隔较长（≥10 分钟），预计等候较久';
      return { etaText, etaMinutes };
    }

    const totalSec = aheadCountForEta * avgSec;
    etaMinutes = Math.max(1, Math.round(totalSec / 60));
    etaText = `约 ${etaMinutes} 分钟`;
    return { etaText, etaMinutes };
  }

  if (paused) {
    return {
      queueStateKind: 'paused',
      queueStateTitle: '暂停排队',
      etaText: '',
      etaMinutes: null
    };
  }

  if (slow) {
    const { etaText, etaMinutes } = buildWaitDisplay();
    return {
      queueStateKind: 'slow',
      queueStateTitle: '排队缓慢',
      etaText,
      etaMinutes
    };
  }

  /** 后台：未暂停且非 isSlow，即排队节奏正常（有足量叫号样本且平均间隔小于 10 分钟） */
  const { etaText, etaMinutes } = buildWaitDisplay();
  return {
    queueStateKind: 'normal',
    queueStateTitle: '排队正常',
    etaText,
    etaMinutes
  };
}

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

function mapRowToListItem(row, idx, statusByAid, aheadByKey) {
  const aid = row.activityId != null ? String(row.activityId) : '';
  const qn = row.queueNumber;
  const st = aid ? statusByAid[aid] : null;
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

  const aheadForEta =
    aheadRes && aheadRes.inWaitingQueue === true && typeof aheadRes.aheadCount === 'number'
      ? aheadRes.aheadCount
      : null;

  const qf = computeQueueFields(st, aheadForEta);

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
    ...qf
  };
}

Page({
  data: {
    loading: true,
    list: [],
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
  },

  onUnload() {
    this.clearAutoRefresh();
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
      if (pullDown) wx.stopPullDownRefresh();
    };

    const cached = wx.getStorageSync('userInfo') || {};
    const token = app.globalData.token || cached.token || '';
    if (!token) {
      this.clearAutoRefresh();
      this._myBindingsHasLoaded = false;
      this.setData({ loading: false, list: [], empty: true });
      wx.showToast({ title: '请先登录', icon: 'none' });
      finishPull();
      return;
    }

    if (!pullDown && !silent) {
      this.setData({ loading: true });
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
        this.setData({ loading: false, list: [], empty: true });
      } else {
        this.setData({ loading: false });
      }
      if (toast) wx.showToast({ title: toast, icon: 'none' });
      finishPull();
    };

    const afterBindings = (visible, openid) => {
      if (!visible.length) {
        if (!isStale()) {
          this.setData({ loading: false, list: [], empty: true });
          this._myBindingsHasLoaded = true;
        }
        finishPull();
        return;
      }
      const aids = [...new Set(visible.map((r) => (r.activityId != null ? String(r.activityId) : '')).filter(Boolean))];

      const statusPromise = Promise.all(
        aids.map((aid) =>
          requestGet(`${base}/queue/status/${encodeURIComponent(aid)}`).then((r) => ({
            aid,
            body: r.statusCode === 200 && r.data && !r.data.error ? r.data : null
          }))
        )
      );

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

      Promise.all([statusPromise, aheadPromise]).then(([statusResults, aheadResults]) => {
        if (isStale()) {
          finishPull();
          return;
        }
        const statusByAid = {};
        statusResults.forEach(({ aid, body }) => {
          statusByAid[aid] = body;
        });
        const aheadByKey = {};
        aheadResults.forEach(({ key, ahead, hint }) => {
          aheadByKey[key] = { ahead, hint };
        });
        const list = visible.map((row, idx) => mapRowToListItem(row, idx, statusByAid, aheadByKey));
        this.setData({ loading: false, list, empty: list.length === 0 });
        this._myBindingsHasLoaded = true;
        finishPull();
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
  }
});
