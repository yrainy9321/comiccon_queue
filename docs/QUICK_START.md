# 微信登录功能 - 5分钟快速开始

## 🎯 目标

在5分钟内完成微信小程序静默登录功能的配置和测试。

## ⏱️ 时间分配

- 第1分钟：获取微信小程序凭证
- 第2分钟：配置后端环境变量
- 第3分钟：启动服务
- 第4分钟：配置小程序开发者工具
- 第5分钟：测试验证

---

## 第1分钟：获取微信小程序凭证

### 步骤

1. **访问微信公众平台**
   ```
   https://mp.weixin.qq.com/
   ```

2. **登录账号**
   - 使用你的小程序管理员微信扫码登录

3. **找到AppID和Secret**
   - 左侧菜单：开发 → 开发管理 → 开发设置
   - 复制 **AppID(小程序ID)**
   - 点击 **AppSecret(小程序密钥)** 旁的"重置"或"查看"
   - 保存好这两个值（Secret只显示一次）

📸 **截图位置**：
```
[开发设置页面]
├── AppID: wx1234567890abcdef ← 复制这个
└── AppSecret: ************* ← 生成并复制
```

---

## 第2分钟：配置后端

### 创建配置文件

在项目根目录执行：

```bash
cd /Users/bawangchaji/Documents/课程/kaifa/comiccon-queue
cp backend/.env.example backend/.env
```

### 编辑配置

用你喜欢的编辑器打开 `backend/.env`：

```bash
# macOS
open -e backend/.env

# 或使用其他编辑器
code backend/.env
vim backend/.env
```

填入你的配置：

```env
WECHAT_APPID=wx1234567890abcdef    # ← 替换为你的AppID
WECHAT_SECRET=your_secret_here     # ← 替换为你的Secret
PORT=3000
```

💡 **提示**：如果不配置，系统仍可运行，只是无法真正获取openid。

---

## 第3分钟：启动服务

### 安装依赖（如果还没安装）

```bash
npm install
```

### 启动后端

```bash
npm start
```

看到以下输出表示成功：

```
服务器运行在 http://localhost:3000
默认管理员: admin / admin123
数据存储目录: /path/to/backend/data
```

✅ 保持终端运行，不要关闭

---

## 第4分钟：配置小程序开发者工具

### 导入项目

1. **打开微信开发者工具**
   - 下载地址：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html

2. **导入项目**
   - 点击「+」或「导入项目」
   - 选择目录：`/Users/bawangchaji/Documents/课程/kaifa/comiccon-queue/frontend`
   - AppID：填写你在第1分钟获取的AppID
   - 项目名称：漫展排队（可自定义）

3. **关闭域名校验（开发阶段）**
   - 右上角「详情」→「本地设置」
   - ✅ 勾选「不校验合法域名、web-view（业务域名）、TLS版本以及HTTPS证书」

### 编译运行

点击左上角「编译」按钮

---

## 第5分钟：测试验证

### 方法1：查看控制台

1. 在开发者工具中切换到「Console」标签
2. 应该能看到类似输出：

```
App launched
获取到code: 071xxxxx
微信登录成功, openid: oXXXXXXXXXXXXXXXXXXXXXXXXXXX
是否新用户: true
用户信息已获取: {openid: "...", token: "..."}
```

### 方法2：访问测试页面

#### 临时修改首页为测试页

编辑 `frontend/app.json`，将test-login设为首页：

```json
{
  "pages": [
    "pages/test-login/index",  // ← 移到第一位
    "pages/index/index",
    "pages/status/index",
    "pages/bind/index"
  ]
}
```

重新编译后，你应该看到：

```
┌─────────────────────────┐
│   微信登录测试          │
├─────────────────────────┤
│ 登录状态：已登录 ✅      │
│ OpenID：oXXXXX...       │
│ Token：abc123...        │
│                         │
│ [重新登录] [查看全局数据]│
└─────────────────────────┘
```

#### 测试完成后恢复

记得把 `app.json` 改回去：

```json
{
  "pages": [
    "pages/index/index",  // ← 恢复原顺序
    "pages/status/index",
    "pages/bind/index",
    "pages/test-login/index"
  ]
}
```

### 方法3：检查数据文件

查看 `backend/data/wechat_users.json` 文件：

```bash
cat backend/data/wechat_users.json
```

应该能看到用户数据：

```json
{
  "oXXXXXXXXXXXXXXXXXXXXXXXXXXX": {
    "openid": "oXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "token": "随机生成的token字符串",
    "createdAt": "2026-04-27T07:57:00.000Z",
    "lastLoginAt": "2026-04-27T07:57:00.000Z"
  }
}
```

---

## ✅ 验证清单

完成以下检查确认功能正常：

- [ ] 后端服务正常运行在 http://localhost:3000
- [ ] 小程序能成功编译无报错
- [ ] 控制台显示"微信登录成功"
- [ ] 能获取到openid（格式：o开头的一串字符）
- [ ] backend/data/wechat_users.json 文件已创建
- [ ] 测试页面显示"已登录"状态

---

## ❓ 遇到问题？

### 问题1：登录失败，提示 invalid appid

**原因**：AppID配置错误  
**解决**：检查 `.env` 文件中的 `WECHAT_APPID` 是否正确

### 问题2：请求失败，网络错误

**原因**：后端服务未启动或端口被占用  
**解决**：
```bash
# 检查服务是否运行
lsof -i:3000

# 如果被占用，杀掉进程
lsof -ti:3000 | xargs kill -9

# 重新启动
npm start
```

### 问题3：开发者工具提示域名未配置

**原因**：未关闭域名校验  
**解决**：详情 → 本地设置 → 勾选「不校验合法域名」

### 问题4：获取不到openid

**原因**：可能是以下原因之一
- AppSecret配置错误
- code已过期（有效期5分钟）
- 网络连接问题

**解决**：
1. 检查控制台日志查看详细错误
2. 确认AppID和Secret正确
3. 重新编译小程序获取新的code

---

## 🎉 恭喜！

如果以上步骤都成功了，说明你已经：

✅ 完成了微信小程序静默登录的配置  
✅ 能够自动获取用户的OpenID  
✅ 为消息模板推送做好了准备  

接下来可以：
- 实现消息模板推送功能
- 集成到实际的业务流程中
- 部署到生产环境

---

## 📚 延伸阅读

- [详细配置文档](wechat-login.md)
- [实现总结](IMPLEMENTATION_SUMMARY.md)
- [项目README](../README.md)

---

## 💡 小贴士

1. **生产环境配置**
   - 必须配置HTTPS
   - 在微信公众平台配置合法的服务器域名
   - 不要提交 `.env` 文件到Git

2. **调试技巧**
   - 使用真机调试时也需要配置测试域名
   - 多查看控制台日志
   - 使用测试页面快速验证

3. **安全提醒**
   - AppSecret非常重要，妥善保管
   - 定期更换Secret
   - 不要在代码中硬编码密钥

祝你使用愉快！🚀
