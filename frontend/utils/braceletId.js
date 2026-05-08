/** 与 backend/lib/braceletId.cjs 规则一致：仅中英文、数字、标点；禁止空白与 emoji */

var BRACELET_ID_MAX_LEN = 128;

function normalizeBraceletInput(v) {
  return String(v == null ? '' : v).trim();
}

/** @returns {string} 通过返回空串，否则为错误文案 */
function braceletIdCharError(s) {
  if (typeof s !== 'string' || !s.length) return '手环编号不能为空';
  if (s.length > BRACELET_ID_MAX_LEN) return '手环编号过长（最多' + BRACELET_ID_MAX_LEN + '个字符）';
  if (/\s/.test(s)) return '手环编号不能含空白字符';
  if (!/^[\p{L}\p{M}\p{N}\p{P}\p{S}]+$/u.test(s)) {
    return '手环编号仅支持中英文（大小写）、数字、标点与常见符号';
  }
  if (/\p{Extended_Pictographic}/u.test(s)) return '手环编号不能包含表情符号';
  if (/\p{C}/u.test(s)) return '手环编号包含非法字符';
  return '';
}

function validateBraceletIdStrictMg27(raw) {
  var value = normalizeBraceletInput(raw);
  var err = braceletIdCharError(value);
  if (err) return { ok: false, error: err, value: value };
  if (!/^MG#.{24}$/.test(value)) {
    return { ok: false, error: '手环编号格式不正确，应为 MG# 开头共 27 位', value: value };
  }
  return { ok: true, value: value };
}

module.exports = {
  BRACELET_ID_MAX_LEN: BRACELET_ID_MAX_LEN,
  normalizeBraceletInput: normalizeBraceletInput,
  braceletIdCharError: braceletIdCharError,
  validateBraceletIdStrictMg27: validateBraceletIdStrictMg27
};
