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

function ok(content: string | Record<string, unknown>): ToolExecutionResult {
  return {
    content: typeof content === "string" ? content : JSON.stringify(content),
    isError: false,
  };
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
        description: "Run a shell command. Use for file ops, git, builds, tests.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run" },
            cwd: { type: "string", description: "Working dir (optional)" },
            timeout: { type: "number", description: "Timeout ms (optional, default 30000)" },
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
        description: "Read file contents.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative file path" },
            offset: { type: "number", description: "Start line (1-based, optional)" },
            limit: { type: "number", description: "Max lines to read (optional)" },
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
        description: "Write or overwrite a file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative file path" },
            content: { type: "string", description: "File content" },
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
        description: "Search file contents with grep/ripgrep.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search regex or string" },
            path: { type: "string", description: "Directory or file to search (optional)" },
            glob: { type: "string", description: "File glob filter (optional, e.g. '*.ts')" },
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
        description: "Call Paperclip API. Methods: get_issue, update_issue_status, add_comment, list_child_issues.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["get_issue", "update_issue_status", "add_comment", "list_child_issues"],
            },
            issue_id: { type: "string" },
            status: { type: "string", enum: ["in_progress", "done", "blocked", "in_review"] },
            comment: { type: "string" },
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
        case "get_issue":
          return safeExec("get_issue", () => callApi("GET", `/api/issues/${issueId}`));
        case "update_issue_status": {
          const status = asString(args.status);
          if (!status) return fail("status required");
          return safeExec("update_status", () => callApi("PATCH", `/api/issues/${issueId}`, { status }));
        }
        case "add_comment": {
          const comment = asString(args.comment);
          if (!comment) return fail("comment required");
          return safeExec("add_comment", () => callApi("POST", `/api/issues/${issueId}/comments`, { body: comment }));
        }
        case "list_child_issues":
          return safeExec("list_children", () => callApi("GET", `/api/issues/${issueId}/children`));
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
