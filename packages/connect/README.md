# @valorbrain/connect

Instalador do cliente para o ValorBrain hospedado: conecta um harness de CLI ao
MCP e grava os artefatos que o engine mandar (o engine é a fonte única — mudou o
contrato no servidor, o próximo run instala).

```bash
npx -y @valorbrain/connect@latest                            # detecta, autoriza no navegador, conecta tudo
npx -y @valorbrain/connect@latest --harness kiro             # um harness
npx -y @valorbrain/connect@latest --token vbm_xxx            # com um token que você já tem (sem navegador)
npx -y @valorbrain/connect@latest --token vbm_xxx --dry-run  # mostra o plano
npx -y @valorbrain/connect@latest --harness codex --mcp-only # só MCP + instruções, sem hooks
npx -y @valorbrain/connect@latest --status                   # o que está instalado (e o modo)
npx -y @valorbrain/connect@latest --token vbm_xxx --remove   # desfaz
npx -y @valorbrain/connect@latest --harness codex --prompt off       # não envia o prompt (só muda a escolha)
npx -y @valorbrain/connect@latest --harness gemini-cli --checkpoint off  # sem checkpoint (só muda a escolha)
```

Flag que esta versão não conhece não derruba a instalação: o connect avisa no
stderr (`warning: ignoring unknown flag(s): …`) e segue. Até a 0.8.1 ela era
ignorada em silêncio — `--mcp-only` na 0.8.1 fazia a instalação completa.

Sem Node.js instalado, o app serve um instalador de uma linha que confere o
Node 18+ antes (no Windows, oferece instalar a LTS com o winget):

```powershell
irm https://valorbrain.valor.digital/install.ps1 | iex      # Windows (PowerShell)
```

```bash
curl -fsSL https://valorbrain.valor.digital/install.sh | sh  # macOS e Linux
```

## De onde vem o token

Só tokens MCP (`vbm_…`) são aceitos; uma chave REST (`vb_agent_…`, `vb_…`)
em `--token` ou `VALORBRAIN_MCP_TOKEN` para o instalador com uma mensagem que
diz onde achar o token certo. A ordem:

1. `--token vbm_…`
2. `VALORBRAIN_MCP_TOKEN`
3. `VALORBRAIN_TOKEN` (depreciada, com aviso; só vale se for `vbm_` — qualquer
   outra coisa é a chave REST e é ignorada aqui)
4. o `mcp_token` que `npx -y @valorbrain/cli init --agent` gravou em
   `~/.valorbrain/config.json` — para os agentes que ainda não têm token próprio
   neste computador (os já conectados mantêm o seu; `--relogin` troca todos)
5. sem nada disso, o login pelo navegador (abaixo)

## Onde o instalador escreve

Os caminhos vêm do manifesto do servidor e só podem cair dentro da sua home ou
do projeto atual (`--scope workspace`). Caminho com `..` ou absoluto fora dessas
duas raízes é recusado e aparece como erro no plano — nada é escrito nele.

## Manifesto assinado (0.8)

Antes de escrever qualquer arquivo — instalação, `--remove`, `--status` e o
self-heal — o connect confere a assinatura ed25519 do manifesto de
`/setup/artifacts` com a chave pública embutida em `manifest-signature.mjs`.
Manifesto sem assinatura, assinado por outra chave, alterado depois de assinado,
de outro harness ou com data a mais de 7 dias do relógio da máquina é recusado
e nada é escrito. A mesma chave pública está em
`https://valorbrain-api.valor.digital/setup/manifest-keys`.

Engine próprio (self-hosted): gere a chave do engine
(`VALORBRAIN_MANIFEST_SIGNING_KEY_FILE`, ver `docs/guides/harness-integration.md`
no engine) e confie nela aqui com
`VALORBRAIN_MANIFEST_PUBLIC_KEYS=<chave pública em base64>` (várias, separadas
por vírgula). Não há como desligar a verificação.

## Só MCP, sem hooks (0.9)

`--mcp-only` grava a entrada do servidor MCP e o bloco de instruções (texto
local), e nenhum hook: nada é enviado a cada turno; o agente chega à memória
pelas ferramentas MCP quando decide usá-las.

- Num harness que já tinha hooks, `--mcp-only` tira as nossas entradas (as de
  outras ferramentas no mesmo arquivo ficam). Hook que você editou à mão segue
  a regra de [arquivo editado à mão](#arquivo-editado-à-mão): sem ninguém no
  terminal ele fica — e continua enviando; o instalador diz isso e o `--status`
  também. `--mcp-only --force` tira.
- O modo fica em `~/.valorbrain/connect.json` (`mode: "mcp-only"` na entrada
  do harness, junto com o token, que nenhum hook lê) e aparece em `--status`
  (`mode: mcp-only …` / `mode: hooks`).
- Rodar de novo **sem** `--mcp-only` instala os hooks e apaga o registro do
  modo. O self-heal nunca traz hooks de volta sozinho — sem hooks ele nem roda,
  então o bloco de instruções só se atualiza quando você roda o instalador.
- Harness sem hooks no manifesto (OMP, Hermes): a flag não muda nada. O plugin
  de memória do Hermes continua instalado e envia o prompt de cada turno; ali o
  que desliga isso é `--prompt off`.
- `--remove` vence `--mcp-only`.
- Também aceita `--mcp-only=true|1|yes|on` (e `=false|0|no|off`, instalação
  normal); outro valor sai com código 2 — nunca vira instalação completa.
- Junto com `--prompt`, `--transcript` ou `--checkpoint`, que só gravam a
  escolha e saem, o `--mcp-only` não é aplicado: o connect avisa no stderr e
  você roda a instalação com `--mcp-only` separada.

## Arquivo editado à mão

O connect lembra o que escreveu em cada arquivo que gerencia
(`~/.valorbrain/connect-state.json`, campo `written`: o hash do bloco
`valorbrain`, das nossas entradas de hook ou do arquivo inteiro quando ele é
nosso). Se você mudou essa parte:

- o **self-heal** (rodado pelos hooks) não regrava: escreve uma linha no stderr
  e em `~/.valorbrain/connect.log` e deixa o arquivo como está;
- **rodar o instalador** mostra o diff e pergunta antes de sobrescrever; sem
  ninguém no terminal (CI, saída em pipe) mantém a sua versão. `--force`
  sobrescreve sem perguntar.

Instalações anteriores à 0.8 não têm registro: a primeira escrita da 0.8
registra o estado e daí em diante a proteção vale.

## Saindo dos hooks self-hosted (0.10)

Numa máquina que rodava os hooks do engine local (`valorbrain hook …`,
`/usr/local/libexec/valorbrain-hook-env hook …`, `vbhook …`, `clawmem hook …`),
a **instalação explícita** troca esses hooks pelos hospedados, nos mesmos
arquivos que ela escreve:

- O plano lista o que sai, por exemplo
  `replaces 8 self-hosted ValorBrain hook(s): context-surfacing, …`, e o
  `--dry-run` mostra a mesma lista sem escrever nada. A cópia
  `.valorbrain-bak` permite desfazer.
- Hooks de terceiros no mesmo arquivo (rtk, codedb, herdr…) ficam, mesmo
  quando dividem o grupo com um hook self-hosted.
- No Kiro, o `~/.kiro/hooks/valorbrain.json` self-hosted é substituído inteiro.
  Com `--kiro-engine=legacy`, ele é apagado (com backup) ao lado do agent
  config, para não virar um segundo loader.
- Entradas nossas editadas à mão seguem a regra de edição manual: sem
  confirmação, o arquivo inteiro fica como está.

O **self-heal nunca remove hooks self-hosted**. Se ele encontra hooks
hospedados e self-hosted no mesmo arquivo, escreve uma linha por heal em
`~/.valorbrain/connect.log` com os nomes e o comando que resolve
(`npx -y @valorbrain/connect --harness <id>`). Um arquivo de hooks só
self-hosted não é tocado pelo heal nem apagado por `--remove`/`--mcp-only`.

## O que sai da sua máquina

Página completa, por harness: <https://docs.valorbrain.com.br/docs/concepts/what-leaves-your-machine>.

- **Prompt de cada turno** (até 8.000 caracteres, para buscar memória
  relevante): ligado por padrão. Desliga por harness com
  `npx -y @valorbrain/connect --harness <id> --prompt off` (grava
  `send_prompt: false` na entrada do harness em `~/.valorbrain/connect.json`;
  `--prompt on` volta), ou na máquina inteira com `VALORBRAIN_SEND_PROMPT=off` no
  ambiente do harness. Desligado, o hook do prompt não faz chamada nenhuma; o
  contexto de início de sessão e o checkpoint continuam.
- **Checkpoint de memória** (o hook de Stop, a cada poucos turnos, pede ao
  agente um registro curto pelo MCP): ligado por padrão. Desliga por harness com
  `npx -y @valorbrain/connect --harness <id> --checkpoint off` (grava
  `checkpoint: false` na entrada do harness; `--checkpoint on` volta), ou na
  máquina inteira com `VALORBRAIN_CHECKPOINT=off` — que vence o arquivo nos dois
  sentidos (`VALORBRAIN_CHECKPOINT=on` religa). No Gemini CLI, que roda os hooks
  sem o ambiente, só o arquivo vale.
- **Transcript da sessão**: só com opt-in, desligado por padrão. Liga por
  harness com `npx -y @valorbrain/connect --harness <id> --transcript on`
  (grava `send_transcript: true`; `--transcript off` desliga), ou na máquina
  inteira com `VALORBRAIN_SEND_TRANSCRIPT=on|off`, que vence o arquivo nos dois
  sentidos.
  - **Hermes:** o plugin de memória envia o transcript aos hooks de extração.
  - **Claude Code e Grok:** o hook de Stop envia o arquivo de transcript da
    sessão para `/api/v1/hooks/run` (`episode-extractor`, que cria o documento
    da conversa e os episódios, e depois `decision-extractor`). A primeira vez
    é depois de 3 turnos concluídos; depois disso, só quando o arquivo cresceu
    e no máximo a cada 10 min por sessão. Turnos que só continuam um bloqueio
    (`stop_hook_active`) e sessões via SDK não enviam.
  - O envio roda em segundo plano e o hook não espera por ele. O limite é de
    8 MiB: um arquivo maior manda o final.
  - Falhas viram uma linha em `~/.valorbrain/connect.log`, nunca o conteúdo.
    Depois de 401/403/413 o envio pausa 6 h; depois de 429, 30 min.
  - **Codex e Gemini CLI** também informam um transcript, mas o engine ainda
    não lê esses formatos, então nada é enviado. **Kiro e Cursor** não
    informam transcript.
  - **Hooks de extração ligados à mão** (`decision-extractor`,
    `episode-extractor`, `handoff-generator`, `feedback-loop`,
    `precompact-extract`, `staleness-check` no comando do hook). Ligar um
    desses hooks já é o opt-in: com a chave sem valor, ele envia o transcript,
    como na 0.9. Um **off explícito** (`--transcript off` ou
    `VALORBRAIN_SEND_TRANSCRIPT=off`) vence: o transcript não é lido nem
    enviado, e os hooks que só leem o transcript nem são chamados. O
    `staleness-check` roda sem ele.

## Login pelo navegador (0.6)

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
ValorBrain nem envia transcript (exceto com `--transcript on`, acima):

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
Para desligar o checkpoint de um harness, `--checkpoint off` (fica em
`connect.json`; é o que vale no Gemini CLI, que roda os hooks sem o ambiente);
numa máquina inteira, `VALORBRAIN_CHECKPOINT=off` no ambiente do harness, que
vence o arquivo. A mesma variável no engine desliga para todos.

### Hooks que se atualizam sozinhos (0.11)

A partir da 0.11, todo hook roda o mesmo comando, para sempre:

```
node "/home/você/.valorbrain/bin/connect/launcher.mjs" hook prompt --harness=claude-code
```

Sem versão e sem `||` no comando: ele funciona em sh, cmd e nas duas
PowerShells, inclusive no Windows. Uma atualização nunca muda um arquivo de
configuração do harness, então o Codex não pede um novo trust e o Claude Code
não precisa recarregar hooks.

- **Como funciona.** O `launcher.mjs` lê `current.json`
  (`{version, integrity, data_scope, installed_at}`) e roda
  `./<versão>/hook.mjs` (no `heal`, roda o `index.mjs`). O launcher usa só
  módulos nativos do node.
  - Cada `<versão>/` é uma cópia completa do pacote e roda com node ou Bun, sem
    `npm install`. O `yaml` só é carregado quando a instalação mescla o config
    do Hermes.
  - Toda a cadeia, de `~/.valorbrain` até o arquivo que roda, precisa ser sua
    e não gravável por grupo nem por outros. Instalação e heal tiram essa
    permissão de escrita de `~/.valorbrain` e `bin/` e deixam `connect/` em
    0700. O launcher confere a cadeia de novo a cada execução e recusa, com
    uma linha no stderr, uma pasta que seja symlink, de outro usuário ou
    gravável por outros: num host com várias pessoas, ninguém troca
    `connect/` pelo seu.
  - **Windows:** lá não há uid nem bits de modo (as permissões são ACLs), então
    só os testes de tipo e de symlink rodam. A proteção vem das ACLs do perfil
    do usuário.
  - Se faltar `current.json` ou a pasta, ele escreve uma linha no stderr,
    devolve a resposta vazia do harness e sai com 0.
- **De onde vem uma versão.** O engine assina o manifesto
  (`client=launcher`) com a versão fixada, o tarball do npm e o sha512 dele.
  - O heal baixa o tarball, confere o sha512 antes de abrir qualquer coisa,
    descompacta numa pasta temporária (com um leitor de tar próprio, que nunca
    extrai link, caminho absoluto ou `..`) e renomeia para `<versão>/`. Por
    fim troca o `current.json` (tmp + rename) e, se a versão nova trouxer um
    `launcher.mjs` diferente, troca também o launcher, no mesmo caminho.
  - Sem npx em nenhum ponto. Nunca roda tag, faixa de versões, versão anterior
    à 0.11.0 nem nada cujo sha512 não confira.
- **Quando atualiza.** Sempre em segundo plano, sem atrasar o hook:
  - a cada 6 h (`lastHealAt` em `~/.valorbrain/connect-state.json`);
  - na hora, quando a resposta do engine (`client_pin`) diz que a versão
    fixada mudou. Isso acontece uma vez por versão nova, por harness.
- **Nunca coleta mais sem você.** Cada harness guarda em `connect.json` o
  `consented_scope`, o nível de coleta que você aceitou ao instalar.
  - Uma versão cujo `data_scope` passe disso não é aplicada: o heal escreve uma
    linha em `connect.log`, o `--status` mostra "update held" e o engine é
    avisado pelo cabeçalho `X-ValorBrain-Client-State: blocked-scope=<n>`.
  - Rodar o instalador de novo é como você aceita o nível novo.
- **Codex.** A troca para o comando do launcher é a última mudança de comando,
  e o heal não a faz sozinho: um comando novo exige confiar de novo em
  `/hooks`. Enquanto isso, o engine recebe `needs-reinstall`. Rode
  `npx -y @valorbrain/connect --harness codex` uma vez e confie no comando.
- **omp e Hermes.** A ponte do omp e o plugin do Hermes chamam
  `launcher.mjs heal --harness=omp|hermes`, que atualiza os arquivos deles
  pelo manifesto assinado, com as mesmas regras de edição manual. O plugin do
  Hermes não precisa de token para isso.
- **Quem é quem.** Toda chamada ao engine (cue, hooks/run, envio de
  transcript, registro do runtime) leva estes cabeçalhos:
  - `X-ValorBrain-Client: connect/<versão>`;
  - `X-ValorBrain-Harness`;
  - `X-ValorBrain-Install`, um id aleatório por harness, guardado em
    `connect.json` (`install_id`), sem hostname nem caminho.

  Assim o engine vê a versão que de fato roda, não só a declarada na
  instalação.
- **Vindo da 0.10.** O primeiro heal da 0.11 troca o comando dos hooks (uma
  vez) por todos os harnesses, menos o Codex, e grava `install_id` e
  `consented_scope: 1` em cada entrada de `connect.json`. Se a ponte do omp ou o
  plugin do Hermes já tinham um id próprio, ele é reaproveitado.
- **Limpeza.** Uma versão que nada roda é apagada 24 h depois. O `--remove`
  apaga o launcher quando nenhum harness o usa mais. O `--status` mostra o
  launcher, a versão que ele roda, a versão fixada e se há atualização retida.
- `VALORBRAIN_HOOK_CLIENT=npx` mantém o comando npx.

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
   **e os hooks de ciclo de vida** (bootstrap e contexto por turno rodam no
   engine via `POST /api/v1/hooks/run`; a extração de Stop/PreCompact precisa do
   transcript da sessão e só roda com `--transcript on`; só injeção local —
   postcompact/pretool/curator — não tem equivalente hospedado);
3. o plugin MemoryProvider em `~/.hermes/plugins/valorbrain/__init__.py`.

Depois, ative o provider:

```bash
hermes memory setup   # escolha valorbrain
# ou: memory.provider: valorbrain em ~/.hermes/config.yaml
```

O plugin declara a versão do contrato no engine — é o que faz o harness aparecer
identificado (com data de adoção) na cobertura do dashboard.

## MCP client (stdio)

Para clientes que falam MCP via stdio em vez de config de arquivo, o proxy é o
da CLI (`@valorbrain/connect` é o instalador; `valorbrain-connect mcp` só
repassa para ele). Usa o `mcp_token` salvo por `npx -y @valorbrain/cli init
--agent`, ou `VALORBRAIN_MCP_TOKEN` / `--token vbm_…`:

```json
{
  "mcpServers": {
    "valorbrain": {
      "command": "npx",
      "args": ["-y", "@valorbrain/cli", "mcp"]
    }
  }
}
```

## Requisitos

Node 18+. Uma dependência (`yaml`) para mesclar o config do Hermes com
segurança.
