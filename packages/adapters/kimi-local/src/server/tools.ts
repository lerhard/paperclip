export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface Tool {
  schema: ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

const MAX_RESULT_CHARS = 8000;

function ok(content: string | Record<string, unknown>): ToolExecutionResult {
  let text = typeof content === "string" ? content : JSON.stringify(content);
  if (text.length > MAX_RESULT_CHARS) {
    text = text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated ${text.length - MAX_RESULT_CHARS} chars]`;
  }
  return { content: text, isError: false };
}

function fail(message: string, detail?: unknown): ToolExecutionResult {
  const body: Record<string, unknown> = { error: message };
  if (detail !== undefined) body.detail = detail;
  return { content: JSON.stringify(body), isError: true };
}

async function safeExec(label: string, fn: () => Promise<unknown>): Promise<ToolExecutionResult> {
  try {
    const result = await fn();
    return ok(result as Record<string, unknown>);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`${label} failed: ${reason}`);
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return isNaN(n) ? fallback : n;
}

export interface BuildToolsContext {
  agentId: string;
  companyId: string;
  currentIssueId: string | null;
  apiBaseUrl: string;
  apiKey: string;
  runId: string;
}

function runShellTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "run_shell_command",
        description: "Run shell command.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
            timeout: { type: "number" },
          },
          required: ["command"],
        },
      },
    },
    execute: async (args) => {
      const command = asString(args.command);
      if (!command) return fail("command required");
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const cwd = asString(args.cwd, process.cwd());
      const timeout = asNumber(args.timeout, 30000);
      return safeExec("shell", async () => {
        const { stdout, stderr } = await execAsync(command, { cwd, timeout });
        return { stdout: stdout.trim(), stderr: stderr.trim() };
      });
    },
  };
}

function readFileTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const fs = await import("node:fs/promises");
      const p = await import("node:path");
      const filePath = asString(args.path);
      if (!filePath) return fail("path required");
      const absPath = p.isAbsolute(filePath) ? filePath : p.resolve(process.cwd(), filePath);
      return safeExec("read_file", async () => {
        const content = await fs.readFile(absPath, "utf8");
        const lines = content.split("\n");
        const offset = Math.max(0, asNumber(args.offset, 1) - 1);
        const limit = asNumber(args.limit, lines.length);
        const sliced = lines.slice(offset, offset + limit);
        return {
          path: absPath,
          lines: sliced.length,
          totalLines: lines.length,
          content: sliced.join("\n"),
        };
      });
    },
  };
}

function writeFileTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "write_file",
        description: "Write file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: async (args) => {
      const fs = await import("node:fs/promises");
      const p = await import("node:path");
      const filePath = asString(args.path);
      const content = asString(args.content);
      if (!filePath) return fail("path required");
      const absPath = p.isAbsolute(filePath) ? filePath : p.resolve(process.cwd(), filePath);
      return safeExec("write_file", async () => {
        await fs.mkdir(p.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, content, "utf8");
        return { path: absPath, bytes: content.length };
      });
    },
  };
}

function searchFilesTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "search_files",
        description: "Search files.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            glob: { type: "string" },
          },
          required: ["query"],
        },
      },
    },
    execute: async (args) => {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const query = asString(args.query);
      if (!query) return fail("query required");
      const searchPath = asString(args.path, ".");
      const glob = asString(args.glob, "*");
      return safeExec("search", async () => {
        const cmd = `grep -r -n -I --include="${glob}" -E "${query.replace(/"/g, '\\"')}" "${searchPath}" || true`;
        const { stdout } = await execAsync(cmd, { timeout: 15000 });
        const lines = stdout.trim().split("\n").filter(Boolean);
        return { matches: lines.slice(0, 50), count: lines.length };
      });
    },
  };
}

function paperclipApiTool(ctx: BuildToolsContext): Tool {
  async function callApi(method: string, endpoint: string, body?: unknown) {
    const url = `${ctx.apiBaseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.apiKey}`,
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": ctx.runId,
    };
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  }

  return {
    schema: {
      type: "function",
      function: {
        name: "paperclip_api",
        description: "Paperclip API.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["get_issue", "update_issue_status", "add_comment", "list_issues", "hire_agent", "list_agents"] },
            issue_id: { type: "string", description: "Target issue id. Defaults to current issue for most actions." },
            status: { type: "string", enum: ["in_progress", "done", "blocked", "in_review"] },
            comment: { type: "string" },
            limit: { type: "number" },
            name: { type: "string", description: "Agent display name for hire_agent" },
            role: { type: "string", description: "Agent role for hire_agent" },
            title: { type: "string", description: "Agent job title for hire_agent" },
            icon: { type: "string", description: "Agent icon name for hire_agent" },
            capabilities: { type: "string", description: "Agent capabilities for hire_agent" },
            mission: { type: "string", description: "Agent mission (mapped to capabilities) for hire_agent" },
            adapter_type: { type: "string", description: "Adapter type for hire_agent. Default: kimi_local" },
            model: { type: "string", description: "Model for hire_agent" },
            reports_to_agent_id: { type: "string", description: "Manager agent id for hire_agent" },
            desired_skills: { type: "array", items: { type: "string" }, description: "Desired skills for hire_agent" },
          },
          required: ["action"],
        },
      },
    },
    execute: async (args) => {
      const action = asString(args.action);
      const issueId = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!issueId) return fail("issue_id required");

      switch (action) {
        case "get_issue": {
          const targetIssueId = issueId || ctx.currentIssueId;
          if (!targetIssueId) return fail("issue_id required (no current issue available)");
          return safeExec("get_issue", () => callApi("GET", `/api/issues/${targetIssueId}`));
        }
        case "update_issue_status": {
          const status = asString(args.status);
          if (!status) return fail("status required");
          const targetIssueId = issueId || ctx.currentIssueId;
          if (!targetIssueId) return fail("issue_id required");
          return safeExec("update_status", () => callApi("PATCH", `/api/issues/${targetIssueId}`, { status }));
        }
        case "add_comment": {
          const comment = asString(args.comment);
          if (!comment) return fail("comment required");
          const targetIssueId = issueId || ctx.currentIssueId;
          if (!targetIssueId) return fail("issue_id required");
          return safeExec("add_comment", () => callApi("POST", `/api/issues/${targetIssueId}/comments`, { body: comment }));
        }
        case "list_issues": {
          const query: Record<string, string> = {};
          query.limit = String(typeof args.limit === "number" ? args.limit : 20);
          return safeExec("list_issues", () => callApi("GET", `/api/companies/${ctx.companyId}/issues?${new URLSearchParams(query)}`));
        }
        case "hire_agent": {
          const name = asString(args.name);
          const role = asString(args.role);
          const capabilities = asString(args.capabilities) || asString(args.mission);
          if (!name) return fail("name required");
          if (!role) return fail("role required");
          const adapterConfig: Record<string, unknown> = {};
          if (args.model) adapterConfig.model = args.model;
          const payload: Record<string, unknown> = {
            name,
            role,
            title: asString(args.title) || undefined,
            icon: asString(args.icon) || undefined,
            capabilities: capabilities || undefined,
            adapterType: args.adapter_type ?? "kimi_local",
            adapterConfig: Object.keys(adapterConfig).length > 0 ? adapterConfig : undefined,
            reportsTo: asString(args.reports_to_agent_id) || undefined,
          };
          if (Array.isArray(args.desired_skills) && args.desired_skills.length > 0) {
            payload.desiredSkills = args.desired_skills.map((s: unknown) => String(s));
          }
          return safeExec("hire_agent", () => callApi("POST", `/api/companies/${ctx.companyId}/agent-hires`, payload));
        }
        case "list_agents":
          return safeExec("list_agents", async () => {
            const agents = await callApi("GET", `/api/companies/${ctx.companyId}/agents`) as Array<Record<string, unknown>>;
            return agents.map((a) => ({
              id: a.id,
              name: a.name,
              role: a.role,
              adapterType: a.adapterType,
              model: (a.adapterConfig as Record<string, unknown> | undefined)?.model ?? null,
              status: a.status,
              reportsToAgentId: a.reportsToAgentId ?? null,
            }));
          });
        default:
          return fail(`Unknown action: ${action}`);
      }
    },
  };
}

export function buildTools(ctx: BuildToolsContext): Tool[] {
  return [
    runShellTool(),
    readFileTool(),
    writeFileTool(),
    searchFilesTool(),
    paperclipApiTool(ctx),
  ];
}

export function buildToolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.schema.function.name === name);
}
