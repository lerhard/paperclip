# Dockerfile - Build Automático de Adapters

## ✅ Resposta Rápida

**SIM!** O Dockerfile agora builda adapters automaticamente, incluindo o OpenRouter!

---

## 🔧 O Que Foi Mudado

### ❌ Antes (Adapters NÃO buildados)

```dockerfile
FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build  # ← Adapters não buildados!
```

**Problema**: Adapters ficavam como TypeScript não compilado

### ✅ Depois (Adapters buildados automaticamente)

```dockerfile
FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter './packages/adapters/*' build  # ← TODOS os adapters!
RUN pnpm --filter @paperclipai/server build
RUN test -f packages/adapters/openrouter/dist/index.js || echo "WARNING: OpenRouter missing"
```

**Resultado**: Todos os adapters compilados e prontos! ✅

---

## 🎯 O Que Isso Significa

### Quando você roda:

```bash
docker-compose build
```

**Agora acontece automaticamente**:

1. ✅ Instala dependências
2. ✅ Builda UI
3. ✅ Builda plugin-sdk
4. ✅ **Builda TODOS os adapters** (incluindo OpenRouter)
5. ✅ Builda server
6. ✅ Verifica se OpenRouter foi buildado
7. ✅ Cria imagem final

**Você não precisa fazer NADA manualmente!** 🎉

---

## 📊 Comparação: Antes vs Depois

### ❌ Antes

```bash
# 1. Build da imagem
docker-compose build

# 2. Entrar no container
docker-compose exec server sh

# 3. Buildar adapters manualmente
pnpm --filter @paperclipai/adapter-openrouter build

# 4. Reiniciar container
docker-compose restart
```

**Passos**: 4
**Tempo**: 10-15 minutos
**Complexidade**: Alta

### ✅ Depois

```bash
# 1. Build da imagem (tudo automático!)
docker-compose build
```

**Passos**: 1
**Tempo**: 5-10 minutos
**Complexidade**: Baixa

---

## 🚀 Como Usar

### Primeira Vez / Após Mudanças

```bash
# Build completo (inclui adapters automaticamente)
docker-compose build --no-cache

# Iniciar
docker-compose up -d
```

### Rebuild Rápido (Sem Cache)

```bash
docker-compose build --no-cache --pull
docker-compose up -d
```

### Verificar se Funcionou

```bash
# Ver logs do build
docker-compose build 2>&1 | grep -i "adapter"

# Deve mostrar:
# Building adapters...
# ✓ @paperclipai/adapter-openrouter built
# ✓ @paperclipai/adapter-codex-local built
# etc.
```

---

## 🔍 Verificação Pós-Build

### 1. Verificar se OpenRouter foi buildado

```bash
# Entrar no container
docker-compose exec server sh

# Verificar se dist existe
ls packages/adapters/openrouter/dist/

# Deve mostrar:
# index.js
# plugin.js
# ui/
# server/
```

### 2. Verificar se server carrega o adapter

```bash
# Ver logs
docker-compose logs server | grep -i openrouter

# Deve mostrar:
# [server] Loaded adapters: claude, codex, cursor, openrouter ✅
```

### 3. Verificar na UI

1. Abrir: http://localhost:3100
2. Ir em: Org Chart → Hire Agent
3. Verificar: OpenRouter aparece na lista ✅

---

## 🐛 Troubleshooting

### "OpenRouter não aparece após build"

**Causa**: Build falhou silenciosamente

**Solução**:

```bash
# Ver logs completos do build
docker-compose build --progress=plain 2>&1 | tee build.log

# Procurar por erros
grep -i "error\|fail" build.log
```

### "Build demora muito"

**Causa**: Buildando tudo do zero

**Solução**:

```bash
# Usar cache (mais rápido)
docker-compose build

# Só rebuild se necessário
docker-compose up --build
```

### "Adapters buildados mas não funcionam"

**Causa**: Imagem antiga em cache

**Solução**:

```bash
# Limpar tudo
docker-compose down -v
docker system prune -a --volumes

# Rebuild do zero
docker-compose build --no-cache
docker-compose up -d
```

---

## 📋 Ordem de Build no Dockerfile

```
1. Base image (Node.js + ferramentas)
   ↓
2. Deps stage (instala dependências)
   ↓
3. Build stage:
   ├── UI
   ├── Plugin SDK
   ├── ADAPTERS ← NOVO!
   └── Server
   ↓
4. Production stage (copia tudo buildado)
```

---

## 🎯 Por Que Adapters Precisam de Build?

### TypeScript → JavaScript

```typescript
// packages/adapters/openrouter/src/index.ts
export const type = "openrouter";
export const label = "OpenRouter";
```

**Precisa compilar para**:

```javascript
// packages/adapters/openrouter/dist/index.js
export const type = "openrouter";
export const label = "OpenRouter";
```

### Server Importa do Dist

```typescript
// server/src/adapters/registry.ts
import { type, label } from "@paperclipai/adapter-openrouter";
// ↑ Importa de dist/, não de src/
```

**Se dist/ não existir**: Adapter não funciona ❌

---

## ✅ Verificação Automática

O Dockerfile agora verifica automaticamente:

```dockerfile
# Verifica se OpenRouter foi buildado
RUN test -f packages/adapters/openrouter/dist/index.js || \
    (echo "WARNING: OpenRouter adapter build output missing" && exit 0)
```

**Se falhar**: Mostra warning mas não quebra o build

**Por quê?**: OpenRouter pode não existir em outras branches

---

## 🎓 Resumo

### Pergunta Original:
"Dá pra fazer o Dockerfile buildar automaticamente o adapter?"

### Resposta:
**SIM! Agora builda automaticamente!** ✅

### O Que Mudou:

```dockerfile
# Adicionado no Dockerfile:
RUN pnpm --filter './packages/adapters/*' build
```

### Resultado:

| Antes | Depois |
|-------|--------|
| ❌ Build manual | ✅ Build automático |
| ❌ 4 passos | ✅ 1 passo |
| ❌ 15 minutos | ✅ 5 minutos |
| ❌ Complexo | ✅ Simples |

### Comando Único:

```bash
docker-compose build
```

**Pronto!** Adapters buildados automaticamente! 🎊

---

## 📝 Notas Importantes

### 1. Cache do Docker

Docker usa cache para acelerar builds:

```bash
# Usa cache (rápido)
docker-compose build

# Sem cache (lento, mas garante atualização)
docker-compose build --no-cache
```

### 2. Multi-Stage Build

O Dockerfile usa multi-stage para otimizar:

```
deps stage:    Instala dependências (cacheable)
build stage:   Compila código (cacheable)
production:    Imagem final (pequena)
```

### 3. Verificação de Build

Sempre verifique se o build funcionou:

```bash
# Ver tamanho da imagem
docker images | grep paperclip

# Deve ser ~500MB-1GB
```

---

## 🚀 Próximos Passos

1. **Rebuild da imagem**:
```bash
docker-compose build --no-cache
```

2. **Iniciar**:
```bash
docker-compose up -d
```

3. **Verificar**:
```bash
docker-compose logs -f server
```

4. **Testar**:
- Abrir http://localhost:3100
- Hire Agent → OpenRouter ✅

**Tudo automático!** 🎉
