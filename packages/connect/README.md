# @valorbrain/connect

Instalador do cliente para o ValorBrain hospedado: conecta um harness de CLI ao
MCP e grava os artefatos que o engine mandar (o engine é a fonte única — mudou o
contrato no servidor, o próximo run instala).

```bash
npx -y @valorbrain/connect@0.6                            # detecta, autoriza no navegador, conecta tudo
npx -y @valorbrain/connect@0.6 --harness kiro             # um harness
npx @valorbrain/connect --token vbm_xxx                   # com um token que você já tem (sem navegador)
npx @valorbrain/connect --token vbm_xxx --dry-run         # mostra o plano
npx @valorbrain/connect --status                          # o que está instalado
npx @valorbrain/connect --token vbm_xxx --remove          # desfaz
```

Sem Node.js instalado, o app serve um instalador de uma linha que confere o
Node 18+ antes (no Windows, oferece instalar a LTS com o winget):

```powershell
irm https://valorbrain.valor.digital/install.ps1 | iex      # Windows (PowerShell)
```

```bash
curl -fsSL https://valorbrain.valor.digital/install.sh | sh  # macOS e Linux
```

## Login pelo navegador (0.6)

A 0.6 sai com a dist-tag `next` (o `latest` segue na 0.5.2 até a promoção),
por isso os exemplos fixam `@0.6`.

Sem `--token`, o instalador faz o device flow (RFC 8628) com o app:

1. pede um código em `POST /api/v1/cli/device/code` com `client: "connect"`,
   os harnesses que encontrou e o nome do computador;
2. abre `https://valorbrain.valor.digital/cli/link?code=XXXX-XXXX` (no Windows
   `explorer.exe`, no macOS `open`, no Linux `xdg-open`; no WSL, o navegador do
   Windows). Em CI, por SSH sem display ou com `--no-browser`
   (`VALORBRAIN_NO_BROWSER=1`), só imprime o link;
3. a pessoa confere o código e autoriza. Quem ainda não tem conta cria no
   caminho e volta para a mesma página;
4. o app cria **um token MCP por harness**, atribuído àquele agente e
   revogável sozinho em Configurações → Tokens MCP, e entrega uma única vez em
   `POST /api/v1/cli/device/token`.

`--app URL` (ou `VALORBRAIN_APP_URL`) aponta para outro app (staging). O engine
de cada harness passa a ser o do app que autorizou, salvo `--api` ou
`VALORBRAIN_API_URL`.

## Harnesses

`claude-code`, `kiro`, `opencode`, `codex`, `grok`, `gemini-cli`, `cursor`,
`omp` e `hermes`.

Para cada um, o instalador escreve:

- **MCP server entry** no config do harness (o cliente recebe as tools);
- **instruções/regras** no arquivo que o harness lê (bloco gerenciado, sem
  sobrescrever o arquivo do cliente);
- **hooks** quando o harness tem sistema de hook com caminho hospedado.

### Kiro: um engine, um arquivo (VAL-224)

O kiro-cli carrega hooks de exatamente um lugar, conforme o engine da sessão —
nunca dos dois:

- **V3** (`kiro-cli --v3`; default do Kiro CLI 3.0) carrega o arquivo standalone
  `~/.kiro/hooks/valorbrain.json` — é o default do instalador, e os hooks
  disparam sem nenhuma configuração de agente (o log do engine registra
  `v2 hooks loaded N standalone hooks from .kiro/hooks/`).
- **Legado** (kiro-cli 2.x sem `--v3`) só dispara hooks do agent config
  (`--kiro-engine=legacy` grava `~/.kiro/agents/valorbrain.json`), e só quando
  a sessão roda o agente (`kiro-cli chat --agent valorbrain` ou
  `kiro-cli agent set-default valorbrain`).

Instalar um modo remove os arquivos do outro (só os nossos): com os dois
ativos, uma sessão V3 rodando o agente dispara cada evento duas vezes. O
self-heal mantém o modo instalado e nunca cria arquivo em diretório de
projeto — o cwd de um hook é o projeto do agente.

## Upgrade a partir da 0.5.1 (VAL-224)

Quem instalou com a 0.5.1 e usa o V3 (`kiro-cli --v3` / Kiro CLI 3.0) **sem
agente** não tem hook disparando — e o self-heal roda *dentro* do hook, então
não chega até essa pessoa. **Rode o instalador de novo**:

```bash
npx -y @valorbrain/connect@latest --token vbm_… --harness kiro
```

Isso instala o arquivo standalone em `~/.kiro/hooks/valorbrain.json` e remove
os agent configs da 0.5.1 (em `$HOME` e no projeto em que rodar).

**Onde houver disparo duplo** (standalone em `$HOME` + agent config da 0.5.1
em um projeto — cada evento sai 2x nas sessões V3 com `--agent valorbrain`),
rode o instalador **também dentro de cada projeto afetado**: a poda do modo é
por diretório.

## Notas de release 0.5.2

- **Opt-in legado é registro.** `--kiro-engine=legacy` grava
  `kiro_engine: "legacy"` na entrada do harness em
  `~/.valorbrain/connect.json` — é o único sinal de modo que o self-heal
  respeita (a 0.5.1 gravava agent config no diretório em que rodava —
  `kiroWantsWorkspace(null)` → cwd, o que cai em `$HOME` quando o install roda
  a partir de `~` — então a existência do arquivo nunca significou opt-in).
  O install v3 limpa o campo.
- **Depois que o install v3 poda o agent config do projeto** (verificado ao
  vivo, kiro-cli 2.20.1):
  - `kiro-cli agent list` não lista mais `valorbrain`;
  - `kiro-cli agent set-default valorbrain` → erro limpo: `No agent with name
    valorbrain found`;
  - `kiro-cli chat --agent valorbrain` → **não é falha dura**: aviso
    `agent "valorbrain" not found, using "kiro_default"` e segue com o
    default — os hooks continuam pelo standalone nas sessões V3.
- Quem precisa do agente de volta (engine legado, ou preferência pessoal):
  `npx -y @valorbrain/connect --token vbm_… --harness kiro
  --kiro-engine=legacy` (global) ou com `--scope=workspace` dentro do
  projeto — o install recria o agent config e registra o opt-in, e o heal
  passa a manter esse modo sem tocar no standalone de ninguém.

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

- **Credencial fora da linha de comando, uma por harness.** O instalador grava
  `~/.valorbrain/connect.json` (0600) com uma entrada por harness, e cada hook
  lê só a sua. Dois harnesses podem ser de tenants diferentes. O token não
  aparece em `ps`, em `/hooks` nem nos logs do harness, e os backups saem em
  0600.
- **Dialeto pelo payload.** O Grok carrega `~/.cursor/hooks.json` e o Cursor
  carrega o `~/.claude/settings.json`. Por isso o cliente identifica quem
  chamou pelos campos do evento, não pelo arquivo.
- **Sem loop e sem invadir automação.** O cliente respeita `stop_hook_active` /
  `stopHookActive`. Onde não existe flag (Kiro, Cursor), uma marca `awaiting`
  própria cobre o caso. Os limites padrão são intervalo mínimo de 10 min, 3
  turnos (ou 8 min de trabalho em pelo menos 2 turnos) e no máximo 6
  checkpoints por sessão, e a política vem do servidor. **Nunca há checkpoint
  no primeiro turno**, então `claude -p`, SDK e `codex exec` terminam com a
  saída deles. Claude Code via SDK nunca recebe checkpoint.
- **Engine antigo.** Se o engine não tem `/api/v1/hooks/cue`, o contexto vem
  de `memory_prepare` e o checkpoint usa o texto embutido.
- **Migração automática.** Um hook v1 (com `--token=`) rodando a 0.5 grava a
  entrada daquele harness e reescreve os hooks para v2 no próximo self-heal.
  Entrada existente com outro token não é sobrescrita, e token vindo de env não
  é persistido. O Codex não migra sozinho, porque comando novo exige re-trust
  em `/hooks`; basta reinstalar.

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
