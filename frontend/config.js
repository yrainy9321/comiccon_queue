/**
 * 小程序请求后端（URL 须以 /api 结尾）。
 *
 * 【体验版 / 正式版为什么必须配下面这个】
 * 只有「真机调试」会放宽域名校验；普通预览、上传后的体验版在真机上会强制校验「request 合法域名」，
 * 纯 http://局域网IP 几乎一定失败。解决办法：把后端暴露为 HTTPS 域名（可 ngrok/内网穿透），在公众平台配置该域名，
 * 再把完整 API 根地址填到 PRODUCTION_API_URL（须 https，且以 /api 结尾）。
 *
 * 【换电脑】WECHAT_APPID/SECRET 须与 project.config.json 的 appid 一致。
 *
 * USE_LOCALHOST_WHEN_NOT_MOBILE：非手机端（工具/模拟器）优先 127.0.0.1，避免局域网 IP 被拦。
 */
const LAN_IPV4 = '172.16.102.3';
const HTTP_PORT = 3000;
const FORCE_API_URL = '';
/**
 * 体验版(envVersion=trial)、正式版(release) 下使用的 API 根地址，须为 https://你的域名/api
 * （且该域名已在小程序后台「request 合法域名」中配置）。留空则仍走 LAN，体验版会失败属预期。
 */
const PRODUCTION_API_URL = '';
/** 见文件顶部说明 */
const USE_LOCALHOST_WHEN_NOT_MOBILE = true;

const LAN_API_URL = `http://${LAN_IPV4}:${HTTP_PORT}/api`;
const DEVTOOLS_API_URL = `http://127.0.0.1:${HTTP_PORT}/api`;

function normalizeApiBase(u) {
  const t = String(u || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  return t.endsWith('/api') ? t : `${t}/api`;
}

/** develop | trial | release */
function getMiniProgramEnvVersion() {
  try {
    if (typeof wx !== 'undefined' && wx.getAccountInfoSync) {
      return String(wx.getAccountInfoSync().miniProgram.envVersion || 'develop');
    }
  } catch (_) {
    /* ignore */
  }
  return 'develop';
}

/**
 * 运行宿主平台（新基础库下 getSystemInfoSync 的 platform 可能为空，需兼容 getDeviceInfo）。
 */
function getMiniProgramHostPlatform() {
  try {
    if (typeof wx !== 'undefined' && wx.getDeviceInfo && typeof wx.getDeviceInfo === 'function') {
      const d = wx.getDeviceInfo();
      if (d && d.platform) return String(d.platform);
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (typeof wx !== 'undefined' && wx.getSystemInfoSync) {
      return String(wx.getSystemInfoSync().platform || '');
    }
  } catch (_) {
    /* ignore */
  }
  return '';
}

function isMobilePhoneMiniProgram() {
  const p = getMiniProgramHostPlatform();
  return p === 'ios' || p === 'android' || p === 'ohos';
}

/**
 * 是否允许在「域名类失败」后改用 127.0.0.1 再试（会重新 wx.login）。
 */
function shouldAttemptLocalhostAfterDomainError() {
  return !isMobilePhoneMiniProgram();
}

function resolveRuntimeApiUrl() {
  const f = normalizeApiBase(FORCE_API_URL);
  if (f) return f;

  const env = getMiniProgramEnvVersion();
  const prod = normalizeApiBase(PRODUCTION_API_URL);
  if ((env === 'trial' || env === 'release') && prod) {
    return prod;
  }

  if (USE_LOCALHOST_WHEN_NOT_MOBILE && !isMobilePhoneMiniProgram()) {
    return DEVTOOLS_API_URL;
  }
  const p = getMiniProgramHostPlatform();
  if (p === 'devtools') return DEVTOOLS_API_URL;
  return LAN_API_URL;
}

module.exports = {
  LAN_IPV4,
  HTTP_PORT,
  FORCE_API_URL,
  PRODUCTION_API_URL,
  USE_LOCALHOST_WHEN_NOT_MOBILE,
  LAN_API_URL,
  DEVTOOLS_API_URL,
  getMiniProgramEnvVersion,
  getMiniProgramHostPlatform,
  isMobilePhoneMiniProgram,
  shouldAttemptLocalhostAfterDomainError,
  resolveRuntimeApiUrl,

  SUBSCRIBE_TMPL_QUEUE_CALLED: 'k-yabn5Ze0mYwfviBKmPDztWx6BqQynM-oGuzlyPQGY',
  SUBSCRIBE_TMPL_QUEUE_REMINDER: '5C3ru9yrICuvAAR3Evtnqn5OFD-cE7RaD9JeXUmZYK8'
};
