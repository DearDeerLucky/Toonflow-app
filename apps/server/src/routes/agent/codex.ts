import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { getCodexModels, requireLocalCodexRequest } from "@/agent/runtime/codexClient";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  requireLocalCodexRequest(req);
  const cwd = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  res.set("Cache-Control", "no-store").json(success(await getCodexModels(cwd)));
});
