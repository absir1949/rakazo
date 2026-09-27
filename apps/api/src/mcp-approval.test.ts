import type * as db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { resolveMcpApprovalCards } from "./mcp-approval.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));

function fixture(blocks: unknown[]) {
  const tx = {
    message: {
      findMany: vi.fn(async () => [{ id: "card-message", blocks }]),
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "main-thread" } })) },
      thread: { findMany: vi.fn(async () => [{ id: "group-thread" }]) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof resolveMcpApprovalCards>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}

describe("resolveMcpApprovalCards", () => {
  it("flips pending and pre-upgrade cards for the matching server", async () => {
    const blocks = [
      { kind: "text", text: "before" },
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" },
      { kind: "mcp_approval", name: "Legacy", serverId: "srv-a" },
      { kind: "mcp_approval", name: "B", serverId: "srv-b", status: "pending" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "connected",
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [
          blocks[0],
          { ...blocks[1], status: "connected" },
          { ...blocks[2], status: "connected" },
          blocks[3],
          blocks[4],
        ],
      },
    });
  });

  it("scans the requested chat when a threadId is given", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "dismissed",
      threadId: "group-thread",
    });
    expect(deps.prisma.thread.findMany).toHaveBeenCalledWith({
      where: { id: "group-thread", spaceId: "space", userId: "user" },
      select: { id: true },
    });
    expect(tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "group-thread" } }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "dismissed" }] },
    });
  });

  it("leaves untouched messages alone when nothing matches", async () => {
    const blocks = [{ kind: "mcp_approval", name: "B", serverId: "srv-b", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "connected",
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });
});
