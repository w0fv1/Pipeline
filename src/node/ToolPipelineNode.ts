import { ConsumerNode, type Message, ProducerNode } from "./core/Node";

export class ManualTriggerNode<T> extends ProducerNode<T> {
    constructor(name: string = "ManualTriggerNode") {
        super(name);
    }

    public async trigger(data: T): Promise<void> {
        if (!this.started || this.disposed || this.abortSignal.aborted) {
            throw new Error(`${this.name} not started or already disposed`);
        }
        await this.dispatch(data);
    }

    public async triggerAt(data: T, time: number): Promise<void> {
        if (!this.started || this.disposed || this.abortSignal.aborted) {
            throw new Error(`${this.name} not started or already disposed`);
        }
        await this.dispatchAt(data, time);
    }

    protected async onStart(): Promise<void> {}
    protected async onDispose(): Promise<void> {}
}

export class CallbackSinkNode<T> extends ConsumerNode<T> {
    private readonly callback: (data: T) => void | Promise<void>;

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
