# Como Instalar OpenRouter Adapter Localmente

## 🎯 Problema

Instalou o Paperclip localmente mas o adapter OpenRouter não aparece na lista.

## ✅ Solução

O OpenRouter adapter está em desenvolvimento na branch `feat/openrouter-adapter` e precisa ser registrado manualmente.

### Passo 1: Verificar se o Adapter Existe

```bash
# Navegar para o projeto
cd c:\Users\Léon\Documents\paperclip

# Verificar se a pasta existe
ls packages\adapters\openrouter
```

Se a pasta **NÃO existir**, você está na branch errada.

### Passo 2: Mudar para a Branch Correta

```bash
# Verificar branch atual
git branch

# Se não estiver em feat/openrouter-adapter, mudar:
git checkout feat/openrouter-adapter

# Atualizar
git pull origin feat/openrouter-adapter
```

### Passo 3: Instalar Dependências

```bash
# Instalar todas as dependências
pnpm install

# Build do adapter OpenRouter
pnpm --filter @paperclipai/adapter-openrouter build
```

### Passo 4: Registrar o Adapter

O OpenRouter adapter precisa ser registrado no sistema. Existem 2 formas:

#### Opção A: Via Plugin System (Recomendado)

1. **Criar arquivo de configuração de plugins**:

```bash
# Windows (PowerShell)
mkdir $env:USERPROFILE\.paperclip -Force
New-Item -Path "$env:USERPROFILE\.paperclip\adapter-plugins.json" -ItemType File -Force
```

2. **Editar** `~/.paperclip/adapter-plugins.json`:

```json
{
  "adapters": [
    {
      "name": "openrouter",
      "path": "C:\\Users\\SEU_USUARIO\\Documents\\paperclip\\packages\\adapters\\openrouter"
    }
  ]
}
```

**Importante**: Substitua `SEU_USUARIO` pelo seu nome de usuário do Windows!

3. **Reiniciar o servidor**:

```bash
# Ctrl+C para parar
pnpm dev
```

#### Opção B: Registrar Diretamente no Código

Se a Opção A não funcionar, você pode registrar diretamente:

1. **Abrir**: `server/src/adapters/registry.ts`

2. **Adicionar import**:

```typescript
import { createServerAdapter as createOpenRouterAdapter } from "@paperclipai/adapter-openrouter/plugin";
```

3. **Registrar no array de adapters**:

```typescript
const adapters = [
  // ... outros adapters
  {
    type: "openrouter",
    label: "OpenRouter",
    ...createOpenRouterAdapter(),
  },
];
```

4. **Rebuild e reiniciar**:

```bash
pnpm build
pnpm dev
```

### Passo 5: Verificar se Funcionou

1. **Abrir**: http://localhost:3100
2. **Ir em**: `Org Chart → Hire Agent`
3. **Verificar**: Se "OpenRouter" aparece na lista de Adapter Types

Se aparecer: **✅ Sucesso!**

---

## 🐛 Troubleshooting

### "OpenRouter ainda não aparece"

**Causa**: Build não foi feito ou registro falhou

**Solução**:
```bash
# Limpar tudo
rm -rf packages/adapters/openrouter/dist
rm -rf packages/adapters/openrouter/node_modules

# Reinstalar e rebuild
pnpm install
pnpm --filter @paperclipai/adapter-openrouter build

# Verificar se dist foi criado
ls packages/adapters/openrouter/dist
```

### "Erro ao buildar"

**Causa**: Dependências faltando

**Solução**:
```bash
# Limpar node_modules global
rm -rf node_modules
rm -rf packages/*/node_modules

# Reinstalar tudo
pnpm install
pnpm build
```

### "Adapter aparece mas dá erro ao criar agente"

**Causa**: API key não configurada

**Solução**:

1. Criar `.env` na raiz do projeto:
```bash
OPENROUTER_API_KEY=sk-or-v1-sua-chave-aqui
PAPERCLIP_AGENT_JWT_SECRET=seu-jwt-secret
```

2. Reiniciar servidor

### "Como gerar JWT Secret?"

```bash
# PowerShell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 📋 Checklist Completo

- [ ] Está na branch `feat/openrouter-adapter`
- [ ] Rodou `pnpm install`
- [ ] Rodou `pnpm --filter @paperclipai/adapter-openrouter build`
- [ ] Pasta `packages/adapters/openrouter/dist` existe
- [ ] Registrou o adapter (Opção A ou B)
- [ ] Criou arquivo `.env` com `OPENROUTER_API_KEY`
- [ ] Reiniciou o servidor (`pnpm dev`)
- [ ] OpenRouter aparece em "Hire Agent"

---

## 🚀 Atalho Rápido (Tudo de Uma Vez)

```bash
# 1. Ir para o projeto
cd c:\Users\Léon\Documents\paperclip

# 2. Mudar para branch correta
git checkout feat/openrouter-adapter
git pull

# 3. Instalar e buildar
pnpm install
pnpm --filter @paperclipai/adapter-openrouter build

# 4. Criar .env (se não existir)
echo "OPENROUTER_API_KEY=sk-or-v1-sua-chave" > .env
echo "PAPERCLIP_AGENT_JWT_SECRET=$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))')" >> .env

# 5. Iniciar
pnpm dev
```

Depois disso, o OpenRouter deve aparecer!

---

## 📞 Se Ainda Não Funcionar

1. **Verificar logs** no terminal onde rodou `pnpm dev`
2. **Procurar por erros** relacionados a "openrouter"
3. **Verificar** se a porta 3100 está livre:
```bash
npx kill-port 3100
```

4. **Tentar porta diferente**:
```bash
PORT=3101 pnpm dev
```

---

## ✅ Confirmação Final

Quando tudo estiver funcionando, você verá:

1. **No terminal**:
```
[server] API listening on http://localhost:3100
[server] Loaded adapters: claude, codex, cursor, openrouter
```

2. **Na UI** (http://localhost:3100):
- Org Chart → Hire Agent
- Adapter Type: **OpenRouter** ✅

3. **Ao criar agente**:
- Lista de modelos carrega
- Mostra modelos com `[FREE]` badge
- Agente funciona normalmente

**Pronto!** 🎉
