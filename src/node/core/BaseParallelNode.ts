// File: src/node/core/BaseParallelNode.ts

import { CallbackSinkNode } from "../ToolPipelineNode";
import { Node } from "./Node";

export abstract class BaseParallelNode<TIn, TOut> extends Node<TIn, TOut> {
    protected readonly children: Node<any, TOut>[] = [];
    protected readonly bridge: CallbackSinkNode<TOut>;

    protected constructor(name?: string) {
        super(name);
        this.bridge = new CallbackSinkNode<TOut>(
            async (data) => {
                await this.dispatch(data);
            },
        );
    }

    public getManagedNodes(): ReadonlyArray<Node<any, any>> {
        return [...this.children];
    }

    protected addChildBuildTime(child: Node<any, TOut>): void {
        this.assertBuildTime("add child");
        this.children.push(child);
        this.wireChild(child);
    }

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

    protected wireChild(child: Node<any, TOut>): void {
        child.register(this.bridge as unknown as Node<TOut, any>);
    }

    protected unwireChild(child: Node<any, TOut>): void {
        child.unregister(this.bridge as unknown as Node<TOut, any>);
    }
}
