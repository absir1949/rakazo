import type { Actor, MessageBlock } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  type PrismaClient,
  type ThreadEvents,
  withTransactionRetry,
} from "@rakazo/db";
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

/** Flip every pending mcp_approval card for this server to its final state so
    the card keeps rendering the decision after chats remount. Cards saved
    before this field existed have no status, which counts as pending. The
    read and the writes share one serializable transaction so concurrent
    decisions cannot overwrite each other's blocks. */
export async function resolveMcpApprovalCards(
  deps: McpApprovalDeps,
  actor: Actor,
  input: McpApprovalResolution,
): Promise<void> {
  // The explicit thread must belong to this bot: its own chat, or a group it
  // is a member of. A bot removed from a group leaves its card behind, so when
  // the bot-scoped lookup comes up empty the space owner may still resolve
  // that orphaned card: every bot and card in the space belongs to the actor.
  let threads = input.threadId
    ? await deps.prisma.thread.findMany({
        where: {
          id: input.threadId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          OR: [{ botId: input.botId }, { group: { members: { some: { botId: input.botId } } } }],
        },
        select: { id: true },
      })
    : [await requireBotThread(deps, actor, input.botId)].map(({ thread }) => ({ id: thread.id }));
  if (input.threadId && threads.length === 0) {
    threads = await deps.prisma.thread.findMany({
      where: { id: input.threadId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    });
  }
  type PendingApproval = Extract<MessageBlock, { kind: "mcp_approval" }>;
  const matches = (block: MessageBlock): block is PendingApproval =>
    block.kind === "mcp_approval" &&
    block.serverId === input.serverId &&
    block.status !== "connected" &&
    block.status !== "dismissed";

  for (const thread of threads) {
    await withTransactionRetry(() => {
      // Reset per attempt: a rolled-back attempt must not leave stale seqs.
      const eventSeqs: number[] = [];
      return deps.prisma.$transaction(
        async (tx) => {
          const messages = await tx.message.findMany({
            where: { threadId: thread.id },
            select: { id: true, blocks: true },
            orderBy: { createdAt: "desc" },
            take: 100,
          });
          for (const message of messages) {
            const blocks = message.blocks as MessageBlock[];
            if (!blocks.some(matches)) continue;
            const next = blocks.map((block) =>
              matches(block) ? { ...block, status: input.status } : block,
            );
            await tx.message.update({ where: { id: message.id }, data: { blocks: next } });
            const event = await appendEventInTransaction(tx, {
              spaceId: actor.spaceId,
              threadId: thread.id,
              botId: input.botId,
              type: "thread.message.updated",
              payload: { messageId: message.id, role: "bot", blocks: next },
            });
            eventSeqs.push(event.seq);
          }
          return eventSeqs;
        },
        { isolationLevel: "Serializable" },
      );
    }).then(async (eventSeqs) => {
      for (const seq of eventSeqs) await deps.events.notify(thread.id, seq);
    });
  }
}
