import { CallbackSinkNode } from "../ToolPipelineNode";
import { Node } from "./Node";

/**
 * 并行类节点的抽象基类：负责 children 的生命周期与 fan-in bridge。
 *
 * @remarks
 * 子类通常只需要：
 * - build-time 调用 `addChildBuildTime()` 添加 child
 * - 在 `onStart/onDispose` 中分别调用 `startBase()/disposeBase()`
 */
export abstract class BaseParallelNode<TIn, TOut> extends Node<TIn, TOut> {
    protected readonly children: Node<any, TOut>[] = [];
    protected readonly bridge: CallbackSinkNode<TOut>;

    /**
     * @param name 节点名称（用于日志/诊断）
     */
    protected constructor(name?: string) {
        super(name);
        this.bridge = new CallbackSinkNode<TOut>(
            async (data) => {
                await this.dispatch(data);
            },
        );
    }

    /**
     * 组合节点声明：children 会被 Pipeline 作为 managed nodes 收集。
     *
     * @remarks
     * 注意：这里不返回 `bridge`（内部实现细节），避免干扰 Pipeline 拓扑推导。
     */
    public getManagedNodes(): ReadonlyArray<Node<any, any>> {
        return [...this.children];
    }

    /**
     * build-time 添加一个 child 并完成 wiring。
     */
    protected addChildBuildTime(child: Node<any, TOut>): void {
        this.assertBuildTime("add child");
        this.children.push(child);
        this.wireChild(child);
    }

    /**
     * 启动 bridge 与所有 children。
     *
     * @remarks
     * 对外暴露为 base 能力，子类可决定在其 `onStart()` 中何时调用。
     */
    protected async startBase(): Promise<void> {
        const started: Node<any, TOut>[] = [];
        let bridgeStarted = false;

        try {
            await this.bridge.start();
            bridgeStarted = true;

            for (const child of this.children) {
                await child.start();
                started.push(child);
            }
        } catch (e) {
            for (const c of [...started].reverse()) {
                try {
                    await c.dispose();
                } catch {}
            }

            if (bridgeStarted) {
                try {
                    await this.bridge.dispose();
                } catch {}
            }

            throw e;
        }
    }

    /**
     * 销毁所有 children 与 bridge（best-effort），并汇总输出错误日志。
     */
    protected async disposeBase(): Promise<void> {
        const r1 = await Promise.allSettled(
            this.children.map((c) => c.dispose()),
        );
        const r2 = await Promise.allSettled([this.bridge.dispose()]);

        const errors = [...r1, ...r2]
            .filter((r) => r.status === "rejected")
            .map((r) => (r as PromiseRejectedResult).reason);

        if (errors.length > 0) {
            console.error(`[${this.name}] dispose encountered errors`, errors);
        }
    }

    /**
     * 将 child 的输出接入本节点的 bridge（fan-in）。
     */
    protected wireChild(child: Node<any, TOut>): void {
        child.register(this.bridge as unknown as Node<TOut, any>);
    }

    /**
     * 将 child 从 bridge 上解除（fan-in 断开）。
     */
    protected unwireChild(child: Node<any, TOut>): void {
        child.unregister(this.bridge as unknown as Node<TOut, any>);
    }
}
