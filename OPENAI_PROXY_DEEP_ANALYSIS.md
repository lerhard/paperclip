# Análise Profunda: openai_proxy vs OpenRouter — Erros Potenciais

> Data: 2026-05-20
> Branch: feat/openrouter-adapter
> Base de comparação: `packages/adapters/openrouter/src/server/execute.ts` (997 linhas, produção)
> Alvo: `packages/adapters/openai-proxy/src/server/execute.ts` (320 linhas, novo)

---

## 1. ERROS JÁ CORRIGIDOS

| # | Problema | Impacto | Status |
|---|----------|---------|--------|
| 1 | `paperclipApiBaseUrl` não existia no `AdapterExecutionContext` → URLs relativas falhavam | Todas as chamadas `paperclip_api` retornavam `Failed to parse URL` | **Corrigido** — agora lê `PAPERCLIP_API_URL` do env |
| 2 | Truncamento de contexto cortava no meio de pares `assistant(tool_calls)` + `tool` | API OpenAI rejeitava com `No tool call found for function call output` | **Corrigido** — slice garante não começar com `role: "tool"` |

---

## 2. ERROS CRÍTICOS — VÃO ACONTECER EM PRODUÇÃO

### 2.1 `authToken` é `null` → Paperclip API retorna 401

**Onde:** `execute.ts:116`
```ts
apiKey: (authToken as string | null) ?? "",
```

**O que o OpenRouter faz:**
```ts
if (authToken) {
  api = new PaperclipApi({ authToken });
  tools = buildTools({ api, ... });
} else {
  // Loga warning, desabilita tools, mas permite texto
  await writeRawStderr(onLog, "[openrouter] No authToken — tool calls disabled.");
}
```

**O que o openai_proxy faz:** Passa `apiKey: ""` direto. A `paperclip_api` tool vai chamar `fetch` com `Authorization: Bearer ` (vazio) → **401 Unauthorized**.

**Fix:** Se `authToken` for null/undefined, logar warning e não incluir `paperclip_api` no `buildTools`, OU passar flag `toolsEnabled: false`.

---

### 2.2 Issue checkout não existe — Paperclip rejeita writes

**O que o OpenRouter faz (linhas 522–577):**
- Detecta se o heartbeat já fez checkout (`preLocked`)
- Se não, chama `api.checkoutIssue(currentIssueId, agent.id)`
- Marca issue como `in_progress`

**O que o openai_proxy faz:** Nada. Zero código de checkout.

**Impacto:** Quando a tool `paperclip_api` tentar `update_issue_status`, `add_comment`, `create_sub_issue`, o Paperclip pode rejeitar com:
> `Issue not checked out by this run` (ou similar, dependendo da versão do server)

**Fix:** Adicionar checkout + marcação `in_progress` antes do loop, igual OpenRouter.

---

### 2.3 Sem retry em erros de API — qualquer 429/500 mata a run

**O que o OpenRouter faz (linhas 267–391):**
- 5 retries com round-robin de API keys
- Backoff exponencial para 429
- Truncamento de contexto para 400 de "context length"
- Detecta rate limit diário vs por-minuto

**O que o openai_proxy faz:**
```ts
if (!res.ok) {
  throw new Error(`OpenAI Proxy API error ${res.status}`);
}
```

Um único 429 de rate limit ou 500 de servidor mata a run inteira.

**Fix:** Implementar retry com backoff exponencial para 429/5xx.

---

### 2.4 `content` em mensagem `assistant` com `tool_calls` pode quebrar APIs

**O que a OpenAI exige:** Quando `tool_calls` está presente, `content` deve ser `null` ou string vazia. Algumas APIs (incluindo OpenRouter) são flexíveis, mas outras não.

**O que o openai_proxy faz (linha 224):**
```ts
messages.push({
  role: "assistant",
  content: msg.content ?? "",
  tool_calls: msg.tool_calls,
});
```

Se `msg.content` for `""` e a API for estrita, pode rejeitar.

**Fix:** Usar `content: msg.content || null` (OpenRouter faz exatamente isso).

---

### 2.5 Sem detecção de loop infinito — modelo pode ficar preso

**O que o OpenRouter faz (linhas 612–857):**
- Tracka últimas 3 chamadas de tool
- Se mesma tool + mesmos args 3x seguidas → quebra loop com `stoppedReason = "repeat_loop"`
- Atualiza issue status para `blocked` com razão

**O que o openai_proxy faz:** Nada. Modelo pode chamar `get_issue` 12 vezes seguidas e esgotar todos os turnos.

**Fix:** Adicionar `recentCalls` array + threshold check.

---

### 2.6 Sem cache de tool results — re-executa tools idênticas

**O que o OpenRouter faz (linha 621):**
```ts
const toolResultCache = new Map<string, { content: string; isError: boolean }>();
```

**O que o openai_proxy faz:** Nada. Se o modelo chamar `list_directory` 2x com o mesmo path em turns diferentes, executa 2x.

**Impacto:** Perda de tokens e tempo.

**Fix:** Adicionar cache por `(toolName + JSON.stringify(args))`.

---

### 2.7 Sem compressão de tool results — estoura context window

**O que o OpenRouter faz (linhas 775–823):**
- Compressão JSON via `compressToolResult` (TOON, RTK, Varman)
- Redução de 30–70% no tamanho dos resultados
- Envia comprimido para o modelo, mostra original na UI

**O que o openai_proxy faz:** Truncamento simples em 8000 chars (`MAX_RESULT_CHARS`).

**Impacto:** Tool results grandes (ex: `list_directory` em node_modules, `glob` em `**/*.ts`) rapidamente estouram o contexto da API.

**Fix:** Portar `compressToolResult` do OpenRouter ou usar truncamento mais agressivo.

---

## 3. ERROS MÉDIOS — PROBLEMAS DE UX E RELATÓRIOS

### 3.1 Não atualiza issue status automaticamente

**O que o OpenRouter faz (linhas 567–577, 893–917):**
- Início: `status = in_progress`
- Sucesso: `status = done`
- Max turns / erro / loop: `status = blocked` + razão
- Posta comentário com resultado final

**O que o openai_proxy faz:** Nada. Issue fica no status que estava antes da run.

**Impacto:** Operador não sabe se a run terminou, falhou, ou está travada.

---

### 3.2 Não posta resultado final como comentário

**O que o OpenRouter faz (linhas 883–891):**
```ts
if (api && currentIssueId && finalAssistantText.trim().length > 0) {
  await api.addIssueComment(currentIssueId, { body: finalAssistantText });
}
```

**O que o openai_proxy faz:** Nada. O texto final só aparece no transcript, não na issue.

---

### 3.3 Usage/cost sempre zero

**O que o OpenRouter faz:**
- Lê `response.usage.prompt_tokens` e `completion_tokens`
- Busca cost real no `/generation` endpoint
- Retorna no `AdapterExecutionResult`

**O que o openai_proxy faz (linha 291):**
```ts
const usage = { inputTokens: 0, outputTokens: 0 };
```

Sempre zero. Dashboard de custos do Paperclip vai mostrar $0.

---

### 3.4 Sem support para `instructionsFilePath`

**O que o OpenRouter faz (linhas 482–496):**
- Lê arquivo de instruções do filesystem
- Substitui `systemPrompt` pelo conteúdo do arquivo

**O que o openai_proxy faz:** Usa apenas `systemPrompt` inline.

---

### 3.5 Sem support para skills

**O que o OpenRouter faz (linhas 497–506):**
- Carrega skills dinâmicas via `loadSkills()`
- Injeta no system prompt

**O que o openai_proxy faz:** Nada. Skills não funcionam.

---

## 4. ERROS MENORES — CONFIGURAÇÃO E EDGE CASES

### 4.1 `maxTokens = 2048` pode ser insuficiente

OpenRouter usa 4096 para modelos pagos. 2048 pode cortar respostas longas ou tool calls complexos.

### 4.2 `TURN_DELAY_MS = 1200` fixo

OpenRouter usa delay maior (1500ms) para free tier e 0 para pago. Delay fixo desperdiça tempo em APIs rápidas.

### 4.3 Sem tratamento de `finish_reason`

OpenRouter checa `choice.finish_reason` para detectar:
- `stop` → terminou normalmente
- `length` → cortado por max_tokens (aumentar)
- `content_filter` → censurado
- `tool_calls` → chamou tools

openai_proxy ignora completamente.

### 4.4 `temperature = 0.7` sem opção de override

Não respeita `config.temperature` se for 0 (modo determinístico).

### 4.5 `model` não validado

Se o modelo configurado não existir na API, o erro vem da API em vez de uma validação local.

---

## 5. RESUMO PRIORITÁRIO

| Prioridade | Problema | Linha no openai_proxy | Esforço |
|------------|----------|----------------------|---------|
| **P0** | `authToken` null → 401 em todas as API calls | `tools.ts:188-194` (callApi) | Baixo |
| **P0** | Sem issue checkout → writes rejeitados | Não existe | Médio |
| **P0** | Sem retry → 429/500 mata run | `execute.ts:201-203` | Médio |
| **P1** | Sem detecção de loop infinito | Não existe | Baixo |
| **P1** | Sem cache de tool results | Não existe | Baixo |
| **P1** | `content: ""` com `tool_calls` pode quebrar APIs | `execute.ts:224` | Baixo |
| **P2** | Sem atualização automática de issue status | Não existe | Médio |
| **P2** | Sem post de comentário final | Não existe | Baixo |
| **P2** | Usage/cost sempre zero | `execute.ts:291` | Baixo |
| **P3** | Sem compressão de tool results | `tools.ts:20` | Alto |
| **P3** | Sem skills | Não existe | Alto |

---

## 6. RECOMENDAÇÃO

O `openai_proxy` funciona para "chat básico", mas **não é production-ready** para uso como agente que modifica issues. Os 3 problemas P0 (auth, checkout, retry) vão causar falhas constantes em produção.

**Caminho mais rápido:** Portar as seções de `execute.ts` do OpenRouter que lidam com:
1. Checkout de issue (linhas 522–577)
2. Retry com backoff (linhas 237–391)
3. Detecção de loop + cache (linhas 612–857)
4. Post-loop: comentário + status update (linhas 871–917)

Isso adiciona ~200 linhas mas torna o adapter robusto.
