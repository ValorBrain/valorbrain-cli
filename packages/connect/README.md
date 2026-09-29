# @valorbrain/connect

Instalador do cliente para o ValorBrain hospedado: conecta um harness de CLI ao
MCP e grava os artefatos que o engine mandar (o engine é a fonte única — mudou o
contrato no servidor, o próximo run instala).

```bash
npx @valorbrain/connect --token vbm_xxx                  # detecta e conecta tudo
npx @valorbrain/connect --token vbm_xxx --harness kiro    # um harness
npx @valorbrain/connect --token vbm_xxx --dry-run         # mostra o plano
npx @valorbrain/connect --status                          # o que está instalado
npx @valorbrain/connect --token vbm_xxx --remove          # desfaz
```

## Harnesses

`claude-code`, `kiro`, `opencode`, `codex`, `grok`, `gemini-cli`, `cursor`,
`omp` e `hermes`.

Para cada um, o instalador escreve:

- **MCP server entry** no config do harness (o cliente recebe as tools);
- **instruções/regras** no arquivo que o harness lê (bloco gerenciado, sem
  sobrescrever o arquivo do cliente);
- **hooks** quando o harness tem sistema de hook com caminho hospedado.

### Hooks (protocolo v2, ADR-058)

Desde a 0.5.0 os hooks cobrem três momentos. Nenhum deles roda LLM do
ValorBrain nem envia transcript:

| momento | o que faz |
|---|---|
| `session-start` | contexto da sessão (`POST /api/v1/hooks/cue`) |
| `prompt` | contexto do prompt (mesmo endpoint) |
| `stop` | a cada alguns turnos, um **checkpoint de memória** |

O checkpoint chega pelo mecanismo de continuação do próprio harness:

| harness | mecanismo |
|---|---|
| Claude, Codex, Kiro, Grok | `decision:block` |
| Gemini | `deny` |
| Cursor | `followup_message` |

O modelo do harness revisa o trabalho e grava via MCP o que for durável, ou
não grava nada.

- **Credencial fora da linha de comando.** O instalador grava
  `~/.valorbrain/connect.json` (0600), e o hook lê de lá. O token não aparece
  em `ps`, em `/hooks` nem nos logs do harness.
- **Dialeto pelo payload.** O Grok carrega `~/.cursor/hooks.json` e o Cursor
  carrega o `~/.claude/settings.json`. Por isso o cliente identifica quem
  chamou pelos campos do evento, não pelo arquivo.
- **Sem loop.** O cliente respeita `stop_hook_active` / `stopHookActive`. Onde
  não existe flag (Kiro, Cursor), uma marca `awaiting` própria cobre o caso.
  Os limites padrão são intervalo mínimo de 10 min, 3 turnos (ou 8 min de
  trabalho) e no máximo 6 checkpoints por sessão, e a política vem do servidor.
- **Engine antigo.** Se o engine não tem `/api/v1/hooks/cue`, o contexto vem
  de `memory_prepare` e o checkpoint usa o texto embutido.
- **Migração automática.** Um hook v1 (com `--token=`) rodando a 0.5 grava o
  `connect.json` e reescreve os hooks para v2 no próximo self-heal.

Estado local por sessão em `~/.valorbrain/state/hooks/` (apagado após 7 dias).
Para desligar o checkpoint numa máquina, defina `VALORBRAIN_CHECKPOINT=off` no
ambiente do harness. A mesma variável no engine desliga para todos.

```bash
npm test   # node --test, sem dependências além do yaml
```

### Hermes

O Hermes recebe três coisas:

1. `mcp_servers.valorbrain` + `memory.provider: valorbrain` em
   `~/.hermes/config.yaml` (merge por chave — o resto do arquivo, incluindo
   comentários, é preservado);
2. `env.VALORBRAIN_ENGINE_URL` + `env.VALORBRAIN_API_TOKEN` no mesmo arquivo,
   para o MemoryProvider funcionar sem binário local: tools, registro/declaração
   **e os hooks de ciclo de vida** (bootstrap, contexto por turno e extração de
   Stop/PreCompact rodam no engine via `POST /api/v1/hooks/run`; só injeção
   local — postcompact/pretool/curator — não tem equivalente hospedado);
3. o plugin MemoryProvider em `~/.hermes/plugins/valorbrain/__init__.py`.

Depois, ative o provider:

```bash
hermes memory setup   # escolha valorbrain
# ou: memory.provider: valorbrain em ~/.hermes/config.yaml
```

O plugin declara a versão do contrato no engine — é o que faz o harness aparecer
identificado (com data de adoção) na cobertura do dashboard.

## MCP client (stdio)

Para clientes que falam MCP via stdio em vez de config de arquivo:

```json
{
  "mcpServers": {
    "valorbrain": {
      "command": "npx",
      "args": ["-y", "@valorbrain/connect", "--token", "vbm_…"]
    }
  }
}
```

## Requisitos

Node 18+. Uma dependência (`yaml`) para mesclar o config do Hermes com
segurança.
