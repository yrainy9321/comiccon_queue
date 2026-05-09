#!/usr/bin/env node

/**
 * 消息推送测试脚本
 * 用于快速测试微信消息模板配置是否正确
 */

const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

/** 默认本机；测局域网手机访问时可设 API_BASE_URL=http://172.16.102.3:3000/api */
const BASE_URL =
  (process.env.API_BASE_URL && String(process.env.API_BASE_URL).trim()) ||
  'http://localhost:3000/api';

// 从环境变量读取配置
const CONFIG = {
  appid: process.env.WECHAT_APPID,
  secret: process.env.WECHAT_SECRET,
  templates: {
    reminder5: process.env.WECHAT_TEMPLATE_REMINDER_5,
    called: process.env.WECHAT_TEMPLATE_CALLED,
    missed: process.env.WECHAT_TEMPLATE_MISSED
  }
};

console.log('=== 微信小程序消息推送测试工具 ===\n');

// 检查配置
function checkConfig() {
  console.log('1. 检查配置...\n');

  const issues = [];

  if (!CONFIG.appid || CONFIG.appid === 'your_appid') {
    issues.push('WECHAT_APPID 未配置');
  }

  if (!CONFIG.secret || CONFIG.secret === 'your_secret') {
    issues.push('WECHAT_SECRET 未配置');
  }

  if (!CONFIG.templates.reminder5 || CONFIG.templates.reminder5 === 'Ahead5ReminderTemplateId') {
    issues.push('WECHAT_TEMPLATE_REMINDER_5 未配置');
  }

  if (!CONFIG.templates.called || CONFIG.templates.called === 'CalledTemplateId') {
    issues.push('WECHAT_TEMPLATE_CALLED 未配置');
  }

  if (!CONFIG.templates.missed || CONFIG.templates.missed === 'MissedTemplateId') {
    issues.push('WECHAT_TEMPLATE_MISSED 未配置');
  }

  if (issues.length > 0) {
    console.log('❌ 配置问题:');
    issues.forEach(issue => console.log(`   - ${issue}`));
    console.log('\n请先在 backend/.env 文件中配置以上参数\n');
    return false;
  }

  console.log('✓ AppID:', CONFIG.appid);
  console.log('✓ AppSecret:', CONFIG.secret ? '***' + CONFIG.secret.slice(-4) : '未设置');
  console.log('✓ 提前5位提醒模板ID:', CONFIG.templates.reminder5);
  console.log('✓ 叫号通知模板ID:', CONFIG.templates.called);
  console.log('✓ 过号提醒模板ID:', CONFIG.templates.missed);
  console.log('\n✓ 配置检查通过\n');
  return true;
}

// 获取access_token
async function getAccessToken() {
  console.log('2. 获取 access_token...\n');

  try {
    const response = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: {
        grant_type: 'client_credential',
        appid: CONFIG.appid,
        secret: CONFIG.secret
      }
    });

    const { access_token, expires_in, errcode, errmsg } = response.data;

    if (errcode) {
      console.log('❌ 获取 access_token 失败');
      console.log(`   错误码: ${errcode}`);
      console.log(`   错误信息: ${errmsg}`);
      console.log('\n请检查 AppID 和 AppSecret 是否正确\n');
      return null;
    }

    console.log('✓ access_token 获取成功');
    console.log(`   Token: ${access_token.slice(0, 10)}...`);
    console.log(`   有效期: ${expires_in} 秒\n`);
    return access_token;
  } catch (error) {
    console.log('❌ 请求失败:', error.message);
    return null;
  }
}

// 测试发送消息
async function testSendMessage(accessToken, openid, templateId, templateName, data) {
  console.log(`3. 测试发送 ${templateName}...\n`);

  if (!openid) {
    console.log('⚠️  跳过测试: 需要提供测试用的 openid\n');
    console.log('提示: 可以通过小程序登录获取 openid');
    console.log('或者查看 backend/data/wechat_users.json 文件\n');
    return false;
  }

  try {
    const response = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
      {
        touser: openid,
        template_id: templateId,
        page: '/pages/status/index',
        data: data,
        miniprogram_state: 'developer' // 开发版
      }
    );

    const { errcode, errmsg } = response.data;

    if (errcode === 0) {
      console.log(`✓ ${templateName} 发送成功!`);
      console.log(`   接收用户: ${openid}`);
      console.log(`   模板ID: ${templateId}\n`);
      return true;
    } else {
      console.log(`❌ ${templateName} 发送失败`);
      console.log(`   错误码: ${errcode}`);
      console.log(`   错误信息: ${errmsg}`);

      // 提供常见错误的解决方案
      console.log('\n可能的原因:');
      switch (errcode) {
        case 40037:
          console.log('   - 模板ID不正确,请检查微信公众平台的模板ID');
          break;
        case 40003:
          console.log('   - openid 不正确或用户未关注小程序');
          break;
        case 47003:
          console.log('   - 模板参数格式错误或参数缺失');
          break;
        case 48001:
          console.log('   - 没有权限使用该模板或模板未审核通过');
          break;
        default:
          console.log(`   - 未知错误,请参考微信文档错误码 ${errcode}`);
      }
      console.log();
      return false;
    }
  } catch (error) {
    console.log(`❌ ${templateName} 请求失败:`, error.message);
    return false;
  }
}

// 主函数
async function main() {
  // 1. 检查配置
  if (!checkConfig()) {
    process.exit(1);
  }

  // 2. 获取 access_token
  const accessToken = await getAccessToken();
  if (!accessToken) {
    process.exit(1);
  }

  // 3. 获取测试openid
  const fs = require('fs');
  const path = require('path');
  const wechatUsersPath = path.join(__dirname, 'data', 'wechat_users.json');

  let testOpenid = null;

  if (fs.existsSync(wechatUsersPath)) {
    try {
      const wechatUsers = JSON.parse(fs.readFileSync(wechatUsersPath, 'utf8'));
      const users = Object.values(wechatUsers);
      if (users.length > 0) {
        testOpenid = users[0].openid;
        console.log(`找到测试用户 openid: ${testOpenid}\n`);
      }
    } catch (e) {
      console.log('读取微信用户文件失败\n');
    }
  }

  if (!testOpenid) {
    console.log('⚠️  未找到测试用户\n');
    console.log('请先在小程序中完成登录,或手动输入测试用的 openid');
    console.log('按回车继续,或直接按 Ctrl+C 退出\n');

    // 等待用户输入
    await new Promise(resolve => {
      process.stdin.once('data', data => {
        const input = data.toString().trim();
        if (input) {
          testOpenid = input;
        }
        resolve();
      });
    });

    if (!testOpenid) {
      console.log('未提供 openid,退出测试');
      process.exit(0);
    }
  }

  // 4. 测试三种消息模板
  const results = {
    success: 0,
    failed: 0
  };

  // 测试提前5位提醒
  const reminder5Result = await testSendMessage(
    accessToken,
    testOpenid,
    CONFIG.templates.reminder5,
    '提前5位提醒',
    {
      thing1: { value: '漫展排队活动' },
      number2: { value: '5' },
      number3: { value: '123' },
      time4: { value: new Date().toLocaleString('zh-CN') }
    }
  );
  reminder5Result ? results.success++ : results.failed++;

  // 测试叫号通知
  const calledResult = await testSendMessage(
    accessToken,
    testOpenid,
    CONFIG.templates.called,
    '叫号通知',
    {
      thing1: { value: '漫展排队活动' },
      number2: { value: '123' },
      time3: { value: new Date().toLocaleString('zh-CN') }
    }
  );
  calledResult ? results.success++ : results.failed++;

  // 测试过号提醒
  const missedResult = await testSendMessage(
    accessToken,
    testOpenid,
    CONFIG.templates.missed,
    '过号提醒',
    {
      thing1: { value: '漫展排队活动' },
      number2: { value: '123' },
      time3: { value: new Date().toLocaleString('zh-CN') },
      thing4: { value: '请尽快前往办理' }
    }
  );
  missedResult ? results.success++ : results.failed++;

  // 5. 总结
  console.log('=== 测试结果汇总 ===\n');
  console.log(`成功: ${results.success}/3`);
  console.log(`失败: ${results.failed}/3\n`);

  if (results.failed === 0) {
    console.log('🎉 所有消息模板测试通过!');
    console.log('现在可以在小程序中正常使用消息推送功能了。\n');
  } else {
    console.log('⚠️  部分消息模板测试失败,请根据上面的错误信息进行调整。');
    console.log('常见问题解决方案请查看: docs/message-template-testing.md\n');
  }
}

// 运行测试
main().catch(error => {
  console.error('测试异常:', error);
  process.exit(1);
});
