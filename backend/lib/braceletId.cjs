'use strict';

/** 与后台扫码 MG#27 位、员工端、小程序绑定的手环编号校验（字符集 + 可选格式） */

const BRACELET_ID_MAX_LEN = 128;

function normalizeBraceletInput(v) {
  return String(v == null ? '' : v).trim();
}

/** @returns {string|null} 通过返回 null，否则为错误文案 */
function braceletIdCharError(s) {
  if (typeof s !== 'string' || !s.length) return '手环编号不能为空';
  if (s.length > BRACELET_ID_MAX_LEN) return `手环编号过长（最多 ${BRACELET_ID_MAX_LEN} 个字符）`;
  if (/\s/.test(s)) return '手环编号不能含空白字符';
  if (!/^[\p{L}\p{M}\p{N}\p{P}\p{S}]+$/u.test(s)) {
    return '手环编号仅支持中英文（大小写）、数字、标点与常见符号';
  }
  if (/\p{Extended_Pictographic}/u.test(s)) return '手环编号不能包含表情符号';
  if (/\p{C}/u.test(s)) return '手环编号包含非法字符';
  return null;
}

/**
 * @returns {{ ok: true, value: string } | { ok: false, error: string, value: string }}
 */
function validateBraceletIdStrictMg27(raw) {
  const value = normalizeBraceletInput(raw);
  const err = braceletIdCharError(value);
  if (err) return { ok: false, error: err, value };
  if (!/^MG#.{24}$/.test(value)) {
    return { ok: false, error: '手环编号格式不正确，应为 MG# 开头共 27 位', value };
  }
  return { ok: true, value };
}

/**
 * 仅字符集（不按 MG# 长度），用于 URL 等已有任意历史格式的校验
 * @returns {{ ok: true, value: string } | { ok: false, error: string, value: string }}
 */
function validateBraceletIdCharsOnly(raw) {
  const value = normalizeBraceletInput(raw);
  const err = braceletIdCharError(value);
  if (err) return { ok: false, error: err, value };
  return { ok: true, value };
}

module.exports = {
  BRACELET_ID_MAX_LEN,
  normalizeBraceletInput,
  braceletIdCharError,
  validateBraceletIdStrictMg27,
  validateBraceletIdCharsOnly
};
