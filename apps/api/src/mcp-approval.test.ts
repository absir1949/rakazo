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
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      message: { findMany: vi.fn(async () => [{ id: "card-message", blocks }]) },
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
  it("flips only the pending card for the matching server", async () => {
    const blocks = [
      { kind: "text", text: "before" },
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" },
      { kind: "mcp_approval", name: "B", serverId: "srv-b", status: "pending" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, "bot", "srv-a", "connected");
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [blocks[0], { ...blocks[1], status: "connected" }, blocks[2], blocks[3]],
      },
    });
  });

  it("leaves untouched messages alone when nothing matches", async () => {
    const blocks = [{ kind: "mcp_approval", name: "B", serverId: "srv-b", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, "bot", "srv-a", "connected");
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("writes the dismissed decision", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, "bot", "srv-a", "dismissed");
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "dismissed" }] },
    });
  });
});
