# 微信小程序与部署配置清单（协作者必读）

本文汇总从 GitHub 克隆后需要配置的全部项；**请勿将 AppSecret 写入仓库或公开渠道**，每人仅在本地 `.env` 中填写。

---

## 一、局域网 / 测试时访问地址怎么写

| 用途 | 写法说明 |
|------|----------|
| 小程序调后端 API | 开发：`LAN_IPV4` + 工具内 `127.0.0.1` 逻辑；**体验版/正式版真机**须配 **`frontend/config.js` → `PRODUCTION_API_URL`**（`https` 且已在公众平台 **request 合法域名** 配置），否则只能依赖「真机调试」才能访问局域网 IP。可选 **`FORCE_API_URL`** 强制固定地址。 |
| 头像等静态资源 | 与 API 同源：去掉 `API_URL` 末尾的 `/api` 即为站点根，例如 `http://<IP>:3000`，头像路径为 `/avatars/...` |

**仓库内当前示例**（以你本机为准时请自行修改 `frontend/config.js`）：

- `API_URL` 示例：`http://172.16.102.3:3000/api`（以 `frontend/config.js` 里 `LAN_IPV4` + `HTTP_PORT` 为准）

真机预览：手机与运行 Node 的电脑需 **同一 Wi‑Fi**；防火墙放行 **3000**（或你在 `.env` 里设的 `PORT`）。

---

## 二、项目根目录 `.env`（不提交 Git）

在项目根目录（与 `package.json` 同级）创建 **`.env`**。后端启动时会读取（见 `backend/server.js` 顶部 `dotenv` 配置）。可参考 **`backend/.env.example`**。

**订阅消息模板：本项目实际只用 2 个**——「排队到号」「排队叫号提醒」。下面 `.env` 里与模板相关的，**只需关心这两项**（不配则沿用 `server.js` 里的默认 ID，仍须与你在公众平台申请的模板一致）。

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `WECHAT_APPID` | 是 | 微信公众平台 → 开发 → 开发设置 → **AppID（小程序ID）** |
| `WECHAT_SECRET` | 是 | 同上 → **AppSecret**（仅本地保存，勿泄露） |
| `WECHAT_MINIPROGRAM_STATE` | 建议 | 订阅消息 `miniprogram_state`：**体验版/扫体验码** 用 `trial`；**仅开发者工具** 可试 `developer`；**已上架正式版** 用 `formal`（不配时代码侧默认 `formal`） |
| `WECHAT_TEMPLATE_CALLED` | 可选 | **排队到号** 模板 ID |
| `WECHAT_TEMPLATE_QUEUE_REMINDER` | 可选 | **排队叫号提醒** 模板 ID |
| `PORT` | 可选 | Node 监听端口，默认 `3000` |

后端里还存在 `WECHAT_TEMPLATE_REMINDER_5`、`WECHAT_TEMPLATE_MISSED` 等环境变量名（历史/预留占位），**你当前只申请了两个模板时不必配置、也不必在清单里当作必填项**；除非以后要在公众平台单独加「提前 N 位」「过号」类模板并接好发送逻辑，再考虑填写。

---

## 三、`frontend/config.js`（会进 Git，每人按环境改）

| 配置项 | 说明 |
|--------|------|
| `API_URL` | 后端根路径 + **`/api`**，与运行中的 Node 地址一致 |
| `SUBSCRIBE_TMPL_QUEUE_CALLED` | 与后端 `WECHAT_TEMPLATE_CALLED`、公众平台「排队到号」模板 **完全一致** |
| `SUBSCRIBE_TMPL_QUEUE_REMINDER` | 与后端 `WECHAT_TEMPLATE_QUEUE_REMINDER`、公众平台「排队叫号提醒」模板 **完全一致** |

**仓库当前默认模板 ID（若你未在 `.env` 覆盖后端，且未改 `config.js`，则前后端均按此）：**

- 排队到号：`k-yabn5Ze0mYwfviBKmPDztWx6BqQynM-oGuzlyPQGY`
- 排队叫号提醒：`5C3ru9yrICuvAAR3Evtnqn5OFD-cE7RaD9JeXUmZYK8`

若使用**自己的小程序**，须在公众平台申请自己的订阅消息模板，并**同时修改**根目录 `.env`（后端发送）与 **`frontend/config.js`**（前端 `wx.requestSubscribeMessage` 的 `tmplIds`）。

---

## 四、微信开发者工具与公众平台

| 项 | 说明 |
|----|------|
| 小程序 AppId | 必须与 **`WECHAT_APPID`** 一致 |
| 服务器域名 | **request 合法域名**、**downloadFile 合法域名**：填写与 `API_URL` 一致的 **协议 + 主机（+ 端口）**；纯 IP 在真机正式规则下常受限，开发阶段可在工具里勾选「不校验合法域名」做联调 |
| 订阅消息 | 在公众平台添加模板，**模板 ID** 与 `.env` / `config.js` 一致；字段需与 `backend/server.js` 中发送的 `data` 一致 |

---

## 五、运行命令

```bash
npm install
npm start
```

默认监听 `PORT`（未设置则为 **3000**）。管理后台静态资源由同一 Node 服务提供。

---

## 六、安全提醒

- **AppSecret** 只放在本机 `.env`，不要提交到 Git、不要发到聊天或截图。  
- 若 Secret 已泄露，请在公众平台 **重置 AppSecret**，并更新所有部署环境的 `.env`。

---

## 七、相关代码位置（便于二次开发）

| 能力 | 位置 |
|------|------|
| 登录 `jscode2session`、`.env` 读取 | `backend/server.js`（`/api/wechat/login`） |
| 订阅消息发送、`TEMPLATE_IDS` | `backend/server.js` |
| 小程序 API 地址、订阅 `tmplIds` | `frontend/config.js` |
| 环境变量示例 | `backend/.env.example` |
