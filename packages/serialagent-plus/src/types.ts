/**
 * Serial Agent Plus 共享类型定义
 *
 * 被 extension.ts、bridge-server.ts、测试桩共用。
 * 抽取为独立模块以支持 BridgeServer 单元测试（无需依赖 vscode）。
 */

/** listPorts 选项：快扫仅 serialport.list，全量含 Windows 元数据 */
export interface ListPortsOptions {
  metadata?: 'full' | 'skip';
  forceMetadata?: boolean;
}

/** 串口设备信息 */
export interface PortInfo {
  path: string;
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
  serialNumber?: string;
  pnpId?: string;
  friendlyName?: string;
  driverLabel?: string;
}

export type SerialFlowControl = 'none' | 'rtscts' | 'xon' | 'xoff';

/** 串口文本编码（接收解码与发送编码共用） */
export type SerialEncoding = 'utf8' | 'gbk';

/** 串口完整配置（连接参数 + 显示选项） */
export interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  stopBits: 1 | 1.5 | 2;
  flowControl: SerialFlowControl;
  lineEnding: 'none' | 'lf' | 'crlf' | 'cr';
  showTimestamp: boolean;
  hexMode: boolean;
  encoding: SerialEncoding;
  /** HEX 显示模式的空闲换行阈值：字节间隔超过该毫秒数即提交为一行（文本模式不换行） */
  rxIdleWrapMs: number;
  /** 日志缓冲上限（KB）：日志区显示与扩展日志缓冲（Save/MCP 回看）共用，默认 1024，最大 10240 */
  logBufferKB: number;
}

export const DEFAULT_CONFIG: SerialConfig = {
  port: '',
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none',
  lineEnding: 'none',
  showTimestamp: false,
  hexMode: false,
  encoding: 'utf8',
  rxIdleWrapMs: 20,
  logBufferKB: 1024,
};

/**
 * SerialManager 接口 — BridgeServer 所需的串口操作抽象
 *
 * 真实 SerialManager 和 MockSerialManager 均实现此接口，
 * 使 BridgeServer 可在测试中使用 Mock 替代。
 */
export interface ISerialManager {
  readonly isConnected: boolean;
  readonly isReconnecting: boolean;
  readonly currentPath: string;
  readonly currentBaudRate: number;
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly config: SerialConfig;

  listPorts(options?: ListPortsOptions): Promise<PortInfo[]>;
  connect(config: SerialConfig): Promise<boolean>;
  disconnect(): Promise<void>;
  send(data: string, hexMode: boolean, lineEnding: string): Promise<boolean>;
  getLogBuffer(): string[];
  clearLog(): void;
  resetCounters(): void;
  updateSettings(partial: Partial<SerialConfig>): void;

  /** 注入一行日志到缓冲区（用于 Bridge API Echo 等场景） */
  injectLog(line: string): void;

  /** 注入 TX 回显日志（MCP 发送），showTimestamp 开启时日志缓冲每行带时间戳前缀（webview 通道保持原始行） */
  injectTxLog(data: string, hexMode?: boolean): void;

  /** 订阅新日志行（增量监听，用于 wait_for_output） */
  onNewLog(callback: (line: string) => void): void;
  /** 取消订阅新日志行 */
  offNewLog(callback: (line: string) => void): void;
}

/**
 * 日志输出接口 — 抽象 vscode.OutputChannel
 *
 * 在 VS Code 中使用 OutputChannel 实现，
 * 在测试中使用简单的 console 或 noop 实现。
 */
export interface ILogger {
  appendLine(value: string): void;
}
