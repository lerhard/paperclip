# OpenRouter Adapter - Setup para Docker/Container

## 🐳 Usando OpenRouter com Docker

Se você está rodando o Paperclip via **Docker** ou **container**, siga este guia.

---

## 🎯 Opção 1: Rebuild da Imagem Docker (Recomendado)

### Passo 1: Verificar se Está na Branch Correta

```bash
git branch
# Deve mostrar: * feat/openrouter-adapter

# Se não estiver:
git checkout feat/openrouter-adapter
git pull origin feat/openrouter-adapter
```

### Passo 2: Rebuild da Imagem Docker

```bash
# Parar containers existentes
docker-compose down

# Rebuild da imagem (força rebuild sem cache)
docker-compose build --no-cache

# OU se usar docker build direto:
docker build --no-cache -t paperclip:latest .
```

### Passo 3: Configurar Variáveis de Ambiente

Editar `.env` ou `docker-compose.yml`:

```bash
# .env
OPENROUTER_API_KEY=sk-or-v1-sua-chave-aqui
OPENROUTER_API_KEY_2=sk-or-v1-chave-backup-1
OPENROUTER_API_KEY_3=sk-or-v1-chave-backup-2
PAPERCLIP_AGENT_JWT_SECRET=seu-jwt-secret-aqui
```

**Gerar JWT Secret**:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Passo 4: Iniciar Containers

```bash
# Iniciar com rebuild
docker-compose up --build

# OU em background
docker-compose up -d --build
```

### Passo 5: Verificar Logs

```bash
# Ver logs do container
docker-compose logs -f server

# Procurar por:
# [server] Loaded adapters: claude, codex, cursor, openrouter ✅
```

### Passo 6: Acessar UI

```
http://localhost:3100
```

**Hard refresh**: `Ctrl + Shift + R`

---

## 🎯 Opção 2: Volume Mount (Desenvolvimento)

Se você quer **desenvolvimento rápido** sem rebuild constante:

### docker-compose.yml

```yaml
version: '3.8'

services:
  server:
    build: .
    ports:
      - "3100:3100"
    environment:
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
      - PAPERCLIP_AGENT_JWT_SECRET=${PAPERCLIP_AGENT_JWT_SECRET}
    volumes:
      # Mount do código fonte (hot reload)
      - ./packages/adapters/openrouter:/app/packages/adapters/openrouter
      - ./server:/app/server
      - ./ui:/app/ui
      # Excluir node_modules (usar do container)
      - /app/packages/adapters/openrouter/node_modules
      - /app/server/node_modules
      - /app/ui/node_modules
    command: pnpm dev
```

**Vantagem**: Mudanças no código refletem automaticamente (hot reload)

**Desvantagem**: Mais lento, precisa de node_modules sincronizados

---

## 🎯 Opção 3: Usar Imagem Pré-buildada

Se houver uma imagem Docker publicada:

### docker-compose.yml

```yaml
version: '3.8'

services:
  paperclip:
    image: ghcr.io/lerhard/paperclip:openrouter-latest
    ports:
      - "3100:3100"
    environment:
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
      - PAPERCLIP_AGENT_JWT_SECRET=${PAPERCLIP_AGENT_JWT_SECRET}
    env_file:
      - .env
```

```bash
# Pull da imagem
docker-compose pull

# Iniciar
docker-compose up -d
```

---

## 📋 Dockerfile Otimizado

Se você precisar criar/modificar o Dockerfile:

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Instalar pnpm
RUN npm install -g pnpm

# Copiar package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/adapters/openrouter/package.json ./packages/adapters/openrouter/
COPY packages/adapters/adapter-utils/package.json ./packages/adapters/adapter-utils/
COPY server/package.json ./server/
COPY ui/package.json ./ui/

# Instalar dependências
RUN pnpm install --frozen-lockfile

# Copiar código fonte
COPY . .

# Build do OpenRouter adapter
RUN pnpm --filter @paperclipai/adapter-openrouter build

# Build do server (se não tiver erros)
RUN pnpm --filter @paperclipai/server build || echo "Server build failed, using dev mode"

# Build da UI
RUN pnpm --filter @paperclipai/ui build

# Expor porta
EXPOSE 3100

# Comando de inicialização
CMD ["pnpm", "dev"]
```

**Build**:
```bash
docker build -t paperclip-openrouter:latest .
```

---

## 🔧 Configuração dos Campos na UI (Container)

Após o container estar rodando:

### 1. Acessar UI

```
http://localhost:3100
```

### 2. Hard Refresh

`Ctrl + Shift + R` (limpar cache)

### 3. Criar Agente

- `Org Chart → Hire Agent`
- `Adapter Type: OpenRouter`
- **Rolar até o final** para ver "Token Optimization"

### 4. Configurar Compressão

**Básico (40% economia)**:
- Max Context Messages: `12`
- Compress Tool Results: `ON`

**Avançado (60% economia)**:
- Max Context Messages: `8`
- Compress Tool Results: `ON`
- Use RTK: `ON`

**Máximo (85% economia)**:
- Max Context Messages: `6`
- Max Turns: `10`
- Compress Tool Results: `ON`
- Use RTK: `ON`
- Use Caveman: `ON`

---

## 🐛 Troubleshooting Docker

### "OpenRouter não aparece na lista"

**Causa**: Imagem não foi rebuildada

**Solução**:
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### "Campos de Token Optimization não aparecem"

**Causa**: Cache do browser ou imagem antiga

**Solução**:
```bash
# 1. Rebuild forçado
docker-compose build --no-cache --pull

# 2. Reiniciar
docker-compose up -d

# 3. Hard refresh no browser
# Ctrl + Shift + R
```

### "Container não inicia"

**Causa**: Variáveis de ambiente faltando

**Solução**:

Verificar `.env`:
```bash
cat .env
```

Deve ter:
```
OPENROUTER_API_KEY=sk-or-v1-...
PAPERCLIP_AGENT_JWT_SECRET=...
```

### "Erro ao buildar imagem"

**Causa**: Dependências faltando ou erro de build

**Solução**:

Ver logs detalhados:
```bash
docker-compose build --progress=plain
```

Se server build falhar, usar modo dev no Dockerfile:
```dockerfile
CMD ["pnpm", "dev"]  # Ao invés de pnpm start
```

### "Porta 3100 já em uso"

**Solução**:

Mudar porta no `docker-compose.yml`:
```yaml
ports:
  - "3101:3100"  # Usar 3101 no host
```

Acessar: `http://localhost:3101`

---

## 📊 Verificação de Sucesso

### 1. Container está rodando

```bash
docker-compose ps
```

Deve mostrar:
```
NAME                COMMAND             STATUS
paperclip-server    "pnpm dev"          Up
```

### 2. Logs mostram adapter carregado

```bash
docker-compose logs server | grep -i openrouter
```

Deve mostrar:
```
[server] Loaded adapters: ... openrouter
```

### 3. UI mostra campos

- Abrir: http://localhost:3100
- Hire Agent → OpenRouter
- **Rolar até o final**
- Ver: "Token Optimization" com 5 campos

---

## 🚀 Comandos Úteis

### Rebuild completo

```bash
# Parar, limpar, rebuild, iniciar
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```

### Ver logs em tempo real

```bash
docker-compose logs -f
```

### Entrar no container

```bash
docker-compose exec server sh

# Dentro do container:
ls packages/adapters/openrouter/dist/ui/
cat packages/adapters/openrouter/dist/ui/build-config.js | grep maxContextMessages
```

### Rebuild apenas do adapter (dentro do container)

```bash
docker-compose exec server pnpm --filter @paperclipai/adapter-openrouter build
```

### Reiniciar apenas o server

```bash
docker-compose restart server
```

---

## 🎯 Resumo Rápido

### Para Produção (Imagem Final)

```bash
git checkout feat/openrouter-adapter
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Para Desenvolvimento (Hot Reload)

Use volume mounts no `docker-compose.yml` e:

```bash
docker-compose up
```

Mudanças no código refletem automaticamente.

---

## ✅ Checklist Docker

- [ ] Está na branch `feat/openrouter-adapter`
- [ ] Arquivo `.env` existe com API keys
- [ ] Rodou `docker-compose build --no-cache`
- [ ] Container iniciou sem erros
- [ ] Logs mostram "Loaded adapters: ... openrouter"
- [ ] UI abre em http://localhost:3100
- [ ] Fez hard refresh (Ctrl+Shift+R)
- [ ] OpenRouter aparece em Hire Agent
- [ ] Campos "Token Optimization" aparecem no final

---

## 📞 Se Nada Funcionar

### Opção Nuclear (Reset Total)

```bash
# Parar e remover TUDO
docker-compose down -v
docker system prune -a --volumes

# Rebuild do zero
git pull origin feat/openrouter-adapter
docker-compose build --no-cache --pull
docker-compose up -d

# Hard refresh no browser
# Ctrl + Shift + R
```

**Isso deve resolver 99% dos problemas!** 🚀
