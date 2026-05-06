# 消息模板调试指南

## 快速开始

### 1. 配置环境变量

在 `backend` 目录下创建 `.env` 文件:

```env
# 微信小程序配置（从微信公众平台获取）
WECHAT_APPID=wx你的appid
WECHAT_SECRET=你的appsecret

# 消息模板ID（从微信公众平台订阅消息模板获取）
WECHAT_TEMPLATE_REMINDER_5=你的提前5位提醒模板ID
WECHAT_TEMPLATE_CALLED=你的叫号通知模板ID
WECHAT_TEMPLATE_MISSED=你的过号提醒模板ID

# 服务器配置
PORT=3000
```

### 2. 启动服务器

```bash
cd backend
npm start
```

你会看到:
```
服务器运行在 http://localhost:3000
默认管理员: admin / admin123
数据存储目录: /path/to/data
```

### 3. 测试流程

#### 步骤1: 微信登录获取openid

使用微信开发者工具打开小程序,会自动登录并获取openid。

查看控制台输出:
```
获取到code: 071xxx...
微信登录成功, openid: oXXXXX...
是否新用户: true
```

#### 步骤2: 绑定手环

在小程序中:
1. 进入"绑定手环"页面
2. 选择活动
3. 输入手环编号(例如: BRACELET001)
4. 点击"绑定"

查看服务器日志:
```
手环 BRACELET001 已绑定到微信用户 oXXXXX...
```

此时会创建两个数据:
- `queues.json` - 排队记录
- `bracelet_bindings.json` - 手环与微信的绑定关系

#### 步骤3: 模拟叫号

**方法A: 使用curl测试**

```bash
# 先获取admin token
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# 假设返回token为: abc123...

# 叫号 - 叫号码1
curl -X POST http://localhost:3000/api/queue/call \
  -H "Content-Type: application/json" \
  -H "Authorization: abc123..." \
  -d '{"activityId":"ACT20260427001","number":1}'
```

**方法B: 使用管理后台**

1. 浏览器访问: http://localhost:3000/admin
2. 登录: admin / admin123
3. 进入"叫号"页面
4. 输入号码进行叫号

#### 步骤4: 验证消息推送

当叫号时,服务器会:

1. 查找该号码对应手环的openid
2. 判断是正常叫号还是过号
3. 发送对应的订阅消息
4. 输出日志:

```
发送叫号通知: 手环=BRACELET001, 号码=1
获取到新的access_token
消息发送成功: openid=oXXXXX..., template=CalledTemplateId
```

如果收到的是过号通知:
```
发送过号通知: 手环=BRACELET001, 号码=1
消息发送成功: openid=oXXXXX..., template=MissedTemplateId
```

#### 步骤5: 测试提前5位提醒

连续叫号,当叫到某个号码时,系统会自动检查是否有用户前面还有5人:

例如当前叫到号码10,系统会检查号码15的用户是否存在,如果存在且未发送过提醒,则发送:

```
已发送提前5位提醒: 手环=BRACELET006, 号码=15
发送提前5位提醒: 手环=BRACELET006, 号码=15
消息发送成功: openid=oYYYYY..., template=Ahead5ReminderTemplateId
```

## 调试技巧

### 1. 查看数据文件

所有数据都存储在 `backend/data/` 目录下:

```bash
# 查看手环绑定关系
cat backend/data/bracelet_bindings.json

# 查看排队记录
cat backend/data/queues.json

# 查看微信用户
cat backend/data/wechat_users.json
```

### 2. 清空数据重新测试

```bash
# 删除所有数据文件
rm backend/data/*.json

# 重启服务器
npm start
```

### 3. 模拟多个用户

创建多个测试手环绑定:

```bash
# 绑定第1个手环
curl -X POST http://localhost:3000/api/wechat/bind-bracelet \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"braceletId":"TEST001"}'

# 绑定第2个手环(需要另一个微信账号)
# ...
```

### 4. 检查消息发送状态

在 `queues.json` 中可以看到每条记录的 `reminderSent` 字段:

```json
{
  "_id": "123456",
  "activityId": "ACT20260427001",
  "手环编号": "BRACELET001",
  "号码": 1,
  "status": "called",
  "reminderSent": true,  // 表示已发送提前5位提醒
  "calledAt": "2026-04-27T10:00:00.000Z"
}
```

## 常见问题排查

### 问题1: 收不到消息

**检查清单:**
- [ ] 用户是否在小程序中授权了订阅消息?
- [ ] 模板ID是否正确配置在 `.env` 文件中?
- [ ] 手环是否正确绑定到微信用户?
- [ ] 服务器日志显示消息发送成功了吗?
- [ ] access_token获取成功了吗?

**解决方案:**
```bash
# 1. 检查手环绑定
cat backend/data/bracelet_bindings.json

# 2. 检查服务器日志
# 应该看到类似输出:
# 手环 XXX 已绑定到微信用户 YYY
# 发送叫号通知: 手环=XXX, 号码=ZZZ
# 消息发送成功: openid=YYY, template=TEMPLATE_ID
```

### 问题2: 提示"未找到手环绑定的微信用户"

**原因:** 手环没有正确绑定到微信用户

**解决方案:**
1. 确保在小程序中完成了绑定操作
2. 检查 `bracelet_bindings.json` 文件是否存在且有数据
3. 确认手环编号完全一致(注意大小写)

### 问题3: 消息发送失败,错误码40037

**原因:** 模板ID不正确

**解决方案:**
1. 登录微信公众平台
2. 进入"功能" -> "订阅消息" -> "我的模板"
3. 复制正确的模板ID
4. 更新 `.env` 文件中的模板ID
5. 重启服务器

### 问题4: 消息发送失败,错误码48001

**原因:** 没有权限使用该模板或模板未审核通过

**解决方案:**
1. 确认模板已添加到你自己的小程序
2. 确认模板已审核通过(或使用体验版)
3. 检查小程序类目是否支持该模板

### 问题5: 提前5位提醒没有触发

**可能原因:**
1. 用户已经接收过提醒(reminderSent=true)
2. 目标号码不存在或状态不是waiting
3. 手环未绑定微信用户

**解决方案:**
```bash
# 重置提醒标记,允许再次发送
# 编辑 queues.json,将 reminderSent 改为 false
```

## API测试示例

### 1. 微信登录

```bash
curl -X POST http://localhost:3000/api/wechat/login \
  -H "Content-Type: application/json" \
  -d '{"code":"YOUR_CODE_FROM_WX_LOGIN"}'
```

响应:
```json
{
  "success": true,
  "openid": "oXXXXX...",
  "token": "abc123...",
  "isNewUser": true
}
```

### 2. 绑定手环

```bash
curl -X POST http://localhost:3000/api/wechat/bind-bracelet \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"braceletId":"TEST001"}'
```

响应:
```json
{
  "success": true,
  "message": "绑定成功",
  "braceletId": "TEST001"
}
```

### 3. 查询用户绑定信息

```bash
curl http://localhost:3000/api/queue/user/ACT20260427001/TEST001
```

响应:
```json
{
  "_id": "123456",
  "activityId": "ACT20260427001",
  "手环编号": "TEST001",
  "号码": 1,
  "status": "waiting",
  "boundBy": "admin",
  "createdAt": "2026-04-27T10:00:00.000Z"
}
```

### 4. 叫号

```bash
curl -X POST http://localhost:3000/api/queue/call \
  -H "Content-Type: application/json" \
  -H "Authorization: ADMIN_TOKEN" \
  -d '{"activityId":"ACT20260427001","number":1}'
```

响应:
```json
{
  "success": true,
  "calledNumber": 1
}
```

## 日志级别

可以通过设置环境变量控制日志详细程度:

```env
# .env
LOG_LEVEL=debug  # debug, info, warn, error
```

当前默认输出:
- 登录尝试
- 手环绑定
- 消息发送(成功/失败)
- access_token获取
- 错误信息

## 下一步

完成测试后:
1. 在微信公众平台提交模板审核
2. 配置生产环境的AppID和AppSecret
3. 部署到生产服务器
4. 在小程序中添加订阅消息授权按钮
5. 监控消息发送成功率
