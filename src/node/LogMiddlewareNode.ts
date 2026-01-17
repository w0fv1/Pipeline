import { type Message, Node } from "./core/Node";

type LoggerLike =
  & Pick<Console, "log" | "error">
  & Partial<Pick<Console, "clear">>;

/**
 * 日志输出格式。
 * - `raw`：直接输出 msg.data
 * - `json`：尝试 `JSON.stringify(msg.data)`
 */
export type LogFormat =
  | "raw"
  | "json";

export interface LogMiddlewareOptions<TIn = unknown> {
  name?: string;
  /** 是否打印每条消息的业务日志 */
  logData?: boolean;
  /** 是否打印统计日志（每 statsLogIntervalMs 一次） */
  logStats?: boolean;

  /** 统计窗口大小（毫秒） */
  statsWindowMs?: number;
  /** 统计日志输出间隔（毫秒） */
  statsLogIntervalMs?: number;

  /** 是否在打印前清屏（适合做“实时仪表盘”） */
  clearBeforeLog?: boolean;

  /** 业务日志输出节流（ms，按 keySelector 分组；未提供则按全局节流） */
  minLogIntervalMs?: number;

  /** 为每条 msg 计算 key，用于节流/聚合（例如：按 scorer 名） */
  keySelector?: (msg: Message<TIn>) => string | undefined;

  /** 过滤要打印的消息（不影响下游透传） */
  filter?: (msg: Message<TIn>) => boolean;

  /** 日志格式；也可传入回调自定义输出（返回 undefined 表示不输出） */
  format?: LogFormat | ((msg: Message<TIn>) => unknown);

  /** 是否输出通用 meta（msgId/nodeName/time 等） */
  logMeta?: boolean;
}

/**
 * LogMiddlewareNode：用于观测/诊断的“旁路中间件”。
 *
 * @remarks
 * - 不改变数据：收到 `TIn`，日志后原样 `dispatch(TIn)`
 * - 支持：业务日志、节流、按 key 分组节流、统计窗口、定期 stats 输出、可选清屏
 */
export class LogMiddlewareNode<TIn = unknown> extends Node<TIn, TIn> {
  private readonly recentTimestamps: number[] = [];
  private recentHead = 0;
  private lastStatsLogAt = 0;

  private options: Required<LogMiddlewareOptions<TIn>>;
  private readonly logger: LoggerLike;

  private lastLogAtByKey = new Map<string, number>();

  constructor(
    options: LogMiddlewareOptions<TIn> = {},
    logger?: LoggerLike,
  ) {
    super(options.name);
    this.options = {
      name: options.name ?? this.name,
      logData: options.logData ?? true,
      logStats: options.logStats ?? true,
      statsWindowMs: options.statsWindowMs ?? 1000,
      statsLogIntervalMs: options.statsLogIntervalMs ?? 1000,
      clearBeforeLog: options.clearBeforeLog ?? false,
      minLogIntervalMs: options.minLogIntervalMs ?? 0,
      keySelector: options.keySelector ?? (() => undefined),
      filter: options.filter ?? (() => true),
      format: options.format ?? "raw",
      logMeta: options.logMeta ?? true,
    };
    this.logger = logger ?? console;
  }

  /**
   * 允许运行时动态调整开关/参数。
   *
   * @remarks
   * 会清空窗口状态，避免旧统计干扰新参数下的观测。
   */
  public setOptions(patch: LogMiddlewareOptions<TIn>): void {
    this.options = { ...this.options, ...patch } as Required<
      LogMiddlewareOptions<TIn>
    >;
    // 参数变更后，避免统计窗口残留导致误导
    this.recentTimestamps.length = 0;
    this.recentHead = 0;
    this.lastStatsLogAt = 0;
    this.lastLogAtByKey.clear();
  }

  protected async onStart(): Promise<void> {
    // no-op
  }

  protected async onReceive(msg: Message<TIn>): Promise<void> {
    const now = Date.now();
    const {
      logData,
      logStats,
      statsWindowMs,
      statsLogIntervalMs,
      clearBeforeLog,
      minLogIntervalMs,
      keySelector,
      filter,
      format,
      logMeta,
    } = this.options;

    // 1) 统计（可开关）
    if (logStats) {
      this.recentTimestamps.push(now);

      const cutoff = now - statsWindowMs;
      while (
        this.recentHead < this.recentTimestamps.length &&
        this.recentTimestamps[this.recentHead] < cutoff
      ) {
        this.recentHead += 1;
      }
      if (
        this.recentHead > 1024 &&
        this.recentHead * 2 > this.recentTimestamps.length
      ) {
        this.recentTimestamps.splice(0, this.recentHead);
        this.recentHead = 0;
      }

      // 3) 节流输出统计
      if (now - this.lastStatsLogAt >= statsLogIntervalMs) {
        this.lastStatsLogAt = now;
        this.safeLog(
          `[${this.name}] stats: last ${statsWindowMs}ms = ${
            this.recentTimestamps.length - this.recentHead
          } events`,
        );
      }
    }

    // 2) 业务日志（可开关）
    if (logData && filter(msg) && this.canLog(now, msg, keySelector)) {
      if (clearBeforeLog) {
        try {
          this.logger.clear?.();
        } catch {}
      }

      const payload = this.formatPayload(msg, format);
      if (payload !== undefined) {
        if (logMeta) {
          this.safeLog(
            `[${this.name}]`,
            `node=${msg.nodeName}`,
            `time=${new Date(msg.time).toISOString()}`,
            payload,
          );
        } else {
          this.safeLog(payload);
        }
      }

      const key = keySelector(msg) ?? "__global__";
      this.lastLogAtByKey.set(key, now);
    }

    // 3) 原样输出给下游
    await this.dispatch(msg.data);
  }

  protected async onDispose(): Promise<void> {
    this.recentTimestamps.length = 0;
    this.recentHead = 0;
    this.lastLogAtByKey.clear();
  }

  private canLog(
    now: number,
    msg: Message<TIn>,
    keySelector: (msg: Message<TIn>) => string | undefined,
  ): boolean {
    const min = this.options.minLogIntervalMs;
    if (min <= 0) return true;

    const key = keySelector(msg) ?? "__global__";
    const last = this.lastLogAtByKey.get(key) ?? 0;
    return now - last >= min;
  }

  private safeLog(...args: any[]): void {
    try {
      this.logger.log(...args);
    } catch {}
  }

  private formatPayload(
    msg: Message<TIn>,
    format: LogFormat | ((msg: Message<TIn>) => unknown),
  ): unknown {
    if (typeof format === "function") return format(msg);

    if (format === "json") {
      try {
        return JSON.stringify(msg.data);
      } catch {
        return String(msg.data);
      }
    }

    // raw
    return msg.data;
  }
}
