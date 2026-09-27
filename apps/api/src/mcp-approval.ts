import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { requireBotThread, updateBlocks } from "./bot-thread.js";

/** Dependencies for resolving pending MCP approval cards in a bot's thread. */
export type McpApprovalDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
};

/** Flip every pending mcp_approval card for this bot and server to its final
    state so the card keeps rendering the decision after chats remount. */
export async function resolveMcpApprovalCards(
  deps: McpApprovalDeps,
  actor: Actor,
  botId: string,
  serverId: string,
  status: "connected" | "dismissed",
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const messages = await deps.prisma.message.findMany({
    where: { threadId: thread.id },
    select: { id: true, blocks: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    type PendingApproval = Extract<MessageBlock, { kind: "mcp_approval" }>;
    const matches = (block: MessageBlock): block is PendingApproval =>
      block.kind === "mcp_approval" && block.serverId === serverId && block.status === "pending";
    if (!blocks.some(matches)) continue;
    const next = blocks.map((block) => (matches(block) ? { ...block, status } : block));
    await updateBlocks(deps, target, message.id, next);
  }
}
