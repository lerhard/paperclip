# Token Optimization Fields Not Showing in UI - Troubleshooting

## 🎯 Problema

Os campos de "Token Optimization" não aparecem na UI do Paperclip ao criar/editar agente OpenRouter.

## ✅ Solução Completa

### Passo 1: Rebuild do Adapter

```bash
# Navegar para o projeto
cd c:\Users\Léon\Documents\paperclip

# Rebuild do adapter OpenRouter
pnpm --filter @paperclipai/adapter-openrouter build
```

**Deve mostrar**:
```
> @paperclipai/adapter-openrouter@1.0.0 build
> tsc
```

**Sem erros!** ✅

### Passo 2: Verificar se Buildou Corretamente

```bash
# Verificar se os arquivos foram compilados
ls packages\adapters\openrouter\dist\ui\
```

**Deve mostrar**:
- `build-config.js` ✅
- `build-config.d.ts` ✅
- `index.js` ✅
- `parse-stdout.js` ✅

### Passo 3: Rebuild do Server (Importante!)

O server também precisa ser rebuildado para carregar as novas definições:

```bash
# Rebuild do server
pnpm --filter @paperclipai/server build
```

**OU rebuild completo**:

```bash
# Rebuild de tudo
pnpm build
```

### Passo 4: Reiniciar o Servidor

```bash
# Se o servidor estiver rodando, parar (Ctrl+C)
# Depois iniciar novamente:
pnpm dev
```

### Passo 5: Limpar Cache do Browser

**Importante!** O browser pode estar usando cache antigo:

1. **Chrome/Edge**: `Ctrl + Shift + R` (hard refresh)
2. **Firefox**: `Ctrl + F5`
3. **OU**: Abrir DevTools (F12) → Network → Disable cache

### Passo 6: Verificar na UI

1. Abrir: http://localhost:3100
2. Ir em: `Org Chart → Hire Agent`
3. Selecionar: `Adapter Type: OpenRouter`
4. **Rolar para baixo** até ver "Token Optimization"

---

## 🔍 Verificação Detalhada

### Verificar se o build-config.ts foi compilado:

```bash
# Ver conteúdo do arquivo compilado
cat packages\adapters\openrouter\dist\ui\build-config.js
```

**Deve conter**:
```javascript
// ... código ...
key: "maxContextMessages",
label: "Max Context Messages",
// ... código ...
key: "compressToolResults",
label: "Compress Tool Results",
// ... etc
```

### Verificar se o server carregou os campos:

No terminal onde rodou `pnpm dev`, procurar por:
```
[server] Loaded adapters: claude, codex, cursor, openrouter
```

---

## 🐛 Problemas Comuns

### 1. "Campos ainda não aparecem após rebuild"

**Causa**: Server não foi reiniciado

**Solução**:
```bash
# Parar servidor (Ctrl+C)
pnpm dev
```

### 2. "Erro ao buildar"

**Causa**: TypeScript encontrou erro

**Solução**:
```bash
# Ver erros detalhados
pnpm --filter @paperclipai/adapter-openrouter build --verbose

# Se houver erro de tipo, verificar:
cat packages\adapters\openrouter\src\ui\build-config.ts
```

### 3. "Build funciona mas UI não atualiza"

**Causa**: Cache do browser

**Solução**:
1. Abrir DevTools (F12)
2. Ir em Application → Storage → Clear site data
3. Recarregar página (Ctrl+Shift+R)

### 4. "Aparece erro 'configFields is not defined'"

**Causa**: Export não foi feito corretamente

**Solução**:
```bash
# Verificar exports
cat packages\adapters\openrouter\src\ui\index.ts
```

Deve ter:
```typescript
export { buildConfig, configFields } from "./build-config.js";
```

---

## 🚀 Atalho Rápido (Tudo de Uma Vez)

```bash
# 1. Rebuild adapter
pnpm --filter @paperclipai/adapter-openrouter build

# 2. Rebuild server
pnpm --filter @paperclipai/server build

# 3. Reiniciar
pnpm dev
```

Depois:
1. Hard refresh no browser (Ctrl+Shift+R)
2. Ir em Hire Agent → OpenRouter
3. Rolar até "Token Optimization"

---

## ✅ Como Saber se Funcionou

Você deve ver estes campos na UI:

```
┌─────────────────────────────────────┐
│ Token Optimization                  │
├─────────────────────────────────────┤
│                                     │
│ Max Turns                           │
│ [        25        ] ▼              │
│                                     │
│ Max Context Messages                │
│ [     unlimited    ] ▼              │
│                                     │
│ Compress Tool Results               │
│ [  OFF  ] ○────────                 │
│                                     │
│ Use RTK (Reduced Token Keys)        │
│ [  OFF  ] ○────────                 │
│                                     │
│ Use Caveman Compression             │
│ [  OFF  ] ○────────                 │
│                                     │
└─────────────────────────────────────┘
```

---

## 📋 Checklist Completo

- [ ] Rodou `pnpm --filter @paperclipai/adapter-openrouter build`
- [ ] Build completou sem erros
- [ ] Arquivo `dist/ui/build-config.js` existe
- [ ] Rodou `pnpm --filter @paperclipai/server build` (ou `pnpm build`)
- [ ] Reiniciou o servidor (`pnpm dev`)
- [ ] Fez hard refresh no browser (Ctrl+Shift+R)
- [ ] Limpou cache do browser
- [ ] Abriu Hire Agent → OpenRouter
- [ ] Rolou para baixo na página
- [ ] Campos de "Token Optimization" aparecem

---

## 🔧 Verificação Manual dos Arquivos

### 1. Verificar se build-config.ts tem os campos:

```bash
grep -n "maxContextMessages\|compressToolResults\|useRTK\|useCaveman" packages/adapters/openrouter/src/ui/build-config.ts
```

**Deve mostrar** várias linhas com esses campos.

### 2. Verificar se foi compilado:

```bash
grep -n "maxContextMessages\|compressToolResults" packages/adapters/openrouter/dist/ui/build-config.js
```

**Deve mostrar** as mesmas definições em JavaScript.

### 3. Verificar se o server carrega os campos:

```bash
# Iniciar server em modo debug
DEBUG=* pnpm dev
```

Procurar por logs relacionados a "configFields" ou "openrouter".

---

## 📞 Se Ainda Não Funcionar

### Opção 1: Rebuild Completo

```bash
# Limpar tudo
rm -rf packages/adapters/openrouter/dist
rm -rf packages/adapters/openrouter/node_modules
rm -rf server/dist
rm -rf server/node_modules

# Reinstalar
pnpm install

# Rebuild tudo
pnpm build

# Iniciar
pnpm dev
```

### Opção 2: Verificar Registro do Adapter

O adapter pode não estar registrado corretamente no server.

Verificar: `server/src/adapters/registry.ts`

Deve ter algo como:
```typescript
import { configFields as openrouterConfigFields } from "@paperclipai/adapter-openrouter/ui";

// ...

{
  type: "openrouter",
  configFields: openrouterConfigFields,
  // ...
}
```

### Opção 3: Verificar Versão do TypeScript

```bash
# Ver versão do TypeScript
npx tsc --version
```

Deve ser >= 5.0.0

---

## 🎯 Resumo

**Problema**: Campos não aparecem
**Causa**: Código não foi compilado ou server não recarregou
**Solução**: Rebuild + Reiniciar + Hard Refresh

**Comando único**:
```bash
pnpm --filter @paperclipai/adapter-openrouter build && pnpm --filter @paperclipai/server build && pnpm dev
```

Depois: **Ctrl+Shift+R** no browser! 🚀
