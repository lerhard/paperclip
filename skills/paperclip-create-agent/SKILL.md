---
name: paperclip-create-agent
description: Create new agents in Paperclip with governance-aware hiring. Use when inspecting adapter configs, comparing agents, drafting prompts, submitting hire requests.
---

# Paperclip Create Agent Skill

Use when asked to hire/create an agent.

## Preconditions

Need board access OR `can_create_agents=true`. If not, escalate to CEO/board.

## Workflow

### 1. Confirm identity
```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/me" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 2. Discover adapter config
```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration.txt" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration/<adapter>.txt" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 3. Compare existing agents
```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-configurations" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 4. Choose instruction source (critical for quality)

Pick exactly one:
- **Exact template** — role matches template index. Use `references/agents/<role>.md`.
- **Adjacent template** — close match. Adapt: rename, rewrite charter, swap lenses, remove misfit sections.
- **Generic fallback** — no template close. Build from `references/baseline-role-guide.md`.

State path taken in hire comment for board visibility.

Templates: `references/agent-instruction-templates.md`
Baseline: `references/baseline-role-guide.md`

### 5. Discover icons
```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-icons.txt" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 6. Draft hire config

- name, role, title, icon (from `/llms/agent-icons.txt`)
- reporting line (`reportsTo`)
- adapter type + config aligned to environment
- `desiredSkills` from company library if needed; justify any expanded access (browser, external systems, secrets)
- capabilities
- `instructionsBundle.files["AGENTS.md"]` for managed-bundle adapters. Do NOT set `adapterConfig.promptTemplate` or `bootstrapPromptTemplate`
- execution contract for coding agents: act same heartbeat; durable progress + clear next action; child issues for delegation; mark blocked with owner/action; respect budget/gates/boundaries
- `runtimeConfig.heartbeat.enabled=false` by default; only enable with `intervalSec` if role needs scheduled work
- `sourceIssueId` if hire came from issue
- confirm confidential workflow exists if role handles sensitive disclosures

### 7. Review quality checklist

Walk `references/draft-review-checklist.md` end-to-end before submitting.

### 8. Submit hire request

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CTO", "role": "cto", "title": "Chief Technology Officer",
    "icon": "crown", "reportsTo": "<ceo-id>",
    "capabilities": "Owns technical roadmap, architecture, staffing",
    "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
    "adapterType": "codex_local",
    "adapterConfig": {"cwd": "/path/to/repo", "model": "o4-mini"},
    "instructionsBundle": {"files": {"AGENTS.md": "You are the CTO..."}},
    "runtimeConfig": {"heartbeat": {"enabled": false, "wakeOnDemand": true}},
    "sourceIssueId": "<issue-id>"
  }'
```

### 9. Handle governance

- Response has `approval` → `pending_approval`. Monitor approval thread.
- Approved → woken with `PAPERCLIP_APPROVAL_ID`. Read linked issues, close/comment follow-up.

```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/<approval-id>" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/<approval-id>/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"body":"## Hire submitted\n\n- Approval: [<id>](/approvals/<id>)\n- Pending: [<agent>](/agents/<key>)\n- Source: [<issue>](/issues/<id>)"}'
```

Link existing approval to issue:
```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/<issue-id>/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" -d '{"approvalId":"<id>"}'
```

Post-approval loop:
```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
curl -sS "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID/issues" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```
For each linked issue: close if resolved, or comment with links + next actions.

## References

- Templates: `references/agent-instruction-templates.md`
- Role templates: `references/agents/`
- Baseline guide: `references/baseline-role-guide.md`
- Quality checklist: `references/draft-review-checklist.md`
- API reference: `references/api-reference.md`
