import { ConsumerNode, type Message, ProducerNode } from "./core/Node";

/**
 * ManualTriggerNode：手动触发的 producer。
 *
 * @remarks
 * 适用于：
 * - 把外部事件（HTTP/WS/用户输入）注入编排
 * - 在测试/示例中作为最小触发源
 */
export class ManualTriggerNode<T> extends ProducerNode<T> {
    /**
     * @param name 节点名称（用于日志/诊断）
     */
    constructor(name: string = "ManualTriggerNode") {
        super(name);
    }

    /**
     * 触发一次输出（使用当前时间作为 `Message.time`）。
     */
    public async trigger(data: T): Promise<void> {
        if (!this.started || this.disposed || this.abortSignal.aborted) {
            throw new Error(`${this.name} not started or already disposed`);
        }
        await this.dispatch(data);
    }

    /**
     * 触发一次输出，并指定 `Message.time`（常用于 event time）。
     */
    public async triggerAt(data: T, time: number): Promise<void> {
        if (!this.started || this.disposed || this.abortSignal.aborted) {
            throw new Error(`${this.name} not started or already disposed`);
        }
        await this.dispatchAt(data, time);
    }

    protected async onStart(): Promise<void> {}
    protected async onDispose(): Promise<void> {}
}

/**
 * CallbackSinkNode：将输入交给回调处理的 consumer（常用于“终端输出”或桥接）。
 *
 * @remarks
 * - 这是一个便捷工具节点：可以快速把编排结果交给任意 async handler
 * - `ChainNode/BaseParallelNode` 内部也使用它作为 bridge，把内部子图的输出接回组合节点
 */
export class CallbackSinkNode<T> extends ConsumerNode<T> {
    private readonly callback: (data: T) => void | Promise<void>;

    /**
     * @param callback 收到数据时执行的回调
     * @param name 节点名称（用于日志/诊断）
     */
    constructor(
        callback: (data: T) => void | Promise<void>,
        name?: string,
    ) {
        super(name);
        this.callback = callback;
    }

    protected override async onReceive(msg: Message<T>): Promise<void> {
        await this.callback(msg.data);
    }

    protected async onStart(): Promise<void> {}
    protected async onDispose(): Promise<void> {}
}
