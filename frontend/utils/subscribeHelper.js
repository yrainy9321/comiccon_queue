/**
 * 订阅消息：本地静默统计 + 上报后端（用于下发前跳过明确拒绝/封禁的模板）
 * 与 wx.getSetting({ withSubscriptions: true }) 配合，兼容「允许 / 拒绝 / 总是保持」等状态。
 */

const STORAGE_KEY = 'subscribeLocalStats_v1';

function getAppSafe() {
  try {
    return getApp();
  } catch (e) {
    return null;
  }
}

/** 合并 wx.requestSubscribeMessage 的 success 结果到本地（按模板累计 accept/reject/ban） */
function mergeLocalSubscribeStats(tmplIds, subRes) {
  try {
    const bag = wx.getStorageSync(STORAGE_KEY) || { v: 1, tpl: {} };
    if (!bag.tpl || typeof bag.tpl !== 'object') bag.tpl = {};
    (tmplIds || []).forEach((id) => {
      const st = subRes && subRes[id];
      if (!st || typeof st !== 'string') return;
      const cell = bag.tpl[id] || { accept: 0, reject: 0, ban: 0, other: 0, last: '', lastAt: 0 };
      const k = ['accept', 'reject', 'ban'].includes(st) ? st : 'other';
      cell[k] = (cell[k] || 0) + 1;
      cell.last = st;
      cell.lastAt = Date.now();
      bag.tpl[id] = cell;
    });
    wx.setStorageSync(STORAGE_KEY, bag);
  } catch (e) {
    /* ignore */
  }
}

/** 静默上报后端（不阻塞绑定） */
function reportSubscribeToServer(tmplIds, subRes) {
  const app = getAppSafe();
  const token = (app && app.globalData && app.globalData.token) || '';
  const base = String((app && app.globalData && app.globalData.API_URL) || '')
    .trim()
    .replace(/\/+$/, '');
  if (!token || !base || !subRes || typeof subRes !== 'object') return;
  const results = {};
  (tmplIds || []).forEach((id) => {
    const v = subRes[id];
    if (v && typeof v === 'string') results[id] = v;
  });
  if (Object.keys(results).length === 0) return;
  wx.request({
    url: `${base}/wechat/subscribe-report`,
    method: 'POST',
    header: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    data: { results },
    timeout: 12000
  });
}

/**
 * 用户已在系统设置里对全部 tmplId 为「接受」（含勾选「总是保持以上选择」）时，
 * 可跳过说明弹窗与 requestSubscribeMessage，直接走绑定（仍由后端按授权下发）。
 */
function shouldSkipSubscribeUiForAlwaysAccept(gst, tmplIds) {
  if (!tmplIds || tmplIds.length === 0) return true;
  const sub = gst && gst.subscriptionsSetting;
  if (!sub || typeof sub !== 'object') return false;
  if (sub.mainSwitch === false) return false;
  const item = sub.itemSettings;
  if (!item || typeof item !== 'object') return false;
  return tmplIds.every((id) => item[id] === 'accept');
}

module.exports = {
  STORAGE_KEY,
  mergeLocalSubscribeStats,
  reportSubscribeToServer,
  shouldSkipSubscribeUiForAlwaysAccept
};
