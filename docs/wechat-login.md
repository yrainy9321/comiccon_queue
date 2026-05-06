# 微信登录配置指南

## 功能说明

本系统实现了微信小程序的静默登录功能，在用户首次进入小程序时自动获取用户的OpenID，用于后续的消息模板推送。

## 工作流程

1. **应用启动**：用户打开小程序时，`app.js` 的 `onLaunch` 生命周期被触发
2. **获取Code**：调用 `wx.login()` 获取临时登录凭证 code
3. **换取OpenID**：将 code 发送到后端，后端调用微信接口换取 openid 和 session_key
4. **保存用户信息**：将 openid 和 token 保存到全局数据和本地存储
5. **页面使用**：各页面通过 `app.getUserInfo()` 获取用户信息

## 配置步骤

### 1. 获取微信小程序 AppID 和 Secret

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入「开发」->「开发管理」->「开发设置」
3. 复制 AppID (小程序ID)
4. 生成或查看 AppSecret (小程序密钥)

### 2. 配置后端环境变量

在 `backend` 目录下创建 `.env` 文件（或复制 `.env.example`）：

```bash
cp backend/.env.example backend/.env
```

编辑 `.env` 文件，填入你的微信小程序配置：

```env
WECHAT_APPID=wx1234567890abcdef
WECHAT_SECRET=your_secret_here
PORT=3000
```

### 3. 配置小程序服务器域名

在微信公众平台配置合法的服务器域名：

1. 进入「开发」->「开发管理」->「开发设置」
2. 找到「服务器域名」配置
3. 添加你的后端服务器地址到 `request合法域名`

**注意**：开发阶段可以在微信开发者工具中勾选「不校验合法域名」

### 4. 启动服务

```bash
# 安装依赖
npm install

# 启动后端服务
npm start
# 或开发模式
npm run dev
```

## API 接口说明

### POST /api/wechat/login

通过微信登录凭证 code 获取用户 openid

**请求参数：**
```json
{
  "code": "微信登录返回的临时code"
}
```

**响应示例：**
```json
{
  "success": true,
  "openid": "oXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "token": "随机生成的token字符串",
  "isNewUser": true
}
```

### GET /api/wechat/user

获取当前登录用户信息

**请求头：**
```
Authorization: Bearer {token}
```

**响应示例：**
```json
{
  "success": true,
  "openid": "oXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "lastLoginAt": "2026-04-27T12:00:00.000Z"
}
```

## 数据存储

用户信息保存在 `backend/data/wechat_users.json` 文件中：

```json
{
  "oXXXXXXXXXXXXXXXXXXXXXXXXXXX": {
    "openid": "oXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "token": "随机token",
    "createdAt": "2026-04-27T00:00:00.000Z",
    "lastLoginAt": "2026-04-27T12:00:00.000Z"
  }
}
```

## 消息模板推送准备

获取到 openid 后，可以用于后续的模板消息推送。推送消息时需要：

1. 用户的 openid（已获取并保存）
2. 模板 ID（在微信公众平台配置）
3. 访问令牌 access_token（需要单独获取）

示例代码位置：待实现消息推送功能时添加

## 常见问题

### 1. 登录失败，提示 code 无效

- code 只能使用一次，且有效期为5分钟
- 检查是否正确传递了 code 参数
- 确认 AppID 和 Secret 配置正确

### 2. 无法获取用户信息

- 检查后端服务是否正常运行
- 查看浏览器控制台和网络请求日志
- 确认小程序配置中的服务器域名已正确设置

### 3. 开发环境调试

在微信开发者工具中：
- 勾选「详情」->「本地设置」->「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」
- 使用真机调试时需要在公众平台配置测试域名

## 安全建议

1. **不要将 AppSecret 提交到代码仓库**
2. 生产环境建议使用环境变量或配置中心管理敏感信息
3. 定期更换 AppSecret
4. Token 应该设置过期时间并实现刷新机制
5. 考虑添加签名验证防止请求篡改
