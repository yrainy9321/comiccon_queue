'use strict';
/**
 * 本地持久化系统日志（JSON Lines），便于排查真机/微信/接口问题。
 * 文件：backend/data/system_logs.jsonl，超限自动轮转 *.jsonl.bak
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_FILENAME = 'system_logs.jsonl';
const ENV_MAX = parseInt(String(process.env.SYSTEM_LOG_MAX_BYTES || ''), 10);
const MAX_BYTES =
  Number.isFinite(ENV_MAX) && ENV_MAX > 0 ? ENV_MAX : 12 * 1024 * 1024;

function getLogPath(dataDir = DEFAULT_DATA_DIR) {
  return path.join(dataDir, LOG_FILENAME);
}

function rotateIfNeeded(dataDir) {
  const p = getLogPath(dataDir);
  try {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.size < MAX_BYTES) return;
    const archive = path.join(dataDir, `system_logs_${Date.now()}.jsonl.bak`);
    fs.renameSync(p, archive);
  } catch (e) {
    console.error('[systemLogger] rotate', e.message);
  }
}

function redactMeta(meta) {
  if (meta == null) return undefined;
  if (typeof meta !== 'object') return { _note: String(meta).slice(0, 500) };
  try {
    const walk = (x) => {
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(x)) {
          const kl = String(k).toLowerCase();
          if (
            kl === 'password' ||
            kl === 'authorization' ||
            kl === 'secret' ||
            kl === 'wechat_secret' ||
            kl === 'js_code' ||
            kl === 'session_key'
          ) {
            out[k] = '[redacted]';
          } else if (
            (kl === 'token' || kl === 'accesstoken') &&
            typeof v === 'string' &&
            v.length > 10
          ) {
            out[k] = `${v.slice(0, 6)}…`;
          } else {
            out[k] = walk(v);
          }
        }
        return out;
      }
      if (typeof x === 'string' && x.length > 4000) return x.slice(0, 4000) + '…';
      return x;
    };
    return walk(meta);
  } catch {
    return {};
  }
}

function writeLine(dataDir, row) {
  const line = JSON.stringify(row) + '\n';
  rotateIfNeeded(dataDir);
  fs.appendFileSync(getLogPath(dataDir), line, 'utf8');
}

function logLevel(level, category, message, meta) {
  const dataDir = DEFAULT_DATA_DIR;
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const row = {
    ts: new Date().toISOString(),
    level,
    category: String(category || 'app').slice(0, 160),
    message: String(message == null ? '' : message).slice(0, 8000),
    meta: redactMeta(meta)
  };
  try {
    writeLine(dataDir, row);
  } catch (e) {
    console.error('[systemLogger] append', e.message);
  }
}

/**
 * 读取末尾若干行（适合大文件尾部）；默认最多读 1MB 文本再解析行。
 */
function readRecent(maxLines, maxReadBytes = 1024 * 1024) {
  const p = getLogPath(DEFAULT_DATA_DIR);
  if (!fs.existsSync(p)) return [];
  const st = fs.statSync(p);
  const fd = fs.openSync(p, 'r');
  try {
    const readSize = Math.min(st.size, maxReadBytes);
    const start = st.size - readSize;
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const i = text.indexOf('\n');
      if (i !== -1) text = text.slice(i + 1);
    }
    const lines = text.split('\n').filter((l) => l.trim());
    const tail = lines.slice(-maxLines);
    return tail.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { ts: null, level: 'parse', message: l.slice(0, 500) };
      }
    });
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  info: (category, message, meta) => logLevel('info', category, message, meta),
  warn: (category, message, meta) => logLevel('warn', category, message, meta),
  error: (category, message, meta) => logLevel('error', category, message, meta),
  debug: (category, message, meta) => logLevel('debug', category, message, meta),
  readRecent
};
