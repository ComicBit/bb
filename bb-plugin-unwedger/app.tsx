import { useState } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

function UnwedgerAction() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const [recovering, setRecovering] = useState(false);

  async function recover(): Promise<void> {
    const scope = composer.scope;
    if (scope.kind !== "thread") return;

    setRecovering(true);
    try {
      const result = await rpc.call("unwedger_recover", {
        threadId: scope.threadId,
      });
      toast.success(
        result.delivery === "queued" ? "Retry queued" : "Retry started",
      );
    } catch (error: unknown) {
      toast.error("Could not recover this thread", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRecovering(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Unwedge this thread"
      disabled={recovering}
      onClick={() => void recover()}
    >
      <Icon
        name="RotateCcw"
        className={recovering ? "size-4 animate-spin" : "size-4"}
      />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "unwedger",
    scopes: ["thread"],
    actions: [{ id: "recover-current-thread", component: UnwedgerAction }],
  });
});
