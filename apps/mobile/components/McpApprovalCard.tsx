import type { MessageBlock } from "@rakazo/contracts";
import { useState } from "react";
import { Alert, Pressable, Text, View, type ViewProps } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";

export function McpApprovalCard({
  botId,
  block,
  accessibilityActions,
  onAccessibilityAction,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "mcp_approval" }>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const status = block.status;
  const summary = block.endpoint ?? `stdio · ${block.transport}`;
  const decided = status !== "pending";

  async function submit(action: "approve" | "dismiss") {
    if (decided || pendingAction !== null) return;
    setPendingAction(action);
    try {
      if (action === "approve") {
        await rpc("mcp/assignments/approve", { botId, serverId: block.serverId });
      } else {
        await rpc("mcp/assignments/dismiss", { botId, serverId: block.serverId });
      }
    } catch (reason) {
      Alert.alert(
        t("Could not approve this server"),
        reason instanceof Error ? reason.message : t("Please try again."),
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <View
      accessibilityLabel={t("Connect MCP server {name}", { name: block.name })}
      style={{
        width: "90%",
        borderRadius: 18,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            backgroundColor: tokens.muted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 12, fontWeight: "600" }}>M</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}
          >
            {t("Connect MCP server {name}", { name: block.name })}
          </Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: 13.5 }} numberOfLines={2}>
            {summary}
          </Text>
        </View>
      </View>
      {decided ? (
        <Text
          style={{
            color: status === "connected" ? tokens.success : tokens.mutedForeground,
            fontSize: 13.5,
          }}
        >
          {status === "connected"
            ? t("Connected. Its tools are available from your next message.")
            : t("Dismissed. Reconnect anytime from MCP settings.")}
        </Text>
      ) : (
        <>
          <Text style={{ color: tokens.foreground, opacity: 0.75, fontSize: 13.5 }}>
            {block.needsOAuth
              ? t("Finish MCP authorization in the web app.")
              : t("Approve this server to let your agent use its tools.")}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {!block.needsOAuth ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Approve")}
                disabled={pendingAction !== null}
                onPress={() => void submit("approve")}
                style={{
                  minHeight: 36,
                  paddingHorizontal: 14,
                  borderRadius: 999,
                  backgroundColor: native.fillPressed,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: native.label, fontSize: 14, fontWeight: "600" }}>
                  {t("Approve")}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Not now")}
              disabled={pendingAction !== null}
              onPress={() => void submit("dismiss")}
              style={{
                minHeight: 36,
                paddingHorizontal: 14,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: tokens.border,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: tokens.foreground, fontSize: 14 }}>{t("Not now")}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
