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
        description: "Fetch issue details. Defaults to current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: {
              type: "string",
              description: "Issue id. Omit for current.",
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
        description: "Move issue to new status: open|in_progress|blocked|done|cancelled. Defaults to current.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit for current." },
            status: {
              type: "string",
              enum: ["open", "in_progress", "blocked", "done", "cancelled"],
            },
            reason: { type: "string", description: "Optional reason." },
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
        description: "Post a comment. Defaults to current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit for current." },
            body: { type: "string", description: "Comment body." },
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
        description: "List issue comments. Defaults to current.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit for current." },
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
        description: "Create child issue. Defaults to current parent.",
        parameters: {
          type: "object",
          properties: {
            parent_issue_id: { type: "string", description: "Parent issue id. Omit for current." },
            title: { type: "string" },
            description: { type: "string" },
            assignee_agent_id: { type: "string", description: "Optional agent id." },
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
        description: "List company issues. Filter by status or assignee.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string" },
            assignee_agent_id: { type: "string" },
            limit: { type: "number", description: "Max results. Default 20." },
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
        description: "Hire new agent. Creates approval request by default.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string", description: "Job title." },
            mission: { type: "string", description: "Agent mission." },
            adapter_type: {
              type: "string",
              description: "Adapter type.",
              default: "openrouter",
            },
            model: { type: "string", description: "Model id." },
            reports_to_agent_id: { type: "string", description: "Manager id." },
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
        description: "List company agents. Use before delegating work.",
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
        description: "Request human approval. Types: hire_agent, approve_ceo_strategy, budget_override_required.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["hire_agent", "approve_ceo_strategy", "budget_override_required"],
              description: "Approval type.",
            },
            summary: { type: "string", description: "One-line summary." },
            payload: { type: "object", description: "Action payload." },
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
        description: "Execute shell command.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command" },
            cwd: { type: "string", description: "Working dir. Default project root." },
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
        description: "Read file contents.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
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
        description: "Write file. Creates parent dirs if needed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File content" },
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
        description: "List directory contents.",
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
        description: "Grep search files for pattern.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern" },
            path: { type: "string", description: "Directory or file" },
            file_pattern: { type: "string", description: "Optional filter e.g. '*.ts'" },
            case_sensitive: { type: "boolean", description: "Case sensitive. Default false." },
            max_results: { type: "number", description: "Max results. Default 100." },
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
        description: "Edit file by replacing old_content with new_content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            old_content: { type: "string", description: "Content to find" },
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
        description: "Fetch URL content.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL" },
            method: { type: "string", description: "HTTP method. Default GET.", enum: ["GET", "POST", "PUT", "DELETE"] },
            headers: { type: "object", description: "Optional headers" },
            body: { type: "string", description: "Request body" },
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
        description: "Find files by glob pattern.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern e.g. '**/*.ts'" },
            cwd: { type: "string", description: "Working dir. Default current." },
            max_results: { type: "number", description: "Max results. Default 200." },
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

// ----- Monitoring Tools -----

function tailLogTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "tail_log",
        description: "Read the last N lines of a file. Useful for checking logs, build output, or recent file changes.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file" },
            lines: { type: "number", description: "Number of lines to read (default: 50)" },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const filePath = asString(args.path);
      if (!filePath) return fail("path is required");

      const lines = typeof args.lines === "number" ? args.lines : 50;

      try {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(filePath, "utf-8");
        const allLines = content.split("\n");
        const lastLines = allLines.slice(-lines);
        
        return ok(`Last ${lastLines.length} lines of ${filePath}:\n${lastLines.join("\n")}`);
      } catch (err: any) {
        return fail(`Failed to read file: ${err.message}`);
      }
    },
  };
}

// ----- Process Tools -----

function killProcessTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "kill_process",
        description: "Kill a process by PID. Use with caution! Useful for stopping stuck dev servers or processes.",
        parameters: {
          type: "object",
          properties: {
            pid: { type: "number", description: "Process ID to kill" },
            force: { type: "boolean", description: "Force kill (SIGKILL) instead of graceful (SIGTERM). Default: false" },
          },
          required: ["pid"],
        },
      },
    },
    execute: async (args) => {
      const pid = typeof args.pid === "number" ? args.pid : null;
      if (pid === null) return fail("pid is required and must be a number");

      const force = args.force === true;

      try {
        const signal = force ? "SIGKILL" : "SIGTERM";
        process.kill(pid, signal);
        return ok(`Process ${pid} killed with ${signal}`);
      } catch (err: any) {
        return fail(`Failed to kill process: ${err.message}`);
      }
    },
  };
}

function listProcessesTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_processes",
        description: "List running processes. Useful for finding PIDs of dev servers, databases, or other services.",
        parameters: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Optional filter by process name (e.g., 'node', 'dotnet', 'postgres')" },
          },
        },
      },
    },
    execute: async (args) => {
      const filter = asString(args.filter);

      try {
        const { execSync } = await import("node:child_process");
        
        const command = process.platform === "win32"
          ? "tasklist"
          : "ps aux";

        let result = execSync(command, {
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });

        // Filter if requested
        if (filter) {
          const lines = result.split("\n");
          const filtered = lines.filter(line => 
            line.toLowerCase().includes(filter.toLowerCase())
          );
          result = filtered.join("\n");
        }

        // Limit output
        const maxSize = 10000;
        if (result.length > maxSize) {
          result = result.slice(0, maxSize) + `\n\n... (truncated ${result.length - maxSize} characters)`;
        }

        return ok(result || "No processes found");
      } catch (err: any) {
        return fail(`Failed to list processes: ${err.message}`);
      }
    },
  };
}

// ----- Environment Tools -----

function getEnvTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "get_env",
        description: "Get environment variable value. Useful for checking configuration, API keys, paths, etc.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Environment variable name (e.g., 'PATH', 'NODE_ENV')" },
          },
          required: ["key"],
        },
      },
    },
    execute: async (args) => {
      const key = asString(args.key);
      if (!key) return fail("key is required");

      const value = process.env[key];
      if (value === undefined) {
        return ok(`Environment variable '${key}' is not set`);
      }

      return ok(`${key}=${value}`);
    },
  };
}

// ----- Network Tools -----

function testPortTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "test_port",
        description: "Test if a port is open/listening. Useful for checking if a server is running.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Host to test (default: localhost)" },
            port: { type: "number", description: "Port number to test" },
            timeout: { type: "number", description: "Timeout in milliseconds (default: 3000)" },
          },
          required: ["port"],
        },
      },
    },
    execute: async (args) => {
      const port = typeof args.port === "number" ? args.port : null;
      if (port === null) return fail("port is required and must be a number");

      const host = asString(args.host, "localhost");
      const timeout = typeof args.timeout === "number" ? args.timeout : 3000;

      try {
        const net = await import("node:net");
        
        return await new Promise<ToolExecutionResult>((resolve) => {
          const socket = new net.Socket();
          let resolved = false;

          const cleanup = () => {
            if (!resolved) {
              resolved = true;
              socket.destroy();
            }
          };

          socket.setTimeout(timeout);
          
          socket.on("connect", () => {
            cleanup();
            resolve(ok(`Port ${port} on ${host} is OPEN`));
          });

          socket.on("timeout", () => {
            cleanup();
            resolve(ok(`Port ${port} on ${host} is CLOSED (timeout)`));
          });

          socket.on("error", (err: any) => {
            cleanup();
            if (err.code === "ECONNREFUSED") {
              resolve(ok(`Port ${port} on ${host} is CLOSED (connection refused)`));
            } else {
              resolve(fail(`Error testing port: ${err.message}`));
            }
          });

          socket.connect(port, host);
        });
      } catch (err: any) {
        return fail(`Failed to test port: ${err.message}`);
      }
    },
  };
}

// ----- Code Analysis Tools -----

function findTodosTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "find_todos",
        description: "Find TODO, FIXME, HACK, XXX comments in code. Useful for code review and finding work items.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory or file to search" },
            file_pattern: { type: "string", description: "File pattern (e.g., '*.ts', '*.cs')" },
            max_results: { type: "number", description: "Maximum results (default: 100)" },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const searchPath = asString(args.path);
      if (!searchPath) return fail("path is required");

      const filePattern = asString(args.file_pattern);
      const maxResults = typeof args.max_results === "number" ? args.max_results : 100;

      try {
        const { execSync } = await import("node:child_process");
        
        // Search for TODO, FIXME, HACK, XXX, NOTE
        const pattern = "TODO|FIXME|HACK|XXX|NOTE";
        
        const grepArgs = ["-n", "-i", "-r", "--color=never", "-E"];
        if (filePattern) {
          grepArgs.push("--include", filePattern);
        }

        const command = process.platform === "win32"
          ? `findstr /N /I /S /R "TODO FIXME HACK XXX NOTE" "${searchPath}\\*"`
          : `grep ${grepArgs.join(" ")} "${pattern}" "${searchPath}"`;

        let result: string;
        try {
          result = execSync(command, {
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err: any) {
          if (err.status === 1) {
            return ok("No TODOs/FIXMEs found");
          }
          throw err;
        }

        const lines = result.split("\n").filter(Boolean);
        const limited = lines.slice(0, maxResults);
        const truncated = lines.length > maxResults;

        return ok(
          `Found ${lines.length} TODO/FIXME comments:\n\n` +
          limited.join("\n") +
          (truncated ? `\n\n... (${lines.length - maxResults} more results truncated)` : "")
        );
      } catch (err: any) {
        return fail(`Search failed: ${err.message}`);
      }
    },
  };
}

function countLinesTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "count_lines",
        description: "Count lines of code in files. Useful for code metrics and understanding project size.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File or directory to count" },
            file_pattern: { type: "string", description: "File pattern (e.g., '*.ts', '*.cs')" },
            exclude_blank: { type: "boolean", description: "Exclude blank lines (default: false)" },
          },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      const searchPath = asString(args.path);
      if (!searchPath) return fail("path is required");

      const filePattern = asString(args.file_pattern);
      const excludeBlank = args.exclude_blank === true;

      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        
        const stats = await fs.stat(searchPath);
        let totalLines = 0;
        let totalFiles = 0;

        const countFile = async (filePath: string): Promise<number> => {
          const content = await fs.readFile(filePath, "utf-8");
          const lines = content.split("\n");
          if (excludeBlank) {
            return lines.filter(line => line.trim().length > 0).length;
          }
          return lines.length;
        };

        const processDirectory = async (dir: string) => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
              await processDirectory(fullPath);
            } else if (entry.isFile()) {
              if (!filePattern || entry.name.match(new RegExp(filePattern.replace("*", ".*")))) {
                totalLines += await countFile(fullPath);
                totalFiles++;
              }
            }
          }
        };

        if (stats.isDirectory()) {
          await processDirectory(searchPath);
        } else {
          totalLines = await countFile(searchPath);
          totalFiles = 1;
        }

        return ok(
          `Lines of code: ${totalLines}\n` +
          `Files: ${totalFiles}\n` +
          `Average: ${totalFiles > 0 ? Math.round(totalLines / totalFiles) : 0} lines/file` +
          (excludeBlank ? " (blank lines excluded)" : "")
        );
      } catch (err: any) {
        return fail(`Failed to count lines: ${err.message}`);
      }
    },
  };
}

// ----- Diff Tools -----

function diffFilesTool(_ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "diff_files",
        description: "Compare two files and show differences. Useful for reviewing changes or comparing versions.",
        parameters: {
          type: "object",
          properties: {
            file1: { type: "string", description: "First file path" },
            file2: { type: "string", description: "Second file path" },
            unified: { type: "number", description: "Lines of context (default: 3)" },
          },
          required: ["file1", "file2"],
        },
      },
    },
    execute: async (args) => {
      const file1 = asString(args.file1);
      const file2 = asString(args.file2);
      
      if (!file1) return fail("file1 is required");
      if (!file2) return fail("file2 is required");

      const unified = typeof args.unified === "number" ? args.unified : 3;

      try {
        const { execSync } = await import("node:child_process");
        
        const command = process.platform === "win32"
          ? `fc "${file1}" "${file2}"`
          : `diff -u${unified} "${file1}" "${file2}"`;

        let result: string;
        try {
          result = execSync(command, {
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err: any) {
          // diff returns exit code 1 when files differ
          if (err.status === 1 && err.stdout) {
            result = err.stdout;
          } else if (err.status === 0) {
            return ok("Files are identical");
          } else {
            throw err;
          }
        }

        if (!result || result.trim() === "") {
          return ok("Files are identical");
        }

        // Limit diff size
        const maxSize = 50000;
        if (result.length > maxSize) {
          result = result.slice(0, maxSize) + `\n\n... (diff truncated, ${result.length - maxSize} characters omitted)`;
        }

        return ok(result);
      } catch (err: any) {
        return fail(`Diff failed: ${err.message}`);
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
    
    // Professional tools (10)
    tailLogTool(ctx),          // Read last N lines of file
    killProcessTool(ctx),      // Kill process by PID
    listProcessesTool(ctx),    // List running processes
    getEnvTool(ctx),           // Get environment variable
    testPortTool(ctx),         // Test if port is open
    findTodosTool(ctx),        // Find TODO/FIXME comments
    countLinesTool(ctx),       // Count lines of code
    diffFilesTool(ctx),        // Compare two files
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
