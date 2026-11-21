// 终端“设备行”对齐策略（纯函数，webview 与单元测试共用）。
//
// 面板终端的本地行编辑不逐字符上送：平时设备 shell 的编辑缓冲为空，
// Enter/Tab 直接整行发送即可。但 ↑/↓ 历史、Tab 补全会触发设备 redraw，
// 并把结果同步回本地输入行，此时设备编辑缓冲里已持有同一行文本；
// 若再次整行发送，设备会把文本追加到自己缓冲里（"ls" -> "lsls" -> "lslsls"）。
// 因此发送前按 deviceLine 对齐：
//   - deviceLine 为 null：设备行为空，整行 + tail 发送；
//   - deviceLine === line：设备已持有该行，只发送 tail（CR / TAB）；
//   - 其它（同步后本地又编辑过）：先发 \b 逐字符清空设备行，再整行 + tail 发送。
(function (root) {
  /**
   * 计算对齐设备编辑行后需要发送的字节。
   * @param {string | null} deviceLine 设备 shell 编辑缓冲当前持有的行，null 表示为空/未知
   * @param {string} line 本地输入行当前内容
   * @param {string} tail 结尾控制字节（'\r' 或 '\t'）
   * @returns {string} 需要发送的字节序列
   */
  function reconcileBytes(deviceLine, line, tail) {
    if (deviceLine === null || deviceLine === undefined) {
      return line + tail;
    }
    if (line === deviceLine) {
      return tail;
    }
    return '\b'.repeat(deviceLine.length) + line + tail;
  }

  /**
   * RX 行模拟器：把设备回显/重绘字节流模拟成"当前显示行"。
   * - \b：光标左移；\r：光标归零（后续字符覆盖式重绘）；\n：提交当前行（feed 返回该行）
   * - CSI 序列按语义应用（RT-Thread msh 历史切换发送 "\033[2K\r" + 提示符 + 命令）：
   *   K=擦除（ESC[2K 整行 / ESC[K 光标到行尾 / ESC[1K 行首到光标），
   *   D/C=光标左/右移 n 格；其余（颜色等）忽略，保证日志行干净
   * - CSI 序列可跨 feed 分片积累（串口数据任意切分）
   * @returns {{ line: { text: string, cursor: number }, feed: (raw: string) => string[], reset: () => void }}
   */
  function createRxLineSimulator() {
    const line = { text: '', cursor: 0 };
    let escape = '';

    function applyCsi(seq) {
      const final = seq.charAt(seq.length - 1);
      const params = seq.slice(2, -1);
      if (final === 'K') {
        if (params === '1') {
          line.text = line.text.slice(line.cursor);
          line.cursor = 0;
        } else if (params === '2') {
          line.text = '';
        } else {
          // 空参数或 '0'：擦除光标到行尾
          line.text = line.text.slice(0, line.cursor);
        }
        if (line.cursor > line.text.length) { line.cursor = line.text.length; }
      } else if (final === 'D') {
        const n = Math.max(1, parseInt(params, 10) || 1);
        line.cursor = Math.max(0, line.cursor - n);
      } else if (final === 'C') {
        const n = Math.max(1, parseInt(params, 10) || 1);
        line.cursor = Math.min(line.text.length, line.cursor + n);
      }
    }

    function feed(raw) {
      const committed = [];
      for (const ch of raw) {
        if (escape !== '') {
          escape += ch;
          if (escape.length === 2) {
            if (ch !== '[') { escape = ''; } // 非 CSI（如 ESC O A），忽略
          } else {
            const code = ch.charCodeAt(0);
            if (code >= 0x40 && code <= 0x7e) {
              applyCsi(escape);
              escape = '';
            } else if (escape.length > 16) {
              escape = ''; // 异常长序列，丢弃
            }
          }
          continue;
        }
        if (ch === '\x1b') { escape = '\x1b'; continue; }
        if (ch === '\b') {
          if (line.cursor > 0) { line.cursor -= 1; }
        } else if (ch === '\r') {
          line.cursor = 0;
        } else if (ch === '\n') {
          committed.push(line.text);
          line.text = '';
          line.cursor = 0;
          escape = '';
        } else if (ch === '\x07' || ch < ' ') {
          // bell 等其他控制字符忽略
        } else if (line.cursor < line.text.length) {
          line.text = line.text.slice(0, line.cursor) + ch + line.text.slice(line.cursor + 1);
          line.cursor += 1;
        } else {
          line.text += ch;
          line.cursor = line.text.length;
        }
      }
      return committed;
    }

    function reset() {
      line.text = '';
      line.cursor = 0;
      escape = '';
    }

    return { line, feed, reset };
  }

  const api = { reconcileBytes, createRxLineSimulator };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TerminalDeviceLine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
