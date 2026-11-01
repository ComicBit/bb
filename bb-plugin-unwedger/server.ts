import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  unwedger_recover: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ delivery: z.enum(["sent", "queued"]) }),
  },
});

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    unwedger_recover: async ({ threadId }) => {
      const current = await bb.sdk.threads.get({ threadId });
      if (current.status !== "error") {
        throw new Error("This thread is not in a failed state.");
      }

      const retry = await bb.sdk.threads.retry({
        threadId,
        reason: "Unwedger recovery",
      });
      return { delivery: retry.delivery };
    },
  });
}
