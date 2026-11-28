// Example MCP handler module loaded via `--mcp-module examples/mcp_handler.mjs`
export default async function mcpHandler(server, tool, args) {
  if (server === "crm" && tool === "get_customer") {
    return {
      tier: String(args.customer_id).includes("ent") ? "enterprise" : "pro",
      account_age_days: 180n,
    };
  }
  throw new Error(`Unsupported MCP tool ${server}.${tool}`);
}
