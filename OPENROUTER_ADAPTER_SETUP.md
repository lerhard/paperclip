# OpenRouter Adapter - Guia de Instalação e Uso

## ⚠️ IMPORTANTE: Sistema de Plugins

Este fork do Paperclip (`HenkDz/paperclip`) usa o **sistema de plugins externos** (PR #2218).

**Você NÃO precisa** aplicar os patches manuais mencionados no `REGISTRY_PATCHES.md` do adapter original. O adapter é carregado automaticamente através do arquivo `~/.paperclip/adapter-plugins.json`.

## ✅ Status da Instalação

O adapter OpenRouter foi instalado com sucesso como um **plugin externo** no seu Paperclip.

## 📁 Localização

- **Código do adapter**: `c:\Users\Léon\Documents\paperclip\packages\adapters\openrouter`
- **Configuração do plugin**: `C:\Users\Léon\.paperclip\adapter-plugins.json`
- **Script de registro**: `c:\Users\Léon\Documents\paperclip\scripts\register-openrouter-adapter.js`

## 🔧 O que foi feito

1. ✅ Adapter OpenRouter clonado em `packages/adapters/openrouter`
2. ✅ Função `createServerAdapter()` adicionada para compatibilidade com o plugin loader
3. ✅ Adapter registrado no plugin store (`~/.paperclip/adapter-plugins.json`)
4. ✅ Script de registro criado para facilitar reinstalações futuras
5. ✅ `package.json` atualizado para usar o nome correto do workspace (`@paperclipai/adapter-openrouter`)

## 🔄 Diferenças do Adapter Original

O adapter original (https://github.com/talhamahmood666/paperclip-adapter-openrouter) foi projetado para integração manual através de patches nos arquivos de registro.

**Neste fork, a integração é diferente:**

- ❌ **NÃO edite** `server/src/adapters/registry.ts`
- ❌ **NÃO edite** `server/src/adapters/builtin-adapter-types.ts`  
- ❌ **NÃO edite** `ui/src/adapters/registry.ts`
- ❌ **NÃO edite** `cli/src/adapters/registry.ts`

✅ **O adapter é carregado automaticamente** pelo plugin loader através de:
- `~/.paperclip/adapter-plugins.json` (registro do plugin)
- `createServerAdapter()` exportado pelo adapter (interface padrão)
- Plugin loader em `server/src/adapters/plugin-loader.ts`

## 🚀 Próximos Passos

### 1. Instalar Dependências

Execute no terminal (na raiz do projeto):

```powershell
# Se pnpm estiver instalado
pnpm install

# OU usando npx
npx pnpm install

# OU instalar pnpm globalmente primeiro
npm install -g pnpm
pnpm install
```

### 2. Reiniciar o Servidor Paperclip

Após instalar as dependências, reinicie o servidor Paperclip:

```powershell
# Parar qualquer instância em execução
# Ctrl+C no terminal do servidor

# Iniciar novamente
pnpm dev
```

### 3. Configurar API Key do OpenRouter

Você precisará de uma API key do OpenRouter:

1. Acesse: https://openrouter.ai/keys
2. Crie uma nova API key
3. Configure as variáveis de ambiente:

```powershell
# No arquivo .env ou .paperclip/.env
OPENROUTER_API_KEY=sk-or-v1-your-key-here
PAPERCLIP_AGENT_JWT_SECRET=<gerar-com-openssl-rand-hex-32>
PAPERCLIP_API_URL=http://localhost:3100
```

### 4. Usar o Adapter

Após reiniciar o servidor:

1. Acesse a UI do Paperclip
2. Vá para **Org Chart → Hire Agent**
3. Selecione **Adapter Type: OpenRouter**
4. Escolha um modelo (ex: `openai/gpt-4o-mini` ou `openrouter/auto`)
5. Configure conforme necessário
6. Crie um issue e atribua ao agente

## 🛠️ Ferramentas Disponíveis

O adapter OpenRouter inclui **30 ferramentas profissionais** que os agentes podem usar:

### Gerenciamento de Issues (9 tools)
1. **get_issue** - Buscar detalhes de uma issue
2. **update_issue_status** - Mudar status de uma issue
3. **add_comment** - Postar comentário em uma issue
4. **list_comments** - Listar comentários de uma issue
5. **create_sub_issue** - Criar sub-issue
6. **list_issues** - Listar issues da company
7. **list_agents** - Listar agentes da company
8. **hire_agent** - Contratar novo agente
9. **request_approval** - Solicitar aprovação humana

### Filesystem Básico (4 tools)
10. **execute_command** - Executar comandos shell (git, npm, dotnet, etc)
11. **read_file** - Ler conteúdo de arquivos
12. **write_file** - Criar/editar arquivos (cria diretórios automaticamente)
13. **list_directory** - Listar arquivos e diretórios

### Ferramentas Avançadas (7 tools)
14. **grep_search** - Buscar padrões em arquivos (regex, filtros por tipo)
15. **edit_file** - Editar arquivos cirurgicamente (replace específico, mais seguro)
16. **web_fetch** - Buscar conteúdo de URLs (documentação, APIs, web pages)
17. **glob** - Encontrar arquivos por padrão glob (`**/*.ts`, `src/**/*.cs`)
18. **git_diff** - Ver mudanças git (staged ou unstaged)
19. **move_file** - Mover/renomear arquivos e diretórios
20. **delete_file** - Deletar arquivos e diretórios

### Ferramentas Profissionais (10 tools)
21. **tail_log** - Ler últimas N linhas de arquivo (logs, output)
22. **kill_process** - Matar processo por PID (dev servers travados)
23. **list_processes** - Listar processos rodando (com filtro)
24. **get_env** - Ler variáveis de ambiente
25. **test_port** - Testar se porta está aberta (verificar serviços)
26. **find_todos** - Encontrar TODO/FIXME/HACK/XXX no código
27. **count_lines** - Contar linhas de código (métricas)
28. **diff_files** - Comparar dois arquivos lado a lado

Com essas ferramentas, os agentes podem:
- ✅ Criar e editar código
- ✅ Buscar código antes de editar (grep, glob)
- ✅ Fazer edições cirúrgicas seguras (edit_file)
- ✅ Executar builds e testes
- ✅ Fazer commits git e ver diffs
- ✅ Instalar pacotes (npm, dotnet, pip, etc)
- ✅ Ler documentação online
- ✅ Gerenciar issues e delegação de trabalho
- ✅ Organizar arquivos (mover, deletar)
- ✅ Monitorar logs em tempo real (tail_log)
- ✅ Gerenciar processos (kill, list)
- ✅ Verificar configuração (env vars, portas)
- ✅ Code review (find_todos, count_lines, diff)
- ✅ Debugging avançado (processos, portas, logs)

## �📋 Modelos Disponíveis

### Gratuitos (Free Tier)
- `openrouter/auto` - Auto-routing (melhor modelo gratuito)
- `meta-llama/llama-4-maverick:free`
- `google/gemma-3-27b-it:free`
- `deepseek/deepseek-chat-v3-0324:free`
- E outros...

### Pagos (Frontier)
- `anthropic/claude-sonnet-4-6`
- `anthropic/claude-opus-4-6`
- `openai/gpt-4.1`
- `google/gemini-2.5-pro-preview`
- E muitos outros...

## 🔍 Verificação

Para verificar se o adapter foi carregado corretamente:

1. Inicie o servidor com `pnpm dev`
2. Procure no log de inicialização por:
   ```
   [paperclip] Loaded external adapters from plugin store
   ```
3. O adapter `openrouter` deve aparecer na lista

## 🛠️ Troubleshooting

### Adapter não aparece na UI

1. Verifique se o arquivo `~/.paperclip/adapter-plugins.json` existe e contém o registro
2. Certifique-se de que executou `pnpm install`
3. Reinicie completamente o servidor
4. Verifique os logs do servidor para erros de carregamento

### Erro ao carregar o adapter

1. Verifique se a função `createServerAdapter` existe em `packages/adapters/openrouter/src/index.ts`
2. Execute `pnpm typecheck` para verificar erros de TypeScript
3. Verifique os logs do servidor para detalhes do erro

### Re-registrar o adapter

Se precisar re-registrar o adapter:

```powershell
node scripts/register-openrouter-adapter.js
```

## 📚 Documentação Adicional

- README do adapter: `packages/adapters/openrouter/README.md`
- Documentação do OpenRouter: https://openrouter.ai/docs
- Guia de configuração: Veja `packages/adapters/openrouter/REGISTRY_PATCHES.md`

## 🔗 Links Úteis

- Repositório original: https://github.com/talhamahmood666/paperclip-adapter-openrouter
- OpenRouter Dashboard: https://openrouter.ai/
- Paperclip Docs: Veja `doc/` no repositório

## 💡 Notas

- O adapter usa o sistema de **plugins externos** do Paperclip
- Não é necessário modificar os arquivos de registro do core (`server/src/adapters/registry.ts`)
- O adapter é carregado dinamicamente na inicialização do servidor
- Suporta 300+ modelos de IA através de uma única API key
