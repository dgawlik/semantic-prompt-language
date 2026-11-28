export interface WorkflowPreset {
  id: string;
  label: string;
  badge: string;
  description: string;
  prose: string;
  defaultInputs: Record<string, unknown>;
  defaultState: Record<string, unknown>;
  demoSpl: string;
  demoFirstAttemptBuggySpl?: string;
}

export const DEFAULT_CATALOG = {
  spec_version: "5" as const,
  models: {
    default: {
      provider: "openai",
      model: "gpt-4.1",
      max_output_tokens: 1024,
      strict_schema: true,
    },
  },
  decisions: {
    classifier_default: {
      adapter: "openai_logprobs",
      model: "gpt-4.1-mini",
      top_logprobs: 20,
    },
  },
  shell_profiles: {
    git_status: {
      executable: "git",
      base_argv: ["status", "--porcelain"],
      cwd_root: "workspace",
      params_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
      argv_template: ["--", "${path}"],
      env_allowlist: ["LANG", "LC_ALL"],
      timeout_ms: 5000,
      max_stdout_bytes: 16384,
      max_stderr_bytes: 4096,
    },
  },
  fs_roots: {
    workspace: { permissions: ["read", "list", "stat"], max_file_bytes: 1048576 },
    output: { permissions: ["read", "write", "append", "exists", "list", "stat"], max_file_bytes: 1048576 },
  },
  web: {
    search: { enabled: true, max_results_cap: 5 },
    fetch: {
      enabled: true,
      allowed_methods: ["GET", "HEAD"],
      allowed_domains: ["example.com", "*.docs.org"],
      denied_domains: [],
      block_private_ips: true,
      max_redirects: 3,
      max_response_bytes: 65536,
    },
  },
  js_tools: {
    score_risk: {
      params_schema: {
        type: "object",
        properties: {
          amount_cents: { type: "integer" },
          account_age_days: { type: "integer" },
        },
        required: ["amount_cents", "account_age_days"],
        additionalProperties: false,
      },
      result_schema: {
        type: "object",
        properties: {
          score: { type: "number" },
          flagged: { type: "boolean" },
        },
        required: ["score", "flagged"],
        additionalProperties: false,
      },
      timeout_ms: 2000,
    },
  },
  mcp_tools: {
    crm: {
      get_customer: {
        params_schema: {
          type: "object",
          properties: { customer_id: { type: "string" } },
          required: ["customer_id"],
          additionalProperties: false,
        },
        result_schema: {
          type: "object",
          properties: {
            tier: { type: "string", enum: ["free", "pro", "enterprise"] },
            account_age_days: { type: "integer" },
          },
          required: ["tier", "account_age_days"],
          additionalProperties: false,
        },
        timeout_ms: 5000,
      },
    },
  },
};

export const WORKFLOW_PRESETS: WorkflowPreset[] = [
  {
    id: "ticket-triage",
    label: "Ticket Triage",
    badge: "Decision API + Durable State",
    description: "Logprob-scored refund classification with confidence threshold, nullability narrowing, and atomic state.",
    prose: `Take a refund ticket input with an integer id and text description, and keep a persistent integer counter called approved_count starting at 0.

Use the classifier_default decision profile to classify the ticket into "approve" or "reject" with a minimum confidence of 0.8.
- If confidence is below 0.8 (null), return "manual_review".
- If "approve", increment approved_count by 1 and ask the default model to write a brief 1-sentence approval reply referencing the ticket id, then return that reply.
- If "reject", return "rejected".`,
    defaultInputs: {
      ticket: { id: 1042, text: "Charged twice on my April statement" },
    },
    defaultState: { approved_count: 4 },
    demoFirstAttemptBuggySpl: `type Ticket = { id: int, text: string };
input ticket: Ticket;
state approved_count: int = 0;

fn main() -> string {
  let verdict = model.decide(
    "classifier_default",
    \`Classify refund ticket #\${ticket.id}: \${ticket.text}\`,
    ["approve", "reject"],
    { min_confidence: 0.8 }
  );
  switch (verdict) {
    case "approve": { return "ok"; }
    case "reject": { return "rejected"; }
  }
}`,
    demoSpl: `type Ticket = { id: int, text: string };
input ticket: Ticket;
state approved_count: int = 0;

fn main() -> string {
  let verdict = model.decide(
    "classifier_default",
    \`Classify refund ticket #\${ticket.id}: \${ticket.text}\`,
    ["approve", "reject"],
    { min_confidence: 0.8 }
  );

  if (verdict == null) {
    return "manual_review";
  }

  switch (verdict) {
    case "approve": {
      approved_count = approved_count + 1;
      return model.ask<string>(
        "default",
        \`Write a brief 1-sentence approval reply for ticket #\${ticket.id}.\`
      );
    }
    case "reject": {
      return "rejected";
    }
  }
}`,
  },
  {
    id: "invoice-extraction",
    label: "Invoice Extraction",
    badge: "Strict JSON Schema + Retry",
    description: "Bounded retry extraction into a closed structural record with deterministic int64 summation.",
    prose: `Take a raw_document string input.

Try up to 2 times to extract a structured invoice using the default model with:
- vendor (string)
- currency ("USD", "EUR", or "GBP")
- optional po_number (nullable string)
- items: a list of records with description (string) and amount_cents (int).

If extraction succeeds, compute the sum of amount_cents across all items, default po_number to "NONE" if missing, and return { status: "parsed", vendor, po_number, total_cents, error_code: null }.
If an error occurs and is not retryable, stop retrying immediately.
If all attempts fail, return { status: "failed", vendor: "", po_number: "NONE", total_cents: 0, error_code: last_error_code }.`,
    defaultInputs: {
      raw_document:
        "Invoice from Acme Cloud Corp (PO-8812). Currency: USD. Compute cluster $120.00 (12000 cents), Object storage $35.00 (3500 cents).",
    },
    defaultState: {},
    demoSpl: `type LineItem = { description: string, amount_cents: int };
type Invoice = {
  vendor: string,
  currency: "USD" | "EUR" | "GBP",
  po_number: string?,
  items: list<LineItem>
};

input raw_document: string;

fn sum_items(items: list<LineItem>) -> int {
  let mut total = 0;
  for (item in items) {
    total = total + item.amount_cents;
  }
  return total;
}

fn main() -> {
  status: "parsed" | "failed",
  vendor: string,
  po_number: string,
  total_cents: int,
  error_code: string?
} {
  let mut attempts = 0;
  let mut last_err: string? = null;

  while (attempts < 2) {
    attempts = attempts + 1;
    try {
      let inv = model.ask<Invoice>(
        "default",
        "Extract invoice fields strictly from the provided document.",
        { input: raw_document }
      );
      return {
        status: "parsed",
        vendor: inv.vendor,
        po_number: inv.po_number ?? "NONE",
        total_cents: sum_items(inv.items),
        error_code: null
      };
    } catch (err) {
      last_err = err.code;
      if (!err.retryable) {
        break;
      }
    }
  }

  return {
    status: "failed",
    vendor: "",
    po_number: "NONE",
    total_cents: 0,
    error_code: last_err
  };
}`,
  },
  {
    id: "research-brief",
    label: "Research Brief",
    badge: "Web + Virtual FS",
    description: "Policy-sandboxed web search & fetch with graceful fallback to snippets and virtual-root Markdown write.",
    prose: `Take a topic string input and an optional out_file string defaulting to "brief.md".

1. Search the web for the topic (up to 3 results).
2. For each result, try fetching its URL with HTTP GET. If status is 200, keep its URL and page body; if fetching fails (for example due to domain policy), fall back to the search snippet and record the error code.
3. Join all collected snippets and ask the default model to return a structured brief with headline (string) and key_points (list of strings).
4. Format the brief as Markdown and write it to the "output" virtual file root at out_file.
5. Return { fetched_urls, written_to: out_file, headline }.`,
    defaultInputs: { topic: "SPL v5 deterministic workflows", out_file: "brief.md" },
    defaultState: {},
    demoSpl: `type Brief = { headline: string, key_points: list<string> };

input topic: string;
input out_file: string = "brief.md";

fn main() -> { fetched_urls: list<string>, written_to: string, headline: string } {
  let results = web.search(topic, { max_results: 3 });
  let mut fetched_urls: list<string> = [];
  let mut snippets: list<string> = [];

  for (r in results) {
    try {
      let page = web.fetch(r.url, { method: "GET" });
      if (page.status == 200) {
        fetched_urls = list.push(fetched_urls, page.url);
        snippets = list.push(snippets, \`\${r.title}: \${page.body}\`);
      }
    } catch (err) {
      snippets = list.push(snippets, \`\${r.title} [fallback \${err.code}]: \${r.snippet}\`);
    }
  }

  let corpus = str.join(snippets, "\\n---\\n");
  let brief = model.ask<Brief>(
    "default",
    \`Synthesize a concise research brief on "\${topic}" from the gathered sources.\`,
    { input: corpus }
  );

  let bullets = str.join(brief.key_points, "\\n- ");
  fs.write("output", out_file, \`# \${brief.headline}\\n\\n- \${bullets}\\n\`);

  return {
    fetched_urls: fetched_urls,
    written_to: out_file,
    headline: brief.headline
  };
}`,
  },
  {
    id: "refund-routing",
    label: "MCP + Risk Routing",
    badge: "MCP + JS Tool + Shell",
    description: "Combines MCP CRM lookup, deterministic JS risk scoring, argv-only shell profile, and leaf model routing.",
    prose: `Take inputs customer_id (string), refund_cents (int), and reason (string).

1. Look up the customer using the MCP tool crm.get_customer to get their tier and account_age_days.
2. Compute risk using the host JS tool score_risk with amount_cents and account_age_days.
3. Check whether the workspace repository is clean using the git_status shell profile.
4. Apply deterministic rules first:
   - If risk is flagged and tier is "free", return action "deny".
   - If tier is "enterprise" and risk is not flagged, return action "auto_approve".
5. Otherwise, use the classifier_default decision profile to choose between "auto_approve", "escalate", and "deny" with min_confidence 0.75, defaulting to "escalate" when uncertain.
6. Return { action, risk_score, tier, repo_clean }.`,
    defaultInputs: {
      customer_id: "cust_pro_42",
      refund_cents: 4500,
      reason: "Duplicate invoice on April billing cycle",
    },
    defaultState: {},
    demoSpl: `input customer_id: string;
input refund_cents: int;
input reason: string;

fn main() -> {
  action: "auto_approve" | "escalate" | "deny",
  risk_score: float,
  tier: string,
  repo_clean: bool
} {
  let customer = mcp.crm.get_customer({ customer_id: customer_id });
  let risk = tool.score_risk({
    amount_cents: refund_cents,
    account_age_days: customer.account_age_days
  });
  let git = shell.run("git_status", {});
  let repo_clean = git.exit_code == 0 && len(str.trim(git.stdout)) == 0;

  if (risk.flagged && customer.tier == "free") {
    return { action: "deny", risk_score: risk.score, tier: customer.tier, repo_clean: repo_clean };
  }
  if (customer.tier == "enterprise" && !risk.flagged) {
    return { action: "auto_approve", risk_score: risk.score, tier: customer.tier, repo_clean: repo_clean };
  }

  let decision = model.decide(
    "classifier_default",
    \`Customer (\${customer.tier}, risk=\${risk.score}) requests \${refund_cents} cents refund: \${reason}\`,
    ["auto_approve", "escalate", "deny"],
    { min_confidence: 0.75 }
  );

  return {
    action: decision ?? "escalate",
    risk_score: risk.score,
    tier: customer.tier,
    repo_clean: repo_clean
  };
}`,
  },
];
