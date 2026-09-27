import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, IsolationError, withTransactionRetry } from "@rakazo/db";
import { requireBotThread } from "./bot-thread.js";

/** Dependencies for resolving pending MCP approval cards in a bot's threads. */
export type McpApprovalDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
};

export type McpApprovalResolution = {
  botId: string;
  serverId: string;
  status: "connected" | "dismissed";
  /** The chat whose cards should resolve; defaults to the bot's own thread. */
  threadId?: string;
};

/** Whether this decision may create the bot's assignment. */
export type McpApprovalDecision = {
  assign: boolean;
};

export type ThreadSeq = {
  threadId: string;
  seq: number;
};

type ApprovalBlock = Extract<MessageBlock, { kind: "mcp_approval" }>;

function isApproval(block: MessageBlock, serverId: string): block is ApprovalBlock {
  return block.kind === "mcp_approval" && block.serverId === serverId;
}

function isOpen(block: ApprovalBlock): boolean {
  return block.status !== "connected" && block.status !== "dismissed";
}

async function threadsForDecision(
  deps: McpApprovalDeps,
  actor: Actor,
  input: McpApprovalResolution,
): Promise<{ id: string }[]> {
  if (!input.threadId) {
    try {
      const { thread } = await requireBotThread(deps, actor, input.botId);
      return [{ id: thread.id }];
    } catch (error) {
      if (error instanceof IsolationError) return [];
      throw error;
    }
  }
  const member = await deps.prisma.thread.findMany({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [{ botId: input.botId }, { group: { members: { some: { botId: input.botId } } } }],
    },
    select: { id: true },
  });
  if (member.length > 0) return member;
  // A bot removed from a group leaves its card behind. The bot still has to
  // belong to this actor; the fallback never opens another bot's direct chat.
  try {
    await requireBotThread(deps, actor, input.botId);
  } catch (error) {
    if (error instanceof IsolationError) return [];
    throw error;
  }
  return deps.prisma.thread.findMany({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      groupId: { not: null },
    },
    select: { id: true },
  });
}

async function threadsForBot(
  db: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
  botId: string,
): Promise<{ id: string }[]> {
  return db.thread.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [{ botId }, { group: { members: { some: { botId } } } }],
    },
    select: { id: true },
  });
}

async function rewriteCards(
  tx: Prisma.TransactionClient,
  actor: Actor,
  threads: { id: string }[],
  input: { botId: string; serverId: string; status: ApprovalBlock["status"] },
  selectable: (block: ApprovalBlock) => boolean,
): Promise<{ seqs: ThreadSeq[]; flipped: number; dismissed: boolean; connected: boolean }> {
  const seqs: ThreadSeq[] = [];
  let flipped = 0;
  let dismissed = false;
  let connected = false;
  for (const thread of threads) {
    const messages = await tx.message.findMany({
      where: { threadId: thread.id },
      select: { id: true, blocks: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    for (const message of messages) {
      const blocks = message.blocks as MessageBlock[];
      const matching = blocks.filter((block): block is ApprovalBlock =>
        isApproval(block, input.serverId),
      );
      if (matching.length === 0) continue;
      for (const block of matching) {
        if (block.status === "dismissed") dismissed = true;
        else if (block.status === "connected") connected = true;
      }
      if (!matching.some(selectable)) continue;
      const next = blocks.map((block) =>
        isApproval(block, input.serverId) && selectable(block)
          ? { ...block, status: input.status }
          : block,
      );
      await tx.message.update({ where: { id: message.id }, data: { blocks: next } });
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: thread.id,
        botId: input.botId,
        type: "thread.message.updated",
        payload: { messageId: message.id, role: "bot", blocks: next },
      });
      seqs.push({ threadId: thread.id, seq: event.seq });
      flipped += 1;
    }
  }
  return { seqs, flipped, dismissed, connected };
}

/** Flip every open mcp_approval card for this server. The read, the writes,
    and `effect` share one serializable transaction. `effect` runs only for an
    approval and sees `assign: false` when a dismissed card won the race, so
    the caller does not create an assignment the card can no longer show. */
export async function resolveMcpApprovalCards<T>(
  deps: McpApprovalDeps,
  actor: Actor,
  input: McpApprovalResolution,
  effect?: (tx: Prisma.TransactionClient, decision: McpApprovalDecision) => Promise<T>,
): Promise<T | undefined> {
  const threads = await threadsForDecision(deps, actor, input);
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const painted = await rewriteCards(tx, actor, threads, input, isOpen);
        const assign = painted.flipped > 0 || painted.connected || !painted.dismissed;
        const value = effect ? await effect(tx, { assign }) : undefined;
        return { seqs: painted.seqs, value };
      },
      { isolationLevel: "Serializable" },
    ),
  );
  for (const event of committed.seqs) await deps.events.notify(event.threadId, event.seq);
  return committed.value;
}

/** A removed assignment must not leave its card saying the server is connected.
    Pass `tx` to commit the repaint with the assignment change; otherwise this
    notifies after its own transaction. */
export async function revertConnectedMcpApprovals(
  deps: McpApprovalDeps,
  actor: Actor,
  input: { botId: string; serverId: string },
  tx?: Prisma.TransactionClient,
): Promise<ThreadSeq[]> {
  const paint = (client: Prisma.TransactionClient, threads: { id: string }[]) =>
    rewriteCards(
      client,
      actor,
      threads,
      { ...input, status: "pending" },
      (block) => block.status === "connected",
    ).then((painted) => painted.seqs);
  if (tx) return paint(tx, await threadsForBot(tx, actor, input.botId));
  const threads = await threadsForBot(deps.prisma, actor, input.botId);
  const seqs = await withTransactionRetry(() =>
    deps.prisma.$transaction((client) => paint(client, threads), {
      isolationLevel: "Serializable",
    }),
  );
  for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
  return seqs;
}
