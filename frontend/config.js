/**
 * 小程序请求后端地址（须带 /api 后缀，与 server 路由一致）
 *
 * 真机预览：手机与运行后端的电脑必须在同一 Wi‑Fi；
 * 把下面改成你电脑的局域网 IPv4（Windows: ipconfig，Mac: 系统设置 → 网络），不要用 127.0.0.1。
 * 若仍超时，检查电脑防火墙是否放行 Node 端口（默认 3000）。
 */
module.exports = {
  API_URL: 'http://172.16.100.78:3000/api',

  /** 一次性订阅：排队到号通知（与后端 WECHAT_TEMPLATE_CALLED 一致） */
  SUBSCRIBE_TMPL_QUEUE_CALLED: 'k-yabn5Ze0mYwfviBKmPDztWx6BqQynM-oGuzlyPQGY',
  /** 一次性订阅：排队叫号提醒（字段待定，仅先请求授权） */
  SUBSCRIBE_TMPL_QUEUE_REMINDER: '5C3ru9yrICuvAAR3Evtnqn5OFD-cE7RaD9JeXUmZYK8'
};
