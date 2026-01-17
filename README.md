# Pipeline

一个轻量的编排（DAG）工具库，用来把一组可组合的异步 `Node` 串/并联起来，并通过 `Pipeline` 负责启动/销毁顺序与依赖拓扑。

## 特性

- `Node`：统一生命周期（`start/receive/dispose`）+ 消息分发（fan-out）
- `ChainNode`：串联多个节点
- `ParallelNode` / `ParallelProductNode`：并联 fan-out + fan-in（通过 bridge 回收）
- `Pipeline`：按依赖拓扑启动/销毁（支持 `keepAlive`）
- `LogMiddlewareNode`：轻量日志/统计中间件

## 安装（从 GitHub 引入）

把 `<owner>/<repo>` 替换成你的仓库地址：

```bash
# npm
npm i git+https://github.com/<owner>/<repo>.git

# pnpm
pnpm add github:<owner>/<repo>
```

安装自 GitHub 时会执行 `prepare` 自动构建 `dist/`。

## 快速开始

最小示例见 `examples/basic.ts`，运行：

```bash
npm run dev:example
```

在业务项目中使用：

```ts
import {
  CallbackSinkNode,
  ChainNode,
  ManualTriggerNode,
  Node,
  ParallelNode,
  Pipeline,
  type Message,
} from "@wofbi/pipeline";

class MapNode<TIn, TOut> extends Node<TIn, TOut> {
  constructor(private readonly map: (data: TIn, msg: Message<TIn>) => TOut | Promise<TOut>) {
    super();
  }
  protected async onStart() {}
  protected async onReceive(msg: Message<TIn>) {
    await this.dispatch(await this.map(msg.data, msg));
  }
  protected async onDispose() {}
}

const trigger = new ManualTriggerNode<number>("trigger");

const chain = new ChainNode<number, number>("main")
  .node(new MapNode((n) => n * 2))
  .stage(
    new ParallelNode<number, string>("branches")
      .node(new MapNode((n) => `double=${n}`))
      .node(new MapNode((n) => `square=${n * n}`)),
  )
  .node(new CallbackSinkNode((s) => console.log("[out]", s)));

trigger.register(chain);

const pipeline = new Pipeline().add(chain).add(trigger);
await pipeline.start();
await trigger.trigger(3);
await pipeline.dispose();
```

## 依赖编排（可选）

当你希望 “某个节点必须在另一个节点之后启动/之前销毁” 时，可以在节点 class 上声明静态依赖：

- `static dependency = { dependsOn: SomeNodeCtor }`
- `optional: true` 表示依赖不存在时不报错

`Pipeline` 会在所有受管理节点中，按 ctor 唯一性找到 provider，并构建拓扑顺序。

## Node 组合（Composite）

`Pipeline` 通过 `node.getManagedNodes()` 收集 “被某个组合节点管理的子节点”，从而把依赖/启动/销毁提升到 “ultimate anchor” 粒度，避免内部 bridge 节点干扰编排。

## 运行环境

- Node.js `>=18`
