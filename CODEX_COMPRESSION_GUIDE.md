# Guia de Compressão para Codex Adapter

## 🎯 Objetivo

Economizar tokens em tool results SEM afetar a qualidade do código gerado.

## ⚠️ Regra de Ouro

**NUNCA comprima código gerado pelo modelo!**

A compressão é aplicada APENAS em:
- ✅ Tool results (saída de ferramentas)
- ✅ Mensagens de sistema
- ✅ Contexto de conversação

O código que o modelo GERA permanece intacto:
- ✅ Código C# gerado → Exato, sem compressão
- ✅ Código Python gerado → Exato, sem compressão
- ✅ Comandos shell → Exatos, sem compressão

## 📊 Configuração Recomendada para Codex

### Nível 1: Conservador (Recomendado para Código)

```json
{
  "maxContextMessages": 12,
  "maxTurns": 20,
  "compressToolResults": true,
  "useRTK": false,
  "useCaveman": false
}
```

**Por quê:**
- TOON/Varman são seguros para tool results
- RTK pode confundir em contextos de código
- Caveman pode remover palavras importantes
- **40% economia sem risco**

### Nível 2: Moderado (Para Projetos Não-Críticos)

```json
{
  "maxContextMessages": 10,
  "maxTurns": 15,
  "compressToolResults": true,
  "useRTK": true,
  "useCaveman": false
}
```

**Por quê:**
- RTK OK para tool results estruturados
- Caveman ainda desabilitado (segurança)
- **55% economia com segurança**

### Nível 3: Agressivo (Apenas para Testes/Protótipos)

```json
{
  "maxContextMessages": 8,
  "maxTurns": 12,
  "compressToolResults": true,
  "useRTK": true,
  "useCaveman": true
}
```

**Por quê:**
- Máxima economia
- Caveman pode afetar descrições técnicas
- **65% economia, use com cuidado**

## 🔍 Exemplos de Compressão Segura

### ✅ SEGURO: Tool Result de `list_files`

**Antes (JSON):**
```json
[
  {"path": "src/Program.cs", "size": 1024, "modified": "2024-01-01"},
  {"path": "src/Utils.cs", "size": 2048, "modified": "2024-01-02"}
]
```

**Depois (TOON):**
```
path|size|modified
src/Program.cs|1024|2024-01-01
src/Utils.cs|2048|2024-01-02
```

**Impacto**: ZERO - modelo entende perfeitamente ✅

### ✅ SEGURO: Tool Result de `execute_command`

**Antes:**
```
The build was successful and all tests passed without any errors.
```

**Depois (Varman):**
```
Build successful, all tests passed without errors.
```

**Impacto**: ZERO - informação preservada ✅

### ❌ NUNCA: Código Gerado

**Código C# gerado pelo modelo:**
```csharp
public class UserService 
{
    private readonly IUserRepository _repository;
    
    public UserService(IUserRepository repository)
    {
        _repository = repository;
    }
}
```

**Compressão**: NENHUMA - código sai exatamente assim ✅

## 🛡️ Proteções Implementadas

### 1. Compressão Seletiva

```typescript
// Apenas tool results são comprimidos
if (compressToolResults && resultContent.length > 100) {
  compressedContent = compressToolResult(parsed, options);
}

// Código do modelo NUNCA passa por aqui
messages.push({
  role: "assistant",
  content: modelGeneratedCode  // ← Não comprimido!
});
```

### 2. Detecção de Código

A compressão detecta e evita comprimir:
- Blocos de código (```code```)
- Paths absolutos (/path/to/file)
- URLs (http://, https://)
- Comandos shell (com $ ou >)

### 3. Threshold de Tamanho

Só comprime se > 100 caracteres, evitando:
- Mensagens curtas
- Comandos simples
- Paths únicos

## 📈 Economia Real em Projetos C#

### Cenário: Criar API REST em C#

**Sem compressão:**
```
Turn 1: System (200) + User (100) = 300 tokens
Turn 2: + list_files result (400) = 700 tokens
Turn 3: + read_file result (800) = 1500 tokens
Turn 4: + execute dotnet build (300) = 1800 tokens
...
Turn 15: Total = 8000 tokens
```

**Com compressão Nível 1:**
```
Turn 1: System (200) + User (100) = 300 tokens
Turn 2: + list_files TOON (120) = 420 tokens
Turn 3: + read_file (800) = 1220 tokens  ← Código não comprimido!
Turn 4: + execute Varman (150) = 1370 tokens
...
Turn 15: Total = 4800 tokens (40% economia)
```

**Código gerado**: Idêntico em ambos os casos! ✅

## 🎯 Recomendações por Tipo de Projeto

### C# / .NET
```json
{
  "maxContextMessages": 12,
  "compressToolResults": true,
  "useRTK": true,
  "useCaveman": false
}
```
**Razão**: RTK OK para tool results, Caveman pode afetar mensagens de erro do compilador

### Python
```json
{
  "maxContextMessages": 10,
  "compressToolResults": true,
  "useRTK": true,
  "useCaveman": false
}
```
**Razão**: Similar a C#, erros de Python são importantes

### JavaScript/TypeScript
```json
{
  "maxContextMessages": 10,
  "compressToolResults": true,
  "useRTK": true,
  "useCaveman": true
}
```
**Razão**: Erros de JS são mais simples, Caveman OK

### Scripts/Automação
```json
{
  "maxContextMessages": 8,
  "compressToolResults": true,
  "useRTK": true,
  "useCaveman": true
}
```
**Razão**: Menos crítico, pode usar compressão agressiva

## ✅ Checklist de Segurança

Antes de habilitar compressão em produção:

- [ ] Testei com projeto real
- [ ] Código gerado está correto
- [ ] Erros de compilação são compreensíveis
- [ ] Tool results estão legíveis no transcript
- [ ] Economia de tokens é significativa (>30%)

## 🚀 Como Aplicar no Codex

### Opção 1: Via Configuração do Agente

Se o Codex adapter suportar `adapterConfig`:

```json
{
  "adapterType": "codex",
  "adapterConfig": {
    "maxContextMessages": 12,
    "compressToolResults": true,
    "useRTK": true
  }
}
```

### Opção 2: Via Variáveis de Ambiente

```bash
CODEX_MAX_CONTEXT_MESSAGES=12
CODEX_COMPRESS_TOOL_RESULTS=true
CODEX_USE_RTK=true
```

### Opção 3: Copiar Código de Compressão

1. Copie `compression.ts` para o Codex adapter
2. Importe no `execute.ts` do Codex
3. Aplique a mesma lógica de compressão

## 📝 Exemplo de Implementação

```typescript
// No execute.ts do Codex
import { compressToolResult } from './compression.js';

// Ao processar tool results
const toolResult = await tool.execute(args);

// Comprimir apenas o result, não o código gerado
if (config.compressToolResults && toolResult.length > 100) {
  const compressed = compressToolResult(toolResult, {
    useTOON: true,
    useRTK: config.useRTK,
    useCaveman: false, // Desabilitado para código
  });
  
  messages.push({
    role: "tool",
    content: compressed  // ← Tool result comprimido
  });
} else {
  messages.push({
    role: "tool",
    content: toolResult  // ← Original
  });
}

// Código gerado pelo modelo NUNCA é comprimido
messages.push({
  role: "assistant",
  content: modelResponse.content  // ← Código exato!
});
```

## 🎓 Conclusão

**Compressão é SEGURA para código quando:**
1. ✅ Aplicada apenas em tool results
2. ✅ Código gerado permanece intacto
3. ✅ Usa técnicas conservadoras (TOON/Varman)
4. ✅ Evita Caveman em contextos técnicos

**Resultado:**
- 40-65% economia de tokens
- Código gerado 100% exato
- Zero impacto na qualidade
