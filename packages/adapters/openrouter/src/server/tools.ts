/**
 * Tool definitions and handlers for the OpenRouter adapter.
 *
 * Architecture:
 *   - Each tool = { schema (sent to the model), execute (called by the loop) }
 *   - buildTools(ctx) closes over agent/company/issue identity so the model
 *     cannot spoof IDs by passing them as arguments
 *   - Errors during execute() are caught and returned as { isError: true }
 *     tool results so the model can recover; only programmer errors throw
 *
 * The schema format matches OpenAI function-calling, which OpenRouter
 * normalizes for any provider that supports tools.
 */

import { PaperclipApi, PaperclipApiError } from "./paperclip-api.js";

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

export interface BuildToolsContext {
  api: PaperclipApi;
  agentId: string;
  companyId: string;
  /** The issue this run is working on, if any. Tools default to this when no id is supplied. */
  currentIssueId: string | null;
  /** When false, hire_agent and similar mutating actions go through request_approval first. */
  autoApprove: boolean;
}

// ----- helpers -----

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

async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<ToolExecutionResult> {
  try {
    const result = await fn();
    return ok(result as Record<string, unknown>);
  } catch (err) {
    if (err instanceof PaperclipApiError) {
      return fail(`${label} failed: ${err.message}`, { status: err.status, body: err.body });
    }
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`${label} failed: ${reason}`);
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

// ----- tool builders -----

function getIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "get_issue",
        description:
          "Fetch the full details of an issue (title, description, status, comments, attachments). " +
          "Defaults to the current issue if no id is supplied.",
        parameters: {
          type: "object",
          properties: {
            issue_id: {
              type: "string",
              description: "Issue id. Omit to use the current issue.",
            },
          },
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("get_issue", () => ctx.api.getIssue(id));
    },
  };
}

function updateIssueStatusTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "update_issue_status",
        description:
          "Move an issue to a new status. Valid statuses: open, in_progress, blocked, done, cancelled. " +
          "Defaults to the current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
            status: {
              type: "string",
              enum: ["open", "in_progress", "blocked", "done", "cancelled"],
            },
            reason: { type: "string", description: "Optional explanation." },
          },
          required: ["status"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const status = asString(args.status);
      if (!status) return fail("status is required.");
      return safeCall("update_issue_status", () =>
        ctx.api.updateIssue(id, { status, statusReason: args.reason ?? null }),
      );
    },
  };
}

function addCommentTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "add_comment",
        description:
          "Post a comment on an issue. Use this to share progress, results, or questions with " +
          "other agents and humans. Defaults to the current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
            body: { type: "string", description: "Comment body in Markdown." },
          },
          required: ["body"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const body = asString(args.body);
      if (!body) return fail("body is required.");
      return safeCall("add_comment", () => ctx.api.addIssueComment(id, { body }));
    },
  };
}

function listCommentsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_comments",
        description: "List all comments on an issue. Defaults to the current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
          },
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("list_comments", () => ctx.api.listIssueComments(id));
    },
  };
}

function createSubIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "create_sub_issue",
        description:
          "Create a child issue under a parent (defaults to the current issue). Use this to break work " +
          "into smaller pieces or delegate to a teammate by setting assigneeId.",
        parameters: {
          type: "object",
          properties: {
            parent_issue_id: { type: "string", description: "Parent issue id. Omit to use current issue." },
            title: { type: "string" },
            description: { type: "string" },
            assignee_agent_id: { type: "string", description: "Optional agent id to assign to." },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          },
          required: ["title"],
        },
      },
    },
    execute: async (args) => {
      const parentId = asString(args.parent_issue_id, ctx.currentIssueId ?? "");
      const title = asString(args.title);
      if (!title) return fail("title is required.");
      const payload: Record<string, unknown> = {
        title,
        description: args.description ?? "",
        parentId: parentId || undefined,
        assigneeAgentId: args.assignee_agent_id ?? undefined,
        priority: args.priority ?? undefined,
      };
      return safeCall("create_sub_issue", () => ctx.api.createIssue(ctx.companyId, payload));
    },
  };
}

function listIssuesTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_issues",
        description: "List issues in the current company, optionally filtered by status or assignee.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string" },
            assignee_agent_id: { type: "string" },
            limit: { type: "number", description: "Max results, default 20." },
          },
        },
      },
    },
    execute: async (args) => {
      const query: Record<string, string> = {};
      if (typeof args.status === "string") query.status = args.status;
      if (typeof args.assignee_agent_id === "string") query.assigneeAgentId = args.assignee_agent_id;
      query.limit = String(typeof args.limit === "number" ? args.limit : 20);
      return safeCall("list_issues", () => ctx.api.listCompanyIssues(ctx.companyId, query));
    },
  };
}

function hireAgentTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "hire_agent",
        description:
          "Hire a new agent into the company. By default this creates an approval request that a human " +
          "must approve before the agent is created. Use this when you need a new role on your team.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string", description: "Job title, e.g. 'Senior Engineer'." },
            mission: { type: "string", description: "What this agent is responsible for." },
            adapter_type: {
              type: "string",
              description: "Adapter to use, e.g. 'openrouter', 'claude_local'.",
              default: "openrouter",
            },
            model: { type: "string", description: "Model id, e.g. 'stepfun/step-3.5-flash:free'." },
            reports_to_agent_id: { type: "string", description: "Manager agent id." },
          },
          required: ["name", "role", "mission"],
        },
      },
    },
    execute: async (args) => {
      const payload: Record<string, unknown> = {
        name: args.name,
        role: args.role,
        mission: args.mission,
        adapterType: args.adapter_type ?? "openrouter",
        model: args.model,
        reportsToAgentId: args.reports_to_agent_id,
        requestedByAgentId: ctx.agentId,
      };

      if (ctx.autoApprove) {
        return safeCall("hire_agent", () => ctx.api.hireAgent(ctx.companyId, payload));
      }

      // Default path: route through approvals so a human signs off.
      return safeCall("hire_agent (approval)", () =>
        ctx.api.createApproval(ctx.companyId, {
          type: "hire_agent",
          requestedByAgentId: ctx.agentId,
          payload: { ...payload, summary: `Hire ${args.name} as ${args.role}` },
        }),
      );
    },
  };
}

function listAgentsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_agents",
        description:
          "List all agents (teammates) in the current company. Returns each agent's id, name, " +
          "role, title, adapter type, model, and status. Use this BEFORE delegating work with " +
          "create_sub_issue or hire_agent so you can reference real agent ids instead of guessing.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    execute: async () => {
      return safeCall("list_agents", async () => {
        const agents = await ctx.api.listCompanyAgents(ctx.companyId);
        // Trim to fields the model actually needs — full agent objects can be huge
        // and waste context window on hundreds of irrelevant runtime config keys.
        return agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          title: a.title,
          adapterType: a.adapterType,
          model: (a.adapterConfig as Record<string, unknown> | undefined)?.model ?? null,
          status: a.status,
          reportsToAgentId: a.reportsToAgentId ?? null,
        }));
      });
    },
  };
}

function requestApprovalTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "request_approval",
        description:
          "Open an approval request for an action that requires human sign-off. " +
          "Only three types are currently supported by Paperclip: hire_agent, " +
          "approve_ceo_strategy, budget_override_required. For hiring, prefer the " +
          "dedicated hire_agent tool instead.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["hire_agent", "approve_ceo_strategy", "budget_override_required"],
              description: "Approval type — must be one of the three supported values.",
            },
            summary: { type: "string", description: "One-line summary for the operator." },
            payload: { type: "object", description: "Structured payload describing the action." },
          },
          required: ["type", "summary"],
        },
      },
    },
    execute: async (args) => {
      const type = asString(args.type);
      const summary = asString(args.summary);
      if (!type) return fail("type is required and must be hire_agent / approve_ceo_strategy / budget_override_required.");
      if (!summary) return fail("summary is required.");
      const payload = (args.payload && typeof args.payload === "object" ? args.payload : {}) as Record<string, unknown>;
      return safeCall("request_approval", () =>
        ctx.api.createApproval(ctx.companyId, {
          type,
          requestedByAgentId: ctx.agentId,
          payload: { ...payload, summary },
        }),
      );
    },
  };
}

// ----- Shell and Filesystem Tools -----

function executeCommandTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "execute_command",
        description: "Execute a shell command and return its output. Use this for running build commands, git operations, package managers, etc.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to execute" },
            cwd: { type: "string", description: "Working directory (optional, defaults to project root)" },
          },
          required: ["command"],
        },
      },
    },
    execute: async (args) => {
      const command = asString(args.command);
      const cwd = asString(args.cwd);
      if (!command) return fail("command is required");

      try {
        const { execSync } = await import("node:child_process");
        const result = execSync(command, {
          cwd: cwd || process.cwd(),
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024, // 10MB
          stdio: ["pipe", "pipe", "pipe"],
        });
        return ok(`Command executed successfully:\n${result}`);
      } catch (err: any) {
        const stderr = err.stderr?.toString() || "";
        const stdout = err.stdout?.toString() || "";
        return fail(`Command failed (exit code ${err.status}):\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
      }
    },
  };
}

function readFileTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a file. Returns the full file content as text.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative path to the file" },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      if (!filePath) return fail("path is required");

      try {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(filePath, "utf-8");
        return ok(`File content (${filePath}):\n${content}`);
      } catch (err: any) {
        return fail(`Failed to read file: ${err.message}`);
      }
    },
  };
}

function writeFileTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a file with the given content. Creates parent directories if needed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative path to the file" },
            content: { type: "string", description: "Content to write to the file" },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      const content = asString(args.content);
      if (!filePath) return fail("path is required");
      if (content === null) return fail("content is required");

      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        
        // Create parent directories if needed
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        
        // Write file
        await fs.writeFile(filePath, content, "utf-8");
        return ok(`File written successfully: ${filePath}`);
      } catch (err: any) {
        return fail(`Failed to write file: ${err.message}`);
      }
    },
  };
}

function listDirectoryTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_directory",
        description: "List files and directories in a given path. Returns names, types, and sizes.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative path to the directory" },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const dirPath = asString(args.path);
      if (!dirPath) return fail("path is required");

      try {
        const fs = await import("node:fs/promises");
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        
        const items = await Promise.all(
          entries.map(async (entry) => {
            const fullPath = `${dirPath}/${entry.name}`;
            let size = 0;
            try {
              const stats = await fs.stat(fullPath);
              size = stats.size;
            } catch {
              // ignore stat errors
            }
            return {
              name: entry.name,
              type: entry.isDirectory() ? "directory" : "file",
              size: entry.isFile() ? size : undefined,
            };
          })
        );

        return ok(JSON.stringify(items, null, 2));
      } catch (err: any) {
        return fail(`Failed to list directory: ${err.message}`);
      }
    },
  };
}

function grepSearchTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "grep_search",
        description: "Search for a pattern in files using grep. Returns matching lines with file paths and line numbers. Essential for finding code before editing.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Search pattern (supports regex)" },
            path: { type: "string", description: "Directory or file to search in" },
            file_pattern: { type: "string", description: "Optional file pattern to filter (e.g., '*.ts', '*.cs')" },
            case_sensitive: { type: "boolean", description: "Case sensitive search (default: false)" },
            max_results: { type: "number", description: "Maximum number of results (default: 100)" },
          },
          required: ["pattern", "path"],
        },
      },
    },
    execute: async (args) => {
      const pattern = asString(args.pattern);
      const searchPath = asString(args.path);
      if (!pattern) return fail("pattern is required");
      if (!searchPath) return fail("path is required");

      const filePattern = asString(args.file_pattern);
      const caseSensitive = args.case_sensitive === true;
      const maxResults = typeof args.max_results === "number" ? args.max_results : 100;

      try {
        const { execSync } = await import("node:child_process");
        const fs = await import("node:fs");
        
        // Check if path exists
        if (!fs.existsSync(searchPath)) {
          return fail(`Path does not exist: ${searchPath}`);
        }

        // Build grep command
        const grepArgs = [
          "-n", // line numbers
          caseSensitive ? "" : "-i", // case insensitive
          "-r", // recursive
          "--color=never",
        ].filter(Boolean);

        if (filePattern) {
          grepArgs.push("--include", filePattern);
        }

        const command = process.platform === "win32"
          ? `findstr /N ${caseSensitive ? "" : "/I"} /S "${pattern}" "${searchPath}\\*"`
          : `grep ${grepArgs.join(" ")} "${pattern}" "${searchPath}"`;

        let result: string;
        try {
          result = execSync(command, {
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err: any) {
          // grep returns exit code 1 when no matches found
          if (err.status === 1) {
            return ok("No matches found");
          }
          throw err;
        }

        // Parse and limit results
        const lines = result.split("\n").filter(Boolean);
        const limited = lines.slice(0, maxResults);
        const truncated = lines.length > maxResults;

        return ok(
          limited.join("\n") +
          (truncated ? `\n\n... (${lines.length - maxResults} more results truncated)` : "")
        );
      } catch (err: any) {
        return fail(`Search failed: ${err.message}`);
      }
    },
  };
}

function editFileTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a file by replacing specific content. Safer than write_file for surgical changes. Finds old_content and replaces with new_content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to edit" },
            old_content: { type: "string", description: "Exact content to find and replace (must match exactly)" },
            new_content: { type: "string", description: "New content to replace with" },
          },
          required: ["path", "old_content", "new_content"],
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      const oldContent = asString(args.old_content);
      const newContent = asString(args.new_content);
      
      if (!filePath) return fail("path is required");
      if (oldContent === null) return fail("old_content is required");
      if (newContent === null) return fail("new_content is required");

      try {
        const fs = await import("node:fs/promises");
        
        // Read current content
        const currentContent = await fs.readFile(filePath, "utf-8");
        
        // Check if old_content exists
        if (!currentContent.includes(oldContent)) {
          return fail(`old_content not found in file. Make sure it matches exactly (including whitespace).`);
        }

        // Check if old_content appears multiple times
        const occurrences = currentContent.split(oldContent).length - 1;
        if (occurrences > 1) {
          return fail(`old_content appears ${occurrences} times in the file. Make it more specific to match only once.`);
        }

        // Replace content
        const updatedContent = currentContent.replace(oldContent, newContent);
        await fs.writeFile(filePath, updatedContent, "utf-8");

        return ok(`File edited successfully: ${filePath}\nReplaced ${oldContent.length} characters with ${newContent.length} characters`);
      } catch (err: any) {
        return fail(`Failed to edit file: ${err.message}`);
      }
    },
  };
}

function webFetchTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch content from a URL. Useful for reading documentation, API responses, or web pages. Returns the response body as text.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch (must start with http:// or https://)" },
            method: { type: "string", description: "HTTP method (default: GET)", enum: ["GET", "POST", "PUT", "DELETE"] },
            headers: { type: "object", description: "Optional HTTP headers" },
            body: { type: "string", description: "Request body (for POST/PUT)" },
          },
          required: ["url"],
        },
      },
    },
    execute: async (args) => {
      const url = asString(args.url);
      if (!url) return fail("url is required");
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return fail("url must start with http:// or https://");
      }

      const method = asString(args.method, "GET").toUpperCase();
      const headers = typeof args.headers === "object" && args.headers !== null
        ? args.headers as Record<string, string>
        : {};
      const body = asString(args.body);

      try {
        const response = await fetch(url, {
          method,
          headers: {
            "User-Agent": "Paperclip-OpenRouter-Adapter/1.0",
            ...headers,
          },
          body: body || undefined,
        });

        const contentType = response.headers.get("content-type") || "";
        let content: string;

        if (contentType.includes("application/json")) {
          const json = await response.json();
          content = JSON.stringify(json, null, 2);
        } else {
          content = await response.text();
        }

        // Limit response size
        const maxSize = 50000; // 50KB
        if (content.length > maxSize) {
          content = content.slice(0, maxSize) + `\n\n... (truncated ${content.length - maxSize} characters)`;
        }

        return ok(`HTTP ${response.status} ${response.statusText}\n\n${content}`);
      } catch (err: any) {
        return fail(`Failed to fetch URL: ${err.message}`);
      }
    },
  };
}

function globTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "glob",
        description: "Find files matching a glob pattern. More powerful than list_directory for finding specific files. Examples: '**/*.ts', 'src/**/*.cs', '**/package.json'",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts', 'src/**/*.cs')" },
            cwd: { type: "string", description: "Working directory (default: current directory)" },
            max_results: { type: "number", description: "Maximum number of results (default: 200)" },
          },
          required: ["pattern"],
        },
      },
    },
    execute: async (args) => {
      const pattern = asString(args.pattern);
      if (!pattern) return fail("pattern is required");

      const cwd = asString(args.cwd) || process.cwd();
      const maxResults = typeof args.max_results === "number" ? args.max_results : 200;

      try {
        const { execSync } = await import("node:child_process");
        
        // Use find on Unix, dir on Windows
        const command = process.platform === "win32"
          ? `dir /S /B "${pattern}"`
          : `find "${cwd}" -type f -path "${pattern}"`;

        let result: string;
        try {
          result = execSync(command, {
            cwd,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err: any) {
          if (err.status === 1) {
            return ok("No files found matching pattern");
          }
          throw err;
        }

        const files = result.split("\n").filter(Boolean);
        const limited = files.slice(0, maxResults);
        const truncated = files.length > maxResults;

        return ok(
          limited.join("\n") +
          (truncated ? `\n\n... (${files.length - maxResults} more files truncated)` : "") +
          `\n\nTotal: ${files.length} files`
        );
      } catch (err: any) {
        return fail(`Glob search failed: ${err.message}`);
      }
    },
  };
}

function gitDiffTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "git_diff",
        description: "Show git diff of changes. Useful for reviewing what changed before committing.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Optional path to diff (default: all changes)" },
            staged: { type: "boolean", description: "Show staged changes only (default: false)" },
            cwd: { type: "string", description: "Repository directory (default: current directory)" },
          },
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      const staged = args.staged === true;
      const cwd = asString(args.cwd) || process.cwd();

      try {
        const { execSync } = await import("node:child_process");
        
        const diffArgs = staged ? ["--cached"] : [];
        if (filePath) diffArgs.push(filePath);

        const result = execSync(`git diff ${diffArgs.join(" ")}`, {
          cwd,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });

        if (!result.trim()) {
          return ok(staged ? "No staged changes" : "No changes");
        }

        // Limit diff size
        const maxSize = 50000;
        if (result.length > maxSize) {
          return ok(result.slice(0, maxSize) + `\n\n... (diff truncated, ${result.length - maxSize} characters omitted)`);
        }

        return ok(result);
      } catch (err: any) {
        return fail(`Git diff failed: ${err.message}`);
      }
    },
  };
}

function moveFileTool(_ctx: BuildToolsContext): Tool {
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
      
      if (!source) return fail("source is required");
      if (!destination) return fail("destination is required");

      try {
        const fs = await import("node:fs/promises");
        await fs.rename(source, destination);
        return ok(`Moved: ${source} → ${destination}`);
      } catch (err: any) {
        return fail(`Failed to move file: ${err.message}`);
      }
    },
  };
}

function deleteFileTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file or directory. Use with caution - this cannot be undone!",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to delete" },
            recursive: { type: "boolean", description: "Delete directory recursively (default: false)" },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      const recursive = args.recursive === true;
      
      if (!filePath) return fail("path is required");

      try {
        const fs = await import("node:fs/promises");
        const stats = await fs.stat(filePath);

        if (stats.isDirectory()) {
          if (!recursive) {
            return fail("Path is a directory. Set recursive=true to delete it.");
          }
          await fs.rm(filePath, { recursive: true, force: true });
          return ok(`Deleted directory: ${filePath}`);
        } else {
          await fs.unlink(filePath);
          return ok(`Deleted file: ${filePath}`);
        }
      } catch (err: any) {
        return fail(`Failed to delete: ${err.message}`);
      }
    },
  };
}

// ----- public API -----

export function buildTools(ctx: BuildToolsContext): Tool[] {
  return [
    // Paperclip API tools (9)
    getIssueTool(ctx),
    updateIssueStatusTool(ctx),
    addCommentTool(ctx),
    listCommentsTool(ctx),
    createSubIssueTool(ctx),
    listIssuesTool(ctx),
    listAgentsTool(ctx),
    hireAgentTool(ctx),
    requestApprovalTool(ctx),
    
    // Basic filesystem tools (4)
    executeCommandTool(ctx),
    readFileTool(ctx),
    writeFileTool(ctx),
    listDirectoryTool(ctx),
    
    // Advanced tools (7)
    grepSearchTool(ctx),      // Search in files
    editFileTool(ctx),         // Surgical file edits
    webFetchTool(ctx),         // Fetch URLs/docs
    globTool(ctx),             // Find files by pattern
    gitDiffTool(ctx),          // Show git changes
    moveFileTool(ctx),         // Move/rename files
    deleteFileTool(ctx),       // Delete files
  ];
}

/** Get the schemas to send to the model. */
export function toolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}

/** Look up a tool by name. Returns null if not found. */
export function findTool(tools: Tool[], name: string): Tool | null {
  return tools.find((t) => t.schema.function.name === name) ?? null;
}
