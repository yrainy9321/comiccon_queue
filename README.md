# 漫展排队叫号系统

## 🎯 项目简介

这是一个完整的漫展排队叫号系统，包含：
- **微信小程序端**：用户扫码绑定手环、查看排队状态
- **Web管理后台**：活动管理、手环绑定、叫号操作、用户管理
- **微信登录功能**：静默获取用户OpenID，支持消息模板推送

## 🚀 快速启动

### 1. 安装依赖

```bash
cd /Users/bawangchaji/Documents/课程/kaifa/comiccon-queue
npm install
```

### 2. 配置微信小程序

在 `backend` 目录创建 `.env` 文件：

```bash
cp backend/.env.example backend/.env
```

编辑 `.env`，填入你的微信小程序配置：

```env
# 微信小程序配置
WECHAT_APPID=wx1234567890abcdef
WECHAT_SECRET=your_secret_here

# 消息模板ID（用于排队通知）
WECHAT_TEMPLATE_REMINDER_5=提前5位提醒模板ID
WECHAT_TEMPLATE_CALLED=叫号通知模板ID
WECHAT_TEMPLATE_MISSED=过号提醒模板ID

PORT=3000
```

**注意**：如果不配置微信登录，系统仍可正常运行，只是无法获取用户OpenID和发送消息推送。

详细配置说明请查看：[消息模板配置指南](docs/message-template-config.md)

### 3. 启动服务

```bash
npm start
# 或开发模式（自动重启）
npm run dev
```

## 📱 访问地址

- **管理后台**：http://localhost:3000/admin/index.html
- **后端API**：http://localhost:3000/api

## 👤 默认账号

- 用户名：admin
- 密码：admin123

## ✨ 核心功能

### 微信小程序端

#### 1. 微信静默登录（新增）
- ✅ 首次进入自动获取用户OpenID
- ✅ 无需用户操作，无感登录
- ✅ 本地缓存，避免重复登录
- ✅ 为消息模板推送做准备

#### 2. 扫码绑定手环
- 扫描活动二维码
- 自动绑定手环和分配号码
- 实时显示排队状态

#### 3. 排队状态查询
- 查看当前叫号进度
- 查看自己的排队位置
- ✅ 接收微信消息推送（提前5位提醒、叫号通知、过号提醒）

### Web管理后台

#### 1. 控制台
- 查看活动总数、排队总人数、已叫号数量

#### 2. 活动管理
- 创建、编辑、删除活动
- 设置活动名称、描述、绑定模式（顺序/随机）

#### 3. 手环绑定
- 选择已有活动
- 选择绑定模式：顺序模式（自动分配序号）或随机模式（手动输入号码）
- 扫码或手动输入手环编号
- 随机模式下自动填入当前最大号码，可修改

#### 4. 叫号管理
- 选择活动
- 手动输入任意号码进行叫号
- 查看当前叫号状态和排队人数
- 查看排队列表

#### 5. 用户管理（仅管理员）
- 添加、编辑、删除用户
- 设置用户角色（管理员/工作人员）
- 分配权限：活动管理、手环绑定、叫号操作、排队查看、系统设置

#### 6. 系统设置
- 修改当前用户密码

## 🔧 API 接口

### 微信登录相关

#### POST /api/wechat/login
通过微信code获取用户openid

**请求：**
```json
{
  "code": "wx.login()返回的临时code"
}
```

**响应：**
```json
{
  "success": true,
  "openid": "oXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "token": "随机生成的token",
  "isNewUser": true
}
```

#### GET /api/wechat/user
获取当前登录用户信息

**请求头：**
```
Authorization: Bearer {token}
```

**响应：**
```json
{
  "success": true,
  "openid": "oXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "lastLoginAt": "2026-04-27T12:00:00.000Z"
}
```

### 其他接口

详见原README中的接口说明...

## 📊 权限说明

| 权限 | 说明 |
|------|------|
| admin | 管理员（拥有所有权限） |
| activity.manage | 活动管理 |
| queue.bind | 手环绑定 |
| queue.call | 叫号操作 |
| queue.view | 排队查看 |
| settings.manage | 系统设置 |

## 💻 技术栈

### 后端
- Node.js + Express
- 文件系统存储（JSON文件）
- Axios（HTTP请求）

### 前端（小程序）
- 微信小程序原生框架
- 本地存储（StorageSync）

### 前端（Web）
- 原生 HTML/CSS/JavaScript
- 无需数据库，数据存储在文件中

## 📖 详细文档

- [微信登录配置指南](docs/wechat-login.md) - 详细的微信登录配置步骤
- [微信小程序官方文档](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)

## 🔐 安全建议

1. **保护AppSecret**：不要将密钥提交到代码仓库
2. **Token过期**：生产环境应实现token过期和刷新机制
3. **HTTPS**：生产环境必须使用HTTPS
4. **签名验证**：重要接口建议添加签名验证
5. **频率限制**：登录接口应添加防刷限制

## 🧪 测试微信登录

1. 配置好微信小程序AppID和Secret
2. 在微信开发者工具中导入 `frontend` 目录
3. 勾选「不校验合法域名」（开发阶段）
4. 编译运行，查看控制台日志
5. 访问测试页面 `pages/test-login/index` 查看登录状态

## 📢 测试消息推送

### 快速测试

```bash
cd backend
node test-message.js
```

这个脚本会：
1. 检查配置是否正确
2. 获取 access_token
3. 发送测试消息到你的微信

### 完整测试流程

1. **配置消息模板** - 参考 [消息模板配置指南](docs/message-template-config.md)
2. **绑定手环** - 在小程序中绑定手环到微信用户
3. **叫号测试** - 使用管理后台进行叫号，验证消息推送
4. **查看日志** - 检查服务器输出确认消息发送状态

详细调试方法请查看：[消息模板调试指南](docs/message-template-testing.md)

## 📝 后续扩展

获取到openid后，可以实现：

- ✅ 模板消息推送（排队叫号通知）- **已实现**
- ⏳ 用户行为分析
- ⏳ 个性化推荐
- ⏳ 用户画像构建
- ⏳ 跨设备同步
- ✅ 个性化推荐
- ✅ 用户画像构建
- ✅ 跨设备同步

## ❓ 常见问题

**Q: 为什么登录失败？**
A: 检查AppID和Secret是否正确，code是否已过期（有效期5分钟）

**Q: 如何获取AppID和Secret？**
A: 登录微信公众平台 -> 开发 -> 开发管理 -> 开发设置

**Q: 开发时需要配置域名吗？**
A: 开发阶段可以在开发者工具中勾选「不校验合法域名」

**Q: openid会变化吗？**
A: 同一用户在同一小程序的openid是固定不变的

**Q: 不配置微信登录能用吗？**
A: 可以，系统仍可正常运行，只是无法获取用户OpenID用于消息推送

## 📄 License

MIT
