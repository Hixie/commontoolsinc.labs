import { CFAgentArchive } from "./cf-agent-archive.ts";

if (!customElements.get("cf-agent-archive")) {
  customElements.define("cf-agent-archive", CFAgentArchive);
}

export { CFAgentArchive };
