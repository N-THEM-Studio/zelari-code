import { computeAgentTools, getCouncilAgents } from "@zelari/core/council";
import { getProviderTools } from "../packages/core/dist/agents/toolSchemas.js";
import { setWorkspaceStubs } from "../packages/core/dist/agents/tools.js";
import {
  createWorkspaceContext,
  createWorkspaceStubs,
} from "../dist/cli/workspace/stubs.js";

const ctx = createWorkspaceContext(process.argv[2] ?? "Z:/EasyPeasy/TESTMCP");
setWorkspaceStubs(createWorkspaceStubs(ctx));

for (const id of ["charont", "nettun", "lucifer"]) {
  const agent = getCouncilAgents(6).find((a) => a.id === id);
  const names = computeAgentTools(agent, { agentSkillConfigs: [] });
  const tools = getProviderTools(names);
  console.log(`\n=== ${id} (${tools.length}/${names.length} tools) ===`);
  for (const t of tools) {
    const p = JSON.stringify(t.function.parameters);
    if (p === "[]" || /:\[\],/.test(p)) {
      console.log("BAD", t.function.name, p.slice(0, 300));
    }
  }
  const missing = names.filter(
    (n) => !tools.some((t) => t.function.name === n),
  );
  if (missing.length) console.log("skipped:", missing.join(", "));
}
