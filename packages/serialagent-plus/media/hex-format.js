// HEX 发送回显格式化（纯函数，webview 与扩展宿主共用）。
//
// 发送框里 HEX 可能写成 "112233"，也可能写成 "41 42 0D 0A"。回显统一成大写、
// 两字符一组，既方便和文本发送（TX>> ...）区分，也不会因为输入写法不同而显示不一致。
(function (root) {
  /**
   * @param {string} text 用户输入的 HEX 文本
   * @returns {string} 规范化后的回显文本（如 "11 22 33"）；空输入返回空串
   */
  function normalizeHexInput(text) {
    const hex = String(text === undefined || text === null ? '' : text).replace(/\s+/g, '').toUpperCase();
    return hex.replace(/(..)/g, '$1 ').trim();
  }

  const api = { normalizeHexInput };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.HexFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
