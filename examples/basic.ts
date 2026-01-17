import {
  CallbackSinkNode,
  ChainNode,
  LogMiddlewareNode,
  ManualTriggerNode,
  Node,
  ParallelNode,
  Pipeline,
  type Message,
} from "../src";

class MapNode<TIn, TOut> extends Node<TIn, TOut> {
  constructor(
    private readonly map: (data: TIn, msg: Message<TIn>) => TOut | Promise<TOut>,
    name?: string,
  ) {
    super(name);
  }

  protected async onStart(): Promise<void> {}

  protected async onReceive(msg: Message<TIn>): Promise<void> {
    const out = await this.map(msg.data, msg);
    await this.dispatch(out);
  }

  protected async onDispose(): Promise<void> {}
}

async function main(): Promise<void> {
  const trigger = new ManualTriggerNode<number>("trigger");

  const chain = new ChainNode<number, number>("main")
    .node(
      new LogMiddlewareNode<number>({
        name: "in",
        logStats: false,
        logMeta: true,
        format: (msg) => ({ in: msg.data }),
      }),
    )
    .node(new MapNode((n) => n * 2, "double"));

  const parallel = new ParallelNode<number, string>("branches")
    .node(new MapNode((n) => `double=${n}`, "asText"))
    .node(new MapNode((n) => `square=${n * n}`, "square"));

  chain
    .stage(parallel)
    .node(new CallbackSinkNode((s) => console.log("[out]", s), "print"));

  trigger.register(chain);

  const pipeline = new Pipeline().add(chain).add(trigger);
  await pipeline.start();

  await trigger.trigger(3);
  await trigger.trigger(7);

  // Give async fanout a moment to settle in this demo.
  await new Promise((r) => setTimeout(r, 50));
  await pipeline.dispose();
}

void main();
