import { compressResult } from "./compression.js";

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
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else {
    // TOON/RTK compression for objects/arrays before truncation
    text = compressResult(content);
  }
  if (text.length > MAX_RESULT_CHARS) {
    text = text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated ${text.length - MAX_RESULT_CHARS} chars]`;
  }
  return { content: text, isError: false };
}

function fail(message: string, detail?: unknown): ToolExecutionResult {
  const body: Record<string, unknown> = { error: message };
  if (detail !== undefined) body.detail = detail;
  // Errors are typically small; RTK still helps on large error objects
  return { content: compressResult(body), isError: true };
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
            action: {
              type: "string",
              enum: [
                "get_issue",
                "update_issue_status",
                "add_comment",
                "list_comments",
                "list_issues",
                "create_sub_issue",
                "hire_agent",
                "list_agents",
                "request_approval",
              ],
              description: "API action to perform",
            },
            issue_id: { type: "string", description: "Target issue id. Defaults to current issue for most actions." },
            status: { type: "string", enum: ["open", "in_progress", "blocked", "done", "cancelled"], description: "New status" },
            comment: { type: "string", description: "Comment body" },
            title: { type: "string", description: "Title for create_sub_issue" },
            description: { type: "string", description: "Description for create_sub_issue" },
            assignee_agent_id: { type: "string", description: "Assignee for create_sub_issue" },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            name: { type: "string", description: "Agent display name for hire_agent (e.g. 'Security Engineer')" },
            role: { type: "string", description: "Agent role for hire_agent (e.g. 'security', 'backend', 'frontend', 'devops')" },
            agent_title: { type: "string", description: "Agent job title for hire_agent (e.g. 'Security Engineer / AppSec')" },
            icon: { type: "string", description: "Agent icon name for hire_agent (e.g. 'shield', 'code', 'layout', 'server')" },
            capabilities: { type: "string", description: "Agent capabilities/responsibilities description for hire_agent" },
            adapter_type: { type: "string", description: "Adapter type for hire_agent. Default: openai_proxy" },
            model: { type: "string", description: "Model for hire_agent" },
            reports_to_agent_id: { type: "string", description: "Manager agent id for hire_agent" },
            desired_skills: { type: "array", items: { type: "string" }, description: "Desired skills for hire_agent" },
            approval_type: { type: "string", enum: ["hire_agent", "approve_ceo_strategy", "budget_override_required"] },
            summary: { type: "string", description: "Approval summary" },
            payload: { type: "object", description: "Approval payload" },
            limit: { type: "number", description: "Max results. Default 20." },
            assignee_agent_id_filter: { type: "string", description: "Filter by assignee for list_issues" },
          },
          required: ["action"],
        },
      },
    },
    execute: async (args) => {
      const action = asString(args.action);
      const issueId = asString(args.issue_id, ctx.currentIssueId ?? "");

      switch (action) {
        case "get_issue": {
          const targetIssueId = issueId || ctx.currentIssueId;
          if (!targetIssueId) return fail("issue_id required (no current issue available)");
          return safeExec("get_issue", () => callApi("GET", `/api/issues/${targetIssueId}`));
        }
        case "update_issue_status": {
          if (!issueId) return fail("issue_id required");
          const status = asString(args.status);
          if (!status) return fail("status required");
          return safeExec("update_status", () =>
            callApi("PATCH", `/api/issues/${issueId}`, { status, statusReason: args.reason ?? null }),
          );
        }
        case "add_comment": {
          if (!issueId) return fail("issue_id required");
          const comment = asString(args.comment);
          if (!comment) return fail("comment required");
          return safeExec("add_comment", () => callApi("POST", `/api/issues/${issueId}/comments`, { body: comment }));
        }
        case "list_comments": {
          if (!issueId) return fail("issue_id required");
          return safeExec("list_comments", () => callApi("GET", `/api/issues/${issueId}/comments`));
        }
        case "list_issues": {
          const query: Record<string, string> = {};
          if (typeof args.status === "string") query.status = args.status;
          if (typeof args.assignee_agent_id_filter === "string") query.assigneeAgentId = args.assignee_agent_id_filter;
          query.limit = String(typeof args.limit === "number" ? args.limit : 20);
          return safeExec("list_issues", () => callApi("GET", `/api/companies/${ctx.companyId}/issues?${new URLSearchParams(query)}`));
        }
        case "create_sub_issue": {
          const title = asString(args.title);
          if (!title) return fail("title required");
          const payload: Record<string, unknown> = {
            title,
            description: args.description ?? "",
            parentId: issueId || undefined,
            assigneeAgentId: args.assignee_agent_id ?? undefined,
            priority: args.priority ?? undefined,
          };
          return safeExec("create_sub_issue", () => callApi("POST", `/api/companies/${ctx.companyId}/issues`, payload));
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
            title: asString(args.agent_title) || undefined,
            icon: asString(args.icon) || undefined,
            capabilities: capabilities || undefined,
            adapterType: args.adapter_type ?? "openai_proxy",
            adapterConfig: Object.keys(adapterConfig).length > 0 ? adapterConfig : undefined,
            reportsTo: asString(args.reports_to_agent_id) || undefined,
          };
          if (Array.isArray(args.desired_skills) && args.desired_skills.length > 0) {
            payload.desiredSkills = args.desired_skills.map((s: unknown) => String(s));
          }
          return safeExec("hire_agent", () => callApi("POST", `/api/companies/${ctx.companyId}/agents`, payload));
        }
        case "list_agents": {
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
        }
        case "request_approval": {
          const approvalType = asString(args.approval_type);
          const summary = asString(args.summary);
          if (!approvalType) return fail("approval_type required");
          if (!summary) return fail("summary required");
          const approvalPayload = (args.payload && typeof args.payload === "object" ? args.payload : {}) as Record<string, unknown>;
          return safeExec("request_approval", () =>
            callApi("POST", `/api/companies/${ctx.companyId}/approvals`, {
              type: approvalType,
              requestedByAgentId: ctx.agentId,
              payload: { ...approvalPayload, summary },
            }),
          );
        }
        default:
          return fail(`Unknown action: ${action}`);
      }
    },
  };
}

function listDirectoryTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_directory",
        description: "List directory contents with file types and sizes.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path" },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const dirPath = asString(args.path);
      if (!dirPath) return fail("path required");
      return safeExec("list_directory", async () => {
        const fs = await import("node:fs/promises");
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const items = await Promise.all(
          entries.map(async (entry) => {
            const fullPath = `${dirPath}/${entry.name}`;
            let size = 0;
            try {
              const stats = await fs.stat(fullPath);
              size = stats.size;
            } catch { /* ignore */ }
            return { name: entry.name, type: entry.isDirectory() ? "directory" : "file", size: entry.isFile() ? size : undefined };
          }),
        );
        return items;
      });
    },
  };
}

function editFileTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit file by replacing old_content with new_content. Safer than write_file for partial changes.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            old_content: { type: "string", description: "Exact content to find" },
            new_content: { type: "string", description: "Replacement content" },
          },
          required: ["path", "old_content", "new_content"],
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      const oldContent = asString(args.old_content);
      const newContent = asString(args.new_content);
      if (!filePath) return fail("path required");
      if (!oldContent) return fail("old_content required");
      if (newContent === null) return fail("new_content required");
      return safeExec("edit_file", async () => {
        const fs = await import("node:fs/promises");
        const current = await fs.readFile(filePath, "utf-8");
        if (!current.includes(oldContent)) return fail("old_content not found in file");
        const occurrences = current.split(oldContent).length - 1;
        if (occurrences > 1) return fail(`old_content appears ${occurrences} times — make it more specific`);
        const updated = current.replace(oldContent, newContent);
        await fs.writeFile(filePath, updated, "utf-8");
        return { path: filePath, replaced: oldContent.length, with: newContent.length };
      });
    },
  };
}

function webFetchTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch content from a URL. Supports GET/POST/PUT/DELETE.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
            method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method. Default GET." },
            headers: { type: "object", description: "Optional headers" },
            body: { type: "string", description: "Request body" },
          },
          required: ["url"],
        },
      },
    },
    execute: async (args) => {
      const url = asString(args.url);
      if (!url) return fail("url required");
      if (!url.startsWith("http://") && !url.startsWith("https://")) return fail("url must start with http:// or https://");
      const method = asString(args.method, "GET").toUpperCase();
      const headers = typeof args.headers === "object" && args.headers !== null ? (args.headers as Record<string, string>) : {};
      const body = asString(args.body);
      return safeExec("web_fetch", async () => {
        const res = await fetch(url, { method, headers: { "User-Agent": "Paperclip-OpenAI-Proxy/1.0", ...headers }, body: body || undefined });
        const contentType = res.headers.get("content-type") || "";
        let content: string;
        if (contentType.includes("application/json")) {
          content = JSON.stringify(await res.json(), null, 2);
        } else {
          content = await res.text();
        }
        const maxSize = 50000;
        if (content.length > maxSize) content = content.slice(0, maxSize) + `\n... (truncated ${content.length - maxSize} chars)`;
        return { status: res.status, statusText: res.statusText, content };
      });
    },
  };
}

function globTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "glob",
        description: "Find files matching a glob pattern (e.g. '**/*.ts').",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern" },
            cwd: { type: "string", description: "Working directory. Default current." },
            max_results: { type: "number", description: "Max results. Default 200." },
          },
          required: ["pattern"],
        },
      },
    },
    execute: async (args) => {
      const pattern = asString(args.pattern);
      if (!pattern) return fail("pattern required");
      const cwd = asString(args.cwd) || process.cwd();
      const maxResults = asNumber(args.max_results, 200);
      return safeExec("glob", async () => {
        const { execSync } = await import("node:child_process");
        const cmd = process.platform === "win32" ? `dir /S /B "${pattern}"` : `find "${cwd}" -type f -path "${pattern}"`;
        let result: string;
        try {
          result = execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
        } catch (err: any) {
          if (err.status === 1) return { files: [], total: 0 };
          throw err;
        }
        const files = result.split("\n").filter(Boolean);
        const limited = files.slice(0, maxResults);
        return { files: limited, total: files.length, truncated: files.length > maxResults };
      });
    },
  };
}

function gitDiffTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "git_diff",
        description: "Show git diff of changes. Useful for reviewing before committing.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Optional path filter" },
            staged: { type: "boolean", description: "Show staged changes only" },
            cwd: { type: "string", description: "Repository directory. Default current." },
          },
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      const staged = args.staged === true;
      const cwd = asString(args.cwd) || process.cwd();
      return safeExec("git_diff", async () => {
        const { execSync } = await import("node:child_process");
        const diffArgs: string[] = staged ? ["--cached"] : [];
        if (filePath) diffArgs.push(filePath);
        const result = execSync(`git diff ${diffArgs.join(" ")}`, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        if (!result.trim()) return { message: staged ? "No staged changes" : "No changes" };
        const maxSize = 50000;
        if (result.length > maxSize) return { diff: result.slice(0, maxSize) + `\n... (truncated ${result.length - maxSize} chars)`, truncated: true };
        return { diff: result };
      });
    },
  };
}

function moveFileTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "move_file",
        description: "Move or rename a file or directory.",
        parameters: {
          type: "object",
          properties: {
            source: { type: "string", description: "Source path" },
            destination: { type: "string", description: "Destination path" },
          },
          required: ["source", "destination"],
        },
      },
    },
    execute: async (args) => {
      const source = asString(args.source);
      const destination = asString(args.destination);
      if (!source) return fail("source required");
      if (!destination) return fail("destination required");
      return safeExec("move_file", async () => {
        const fs = await import("node:fs/promises");
        await fs.rename(source, destination);
        return { moved: `${source} -> ${destination}` };
      });
    },
  };
}

function deleteFileTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file or directory. Use with caution!",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to delete" },
            recursive: { type: "boolean", description: "Delete directory recursively. Default false." },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      const recursive = args.recursive === true;
      if (!filePath) return fail("path required");
      return safeExec("delete_file", async () => {
        const fs = await import("node:fs/promises");
        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
          if (!recursive) return fail("Path is a directory. Set recursive=true to delete.");
          await fs.rm(filePath, { recursive: true, force: true });
          return { deleted: `directory ${filePath}` };
        }
        await fs.unlink(filePath);
        return { deleted: `file ${filePath}` };
      });
    },
  };
}

// ----- Monitoring / DevOps Tools -----

function tailLogTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "tail_log",
        description: "Read the last N lines of a file. Great for logs and output.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            lines: { type: "number", description: "Number of lines. Default 50." },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      const lines = asNumber(args.lines, 50);
      if (!filePath) return fail("path required");
      return safeExec("tail_log", async () => {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(filePath, "utf-8");
        const allLines = content.split("\n");
        const lastLines = allLines.slice(-lines);
        return { path: filePath, lines: lastLines.length, content: lastLines.join("\n") };
      });
    },
  };
}

function killProcessTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "kill_process",
        description: "Kill a process by PID. Use with caution!",
        parameters: {
          type: "object",
          properties: {
            pid: { type: "number", description: "Process ID" },
            force: { type: "boolean", description: "Use SIGKILL instead of SIGTERM. Default false." },
          },
          required: ["pid"],
        },
      },
    },
    execute: async (args) => {
      const pid = typeof args.pid === "number" ? args.pid : null;
      if (pid === null) return fail("pid must be a number");
      const force = args.force === true;
      return safeExec("kill_process", async () => {
        const signal = force ? "SIGKILL" : "SIGTERM";
        process.kill(pid, signal);
        return { killed: pid, signal };
      });
    },
  };
}

function listProcessesTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_processes",
        description: "List running processes. Optionally filter by name.",
        parameters: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter by process name (e.g. 'node')" },
          },
        },
      },
    },
    execute: async (args) => {
      const filter = asString(args.filter);
      return safeExec("list_processes", async () => {
        const { execSync } = await import("node:child_process");
        const command = process.platform === "win32" ? "tasklist" : "ps aux";
        let result = execSync(command, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        if (filter) {
          const lines = result.split("\n").filter((line) => line.toLowerCase().includes(filter.toLowerCase()));
          result = lines.join("\n");
        }
        const maxSize = 10000;
        if (result.length > maxSize) result = result.slice(0, maxSize) + `\n... (truncated)`;
        return { processes: result || "No processes found" };
      });
    },
  };
}

function getEnvTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "get_env",
        description: "Get the value of an environment variable.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Environment variable name" },
          },
          required: ["key"],
        },
      },
    },
    execute: async (args) => {
      const key = asString(args.key);
      if (!key) return fail("key required");
      const value = process.env[key];
      return Promise.resolve(ok(value === undefined ? `Environment variable '${key}' is not set` : `${key}=${value}`));
    },
  };
}

function testPortTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "test_port",
        description: "Test if a TCP port is open on a host.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Host. Default localhost." },
            port: { type: "number", description: "Port number" },
            timeout: { type: "number", description: "Timeout in ms. Default 3000." },
          },
          required: ["port"],
        },
      },
    },
    execute: async (args) => {
      const port = typeof args.port === "number" ? args.port : null;
      if (port === null) return fail("port must be a number");
      const host = asString(args.host, "localhost");
      const timeout = asNumber(args.timeout, 3000);
      return safeExec("test_port", () => {
        return new Promise<ToolExecutionResult>((resolve) => {
          import("node:net").then(({ default: net }) => {
            const socket = new net.Socket();
            let resolved = false;
            const cleanup = () => { if (!resolved) { resolved = true; socket.destroy(); } };
            socket.setTimeout(timeout);
            socket.on("connect", () => { cleanup(); resolve(ok(`Port ${port} on ${host} is OPEN`)); });
            socket.on("timeout", () => { cleanup(); resolve(ok(`Port ${port} on ${host} is CLOSED (timeout)`)); });
            socket.on("error", (err: any) => { cleanup(); resolve(err.code === "ECONNREFUSED" ? ok(`Port ${port} on ${host} is CLOSED`) : fail(`Error: ${err.message}`)); });
            socket.connect(port, host);
          });
        });
      });
    },
  };
}

function findTodosTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "find_todos",
        description: "Find TODO, FIXME, HACK, XXX comments in code.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory or file to search" },
            file_pattern: { type: "string", description: "File pattern e.g. '*.ts'" },
            max_results: { type: "number", description: "Max results. Default 100." },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const searchPath = asString(args.path);
      if (!searchPath) return fail("path required");
      const filePattern = asString(args.file_pattern);
      const maxResults = asNumber(args.max_results, 100);
      return safeExec("find_todos", async () => {
        const { execSync } = await import("node:child_process");
        const pattern = "TODO|FIXME|HACK|XXX|NOTE";
        const grepArgs = ["-n", "-i", "-r", "--color=never", "-E"];
        if (filePattern) grepArgs.push("--include", filePattern);
        const command = process.platform === "win32"
          ? `findstr /N /I /S /R "TODO FIXME HACK XXX NOTE" "${searchPath}\\*"`
          : `grep ${grepArgs.join(" ")} "${pattern}" "${searchPath}"`;
        let result: string;
        try {
          result = execSync(command, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
        } catch (err: any) {
          if (err.status === 1) return { message: "No TODOs/FIXMEs found" };
          throw err;
        }
        const lines = result.split("\n").filter(Boolean);
        return { found: lines.slice(0, maxResults), total: lines.length, truncated: lines.length > maxResults };
      });
    },
  };
}

function countLinesTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "count_lines",
        description: "Count lines of code in files or directories.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File or directory" },
            file_pattern: { type: "string", description: "File pattern e.g. '*.ts'" },
            exclude_blank: { type: "boolean", description: "Exclude blank lines. Default false." },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const searchPath = asString(args.path);
      if (!searchPath) return fail("path required");
      const filePattern = asString(args.file_pattern);
      const excludeBlank = args.exclude_blank === true;
      return safeExec("count_lines", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        let totalLines = 0;
        let totalFiles = 0;
        const countFile = async (filePath: string): Promise<number> => {
          const content = await fs.readFile(filePath, "utf-8");
          const lines = content.split("\n");
          return excludeBlank ? lines.filter((l) => l.trim().length > 0).length : lines.length;
        };
        const processDirectory = async (dir: string) => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) await processDirectory(fullPath);
            else if (entry.isFile() && (!filePattern || entry.name.match(new RegExp(filePattern.replace("*", ".*"))))) {
              totalLines += await countFile(fullPath);
              totalFiles++;
            }
          }
        };
        const stats = await fs.stat(searchPath);
        if (stats.isDirectory()) await processDirectory(searchPath);
        else { totalLines = await countFile(searchPath); totalFiles = 1; }
        return { totalLines, totalFiles, average: totalFiles > 0 ? Math.round(totalLines / totalFiles) : 0, excludeBlank };
      });
    },
  };
}

function diffFilesTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "diff_files",
        description: "Compare two files and show differences.",
        parameters: {
          type: "object",
          properties: {
            file1: { type: "string", description: "First file path" },
            file2: { type: "string", description: "Second file path" },
            unified: { type: "number", description: "Context lines. Default 3." },
          },
          required: ["file1", "file2"],
        },
      },
    },
    execute: async (args) => {
      const file1 = asString(args.file1);
      const file2 = asString(args.file2);
      if (!file1) return fail("file1 required");
      if (!file2) return fail("file2 required");
      const unified = asNumber(args.unified, 3);
      return safeExec("diff_files", async () => {
        const { execSync } = await import("node:child_process");
        const command = process.platform === "win32" ? `fc "${file1}" "${file2}"` : `diff -u${unified} "${file1}" "${file2}"`;
        let result: string;
        try {
          result = execSync(command, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
        } catch (err: any) {
          if (err.status === 1 && err.stdout) result = err.stdout;
          else if (err.status === 0) return { message: "Files are identical" };
          else throw err;
        }
        if (!result || result.trim() === "") return { message: "Files are identical" };
        const maxSize = 50000;
        if (result.length > maxSize) result = result.slice(0, maxSize) + `\n... (truncated)`;
        return { diff: result };
      });
    },
  };
}

export function buildTools(ctx: BuildToolsContext): Tool[] {
  return [
    // Paperclip API (1 tool, many actions)
    paperclipApiTool(ctx),
    // Basic filesystem (4)
    runShellTool(),
    readFileTool(),
    writeFileTool(),
    searchFilesTool(),
    listDirectoryTool(),
    // Advanced filesystem (5)
    editFileTool(),
    webFetchTool(),
    globTool(),
    gitDiffTool(),
    moveFileTool(),
    deleteFileTool(),
    // Monitoring / DevOps (8)
    tailLogTool(),
    killProcessTool(),
    listProcessesTool(),
    getEnvTool(),
    testPortTool(),
    findTodosTool(),
    countLinesTool(),
    diffFilesTool(),
  ];
}

export function buildToolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.schema.function.name === name);
}
