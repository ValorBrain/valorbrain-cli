# Changelog — @valorbrain/connect

## 0.13.0 — 2026-10-16

- **Tipo de execução (ADR-084, D3).** Quando o harness diz que a sessão não é
  de uma pessoa, os hooks mandam `X-Run-Kind` no cue, no `hooks/run` e na
  chamada MCP de fallback, com o vocabulário do engine (`runKindFromSignals`):
  `routine` para Claude Code não assistido ou com entrypoint SDK/MCP, `omp -p`
  e `--mode json`, Hermes `cron`/`oneshot`/`batch`/`kanban`/`api`,
  `codex exec`, `gemini -p` ou CI, `kiro-cli --no-interactive` e
  `cursor-agent -p`; `pipeline` para sessão vinda de webhook. Sessão
  interativa, subagent, flush e tool não mandam nada. `VALORBRAIN_RUN_KIND`
  sempre vence. O engine tira `routine` e `pipeline` do feed dos outros
  agentes.
- **Persona e contrato do harness pelo env (D1).** `VALORBRAIN_SOURCE_AGENT`
  sai como `X-Source-Agent` (persona explícita, vence o harness declarado),
  `VALORBRAIN_AGENT_LANE` como `X-Agent-Lane`, `VALORBRAIN_REQUESTED_BY` (até
  120 caracteres) como `X-Requested-By` e `VALORBRAIN_AGENT_TEAM` como
  `X-Agent-Team`. Acentos viram ASCII; valor com caractere de controle não
  sai. São só rótulos: tenant, pessoa e autoridade continuam vindo do token.
- **Reinstalação preserva a persona da entrada MCP.** Um `X-Source-Agent` que
  a pessoa escreveu na entrada MCP (JSON) sobrevive ao `npx
  @valorbrain/connect`; o token, a URL e o `X-ValorBrain-Harness` vêm do
  manifesto.
- **Docs: o ambiente dos hooks do Gemini CLI.** O README, o `--help` e os
  comentários diziam que o Gemini CLI roda os hooks sem o ambiente. O Gemini
  CLI 0.43 passa o ambiente do processo e só filtra com
  `security.environmentVariableRedaction.enabled` (tira nomes de segredo, como
  `VALORBRAIN_TOKEN`) ou num runner do GitHub (só uma lista curta passa). Então
  `VALORBRAIN_SEND_PROMPT`, `VALORBRAIN_CHECKPOINT` e
  `VALORBRAIN_SEND_TRANSCRIPT` valem no Gemini, menos num runner do GitHub, onde
  também `CI` não chega ao hook. As chaves em `connect.json` valem sempre.
  Nenhuma mudança de comportamento.

## 0.12.1 — 2026-10-14

- **Repair of the hosted MCP auth in codex and grok.** connect ≤ 0.12.0
  wrote `[mcp_servers.valorbrain]` with `url` + `bearer_token`. codex-cli
  0.160.0 refuses the whole `~/.codex/config.toml` at startup with it
  ("bearer_token is not supported for streamable_http"; with a leftover
  `[mcp_servers.valorbrain.env]` also "env is not supported for
  streamable_http"), and grok 1.0.46 never reads the key (handshake "Auth
  required"). The table is rewritten to the key each harness reads, with the
  same token: codex `http_headers = { "Authorization" = "Bearer …" }`, grok
  `headers = { … }`, and a stale `env` subtable is dropped. Nothing else is
  touched: other keys, the codex `[mcp_servers.valorbrain.tools.*]` approvals,
  other servers, a self-hosted table (`command`). The file keeps its mode
  and a `.valorbrain-bak`; a symlinked config stays a symlink.
  - **Install** (`--harness codex|grok`): the repair runs after the merge, so
    an engine that still renders `bearer_token` lands the right shape.
  - **Heal** (the launcher's `heal`, the hook's detached heal): every heal
    repairs both files, whichever harness triggered it, before the manifest
    fetch — codex cannot start with the broken file, so its own hooks never
    fire. An install on 0.12.0 gets 0.12.1 through the pin; the first heal
    0.12.1 runs (at most the 6 h throttle later) repairs.
  - **mergeToml:** a hosted table written over a self-hosted one takes the
    self-hosted `env` subtable with it.
  - **`--status`:** the old shape is `drift`, with the command that fixes it.

## 0.12.0 — 2026-10-14

Publicar só depois do deploy dos leitores de transcript do engine (Codex,
Gemini, Kiro, Cursor): antes deles, o engine recebe esses arquivos e não
extrai nada.

- **Transcript no Stop para Codex, Gemini CLI, Kiro, Cursor e OpenCode.**
  Com `--transcript on`, o hook de Stop desses harnesses envia o transcript da
  sessão como já fazia o do Claude Code e do Grok: mesmas portas (turno
  concluído de verdade, sem continuação de bloqueio, 3 turnos antes do
  primeiro envio, no máximo a cada 10 min com crescimento, 8 envios por
  harness a cada 10 min).
  - **Codex:** o rollout do `transcript_path`. `codex exec` (também o SDK do
    Codex), `codex mcp-server`, clientes SDK do app-server e threads de
    sub-agente não enviam: o hook lê `source`, `thread_source` e
    `originator` da linha `session_meta`. Visto num `codex exec` real
    (codex-cli 0.160.0): o Stop dispara, e o de um sub-agente traz o
    `session_id` do pai com o rollout do filho.
  - **Gemini CLI:** o `transcript_path` do `AfterAgent`. Sessões de
    sub-agente (`kind: "subagent"`) não enviam, e o `AfterAgent` nem dispara
    para elas (0.43.0). `gemini -p`, pergunta na linha de comando e `CI=true`
    não enviam (a regra de headless do próprio Gemini).
  - **Kiro:** o Stop traz só `session_id` e `cwd`. O hook acha o arquivo em
    `~/.kiro/sessions/<sha256(cwd)[:16]>/<sess_…>/messages.jsonl` (Kiro CLI
    3.0/`--v3`) ou `~/.kiro/sessions/cli/<id>.jsonl` (motor legado). Não
    enviam: `kiro-cli chat --no-interactive` e, no legado, as sessões que um
    cliente ACP abriu (`session_created_reason: "subagent"`).
  - **Cursor:** o `transcript_path` (ou `CURSOR_TRANSCRIPT_PATH`), e quando o
    CLI não o manda, pelo `conversation_id` em
    `~/.cursor/projects/<workspace>/agent-transcripts/`. Só `.jsonl`. O
    `stop` só dispara para a conversa principal (sub-agente tem o
    `subagentStop`). `cursor-agent -p` não envia.
  - **OpenCode:** aceita o Stop do plugin hospedado
    (`hook stop --harness=opencode`, JSONL no formato do Claude Code). Só
    turnos com `status: "completed"`.
  - Gemini, Kiro e Cursor não dizem no payload que a execução é não
    interativa: o hook olha a linha de comando do processo do harness, com
    um `ps` (Linux, macOS). No Windows fica só o mínimo de 3 turnos.
  - Um Stop que chega pelo arquivo de hooks de outro harness (o Cursor roda
    o `settings.json` do Claude Code) só envia pelo arquivo do próprio
    harness.
  - Um transcript em JSON de arquivo único (Gemini CLI antigo) acima de
    8 MiB não é cortado e não é enviado.
  - `--transcript on` deixa de avisar "nothing is sent" para esses harnesses.
- **`sessionAttended` do Claude Code.** O Stop lê
  `CLAUDE_CODE_SESSION_ATTENDED`. Com `1`, o envio leva
  `input.sessionAttended: "1"` nas duas chamadas a `/api/v1/hooks/run`, e o
  engine só tira fatos dos turnos digitados por uma pessoa (FB-0205). Com `0`
  (`-p`/SDK, sessão em segundo plano, claude aberto por outro claude) o
  transcript não é enviado, como já era com o SDK. Sem a variável, nada muda.
  Os outros harnesses não têm um sinal equivalente; as execuções sem pessoa
  ficam de fora pelas regras acima.
- **Checkpoint no Claude Code sem "Stop hook error".** O checkpoint de memória
  saía como `{"decision":"block","reason"}`, que o Claude Code mostra como
  `Stop hook error: …` e com o aviso "Stop hook error occurred". Agora, no
  Claude Code, sai em `hookSpecificOutput.additionalContext` com
  `hookEventName` igual ao evento que rodou (`Stop` ou `SubagentStop`). O
  turno continua do mesmo jeito, com a mesma proteção de laço
  (`stop_hook_active`), e o texto aparece como `Stop hook feedback: …`.
  Codex, Kiro e Grok continuam com `decision:block`.
- **Claude Code mínimo para o checkpoint: 2.1.163.** É a primeira versão em
  que o `Stop` aceita `additionalContext` (CHANGELOG do Claude Code, 2.1.163).
  Numa versão anterior, a saída é descartada sem aviso e o checkpoint daquele
  turno se perde. Não há fallback para `decision:block`: o hook não recebe a
  versão do Claude Code, nem no payload nem no ambiente.

## 0.11.1 — 2026-10-14

Pequena, e também é a prova de que uma versão nova chega a todas as
instalações 0.11.0 sem ninguém mexer: só muda `~/.valorbrain/bin/connect/`.

- **Quebra de lock velho sem corrida.** Antes, dois heals que achavam o mesmo
  lock vencido podiam os dois apagar e recriar o lock, e cada um se achava o
  dono.
  - Agora o lock nasce de um hard link de um arquivo que já tem um token
    único. O lock vencido é quebrado com um rename atômico, conferindo que o
    arquivo movido é o mesmo que se viu vencido. Se não for, ele volta para o
    lugar e esse heal desiste.
  - Só quem tem o token solta o lock.
  - Em sistema de arquivos sem hard link (FAT/exFAT, alguns mounts de rede:
    `EPERM`, `ENOTSUP`, `EXDEV`), o lock é criado com `wx` e o token é relido
    para confirmar. As mesmas garantias valem.
- **`$HOME` gravável por todos.** No Linux e no macOS, a instalação (com a
  pessoa presente) recusa um `$HOME` de outro usuário ou gravável por todos
  (o+w sem sticky bit). Gravável pelo grupo (0775/2775) e sticky (1777) são
  aceitos. O connect nunca muda a permissão do `$HOME`.
  - **Uma atualização automática nunca silencia uma instalação que funciona.**
    O launcher só registra um problema no `$HOME` uma vez em `connect.log`,
    nunca recusa por isso. O heal mantém a versão em uso e só deixa de subir
    para uma versão nova enquanto o `$HOME` estiver gravável por todos (uma
    linha no log por versão). Testado com o 0.11.0 publicado instalando num
    `$HOME` 1777 e noutro 0777 e o heal do próprio 0.11.0 trocando para esta
    versão.
  - O launcher confere a pasta real que contém o `.valorbrain` (a partir do
    próprio caminho), não o `homedir()` do ambiente do hook.
  - Pastas com sticky bit não são recusadas pelos bits de escrita, em nenhum
    ponto da cadeia.
  - Um heal já na versão fixada não escreve nada e não checa diretórios.
- O GC apaga sobras `.lock-<v>.own-*` / `.break-*` de um heal que caiu, depois
  da janela de lock vencido.
- **Teste determinístico da corrida no `placeVersion`.** Uma barreira (só para
  teste) faz os dois heals passarem pela checagem "já instalado?" antes de
  qualquer um renomear. Com o lock, um só preenche e a primeira cópia nunca é
  apagada. O mesmo teste falha com o `placeVersion` sem lock da 1ea8d3c.

## 0.11.0 — 2026-10-14

- **Hooks que se atualizam sozinhos.** A instalação pede `client=launcher` e
  grava o mesmo comando em todo hook, para sempre:
  `node "~/.valorbrain/bin/connect/launcher.mjs" hook <evento> --harness=<id>`.
  - O comando não tem versão nem `||`, então funciona no Windows também
    (PowerShell 5.1, cmd).
  - O launcher (só módulos nativos) lê `current.json` e roda a `<versão>/`
    indicada ali, uma cópia completa do pacote que não precisa de
    `npm install`. O `yaml` passou a ser carregado só quando é preciso.
  - Se faltar o arquivo ou a pasta, o launcher escreve uma linha no stderr,
    devolve a resposta vazia e sai com 0.
  - O launcher confere toda a cadeia, de `~/.valorbrain` até o arquivo que
    roda, e recusa symlink, dono diferente ou permissão de escrita para
    grupo/outros. Instalação e heal tiram essa permissão de `~/.valorbrain` e
    `bin/` e deixam `connect/` em 0700. No Windows só valem as checagens de
    tipo e symlink (não há uid nem bits de modo).
- **Atualização sem npx e sem tocar no harness.**
  - O heal baixa o tarball que o manifesto assinado nomeia, confere o sha512
    assinado, descompacta com um leitor de tar próprio numa pasta temporária,
    renomeia e troca o `current.json` (e o `launcher.mjs`, se mudou).
  - O download é cortado em 10 MB: pelo Content-Length antes de ler e, sem
    ele, no meio do stream.
  - Um lock por versão impede que dois heals simultâneos apaguem o que o outro
    instalou. O `current.json` só aponta para uma pasta já completa.
  - Roda a cada 6 h e também na hora em que o engine responde com outro
    `client_pin`, uma vez por versão. Sempre em segundo plano.
  - Nunca roda tag, faixa de versões, versão < 0.11.0 nem sha512 diferente.
  - Os arquivos de configuração dos harnesses não mudam numa troca de versão.
  - O `heal-dispatch` e o `npx … heal` da 0.10 saíram.
- **Escopo de coleta.** Cada harness em `connect.json` ganha
  `consented_scope`. Um manifesto com `data_scope` maior fica retido até a
  pessoa rodar o instalador: o heal escreve uma linha em `connect.log`, grava
  `update_blocked` e o `--status` mostra o motivo.
- **Cabeçalhos em toda chamada ao engine** (cue, hooks/run, envio de
  transcript, `runtimes/register`):
  - `X-ValorBrain-Client: connect/<versão>`;
  - `X-ValorBrain-Harness`;
  - `X-ValorBrain-Install` (`install_id` aleatório por harness em
    `connect.json`);
  - `X-ValorBrain-Client-State` (`blocked-scope=<n>` ou `needs-reinstall`).
- **Migração da 0.10.** O primeiro heal da 0.11 troca o comando dos hooks uma
  vez para todos os harnesses, menos o Codex.
  - O Codex fica como está e informa `needs-reinstall`; quem migra o Codex é
    o instalador rodado por uma pessoa.
  - Toda entrada de `connect.json` ganha `install_id` e `consented_scope: 1`.
    Se a ponte do omp ou o plugin do Hermes já tinham um id, ele é
    reaproveitado.
- **omp e Hermes.** `launcher.mjs heal --harness=omp|hermes` atualiza a ponte
  `.ts` e os arquivos do plugin pelo manifesto assinado, com as regras de
  edição manual. O Hermes faz isso sem token.
- O heal nunca migra os hooks do Codex, nem com mudança de contrato.
- `--transcript on` no omp não diz mais "nothing is sent": a ponte envia.
- `--status` mostra o launcher, a versão em uso, a versão fixada e a
  atualização retida. `--remove` apaga o launcher quando nenhum harness o usa.

## 0.10.1 — 2026-10-14

- **Transcript opt-in no Claude Code e no Grok.** Com `--transcript on`
  (`send_transcript: true` em `connect.json`) ou `VALORBRAIN_SEND_TRANSCRIPT=on`,
  que vence o arquivo nos dois sentidos, o hook de Stop manda o transcript da
  sessão para `/api/v1/hooks/run`: `episode-extractor` (documento da conversa
  em `claude-transcripts` e episódios), depois `decision-extractor`. O padrão
  continua desligado; sem opt-in nada muda.
  - **Quando:** a primeira vez depois de 3 Stops concluídos na sessão. Depois
    disso, só quando o arquivo cresceu e já passaram 10 min desde o último
    envio. Stop que continua um bloqueio (`stop_hook_active`), sessão via SDK e
    o mesmo Stop entregue por dois arquivos não contam.
  - **Limite por harness:** 8 envios por 10 min (16 chamadas, contra o limite de
    40 do engine por token).
  - **Como:** o hook só decide, sob um lock por harness, e dispara
    `transcript-upload` em segundo plano; ele nunca espera o envio. O token não
    vai no argv.
  - **Tamanho:** até 8 MiB. Um arquivo maior manda o final, com as linhas
    cortadas do início trocadas por linhas vazias, para que o cursor de linhas
    do engine não se perca. Os hooks de extração legados também passaram a
    mandar o final, não mais o começo.
  - **Falhas:** uma linha em `connect.log`, sem conteúdo. 401/403/413 pausam o
    envio por 6 h; 429, por 30 min.
  - Codex e Gemini CLI informam um transcript em formatos que o engine não lê,
    e Kiro e Cursor não informam nenhum: nada é enviado por eles. O
    `--transcript on` nesses harnesses avisa isso.
  - **Hooks de extração ligados à mão:** um off explícito (`--transcript off`
    ou `VALORBRAIN_SEND_TRANSCRIPT=off`) agora vence. O transcript não é lido
    nem enviado, e os hooks que só leem o transcript não são chamados. Até a
    0.10.0 esses hooks enviavam o transcript mesmo com o off. Com a chave sem
    valor, eles continuam enviando como na 0.9, porque ligá-los à mão é o
    opt-in.

## 0.10.0 — 2026-10-14

- **Hooks sem npx a cada evento.** A instalação pede ao engine o manifesto
  `client=local` (`/setup/artifacts?…&hooks=2&client=local`), copia `hook.mjs`
  e `manifest-signature.mjs` para `~/.valorbrain/bin/connect/0.10.0/` (pasta
  0700, arquivos 0644, tmp + rename) e grava
  `node "<caminho>" hook <evento> --harness=<id> || npx -y @valorbrain/connect@<pin> hook …`.
  - Medido num servidor Linux: 650–700 ms por evento com npx aquecido, contra
    27–55 ms com o cliente local.
  - Se o arquivo faltar, o npx fixado atende o evento com o mesmo stdin.
  - Windows continua no npx por padrão (o Windows PowerShell 5.1 do Gemini CLI
    não aceita `||`). `VALORBRAIN_HOOK_CLIENT=local|npx` escolhe o modo.
  - Engine que não conhece `client=local`, ou que fixa outra versão, recebe os
    hooks npx como antes.
- **Self-heal fora do caminho do hook.** O cliente local nunca espera o heal.
  Quando ele vence (6 h), o cliente dispara em segundo plano um processo que
  confere a assinatura do manifesto e roda
  `npx -y @valorbrain/connect@<hook_client_version> heal --harness=<id>` (novo
  subcomando `heal`). Nunca roda versão que o manifesto assinado não fixa, nem
  versão anterior à 0.10.0. Pelo npx, o heal continua no processo, como antes.
  - Um hook npx da 0.10 cujo cliente local nunca foi tentado faz o heal no
    primeiro evento, uma vez por versão. É assim que uma instalação 0.9 sai do
    npx depois que o engine fixa a 0.10.
  - Um heal de versão diferente da fixada não escreve nada e passa a vez à
    versão fixada.
- `--status` mostra `client: local <versão>` ou `client: npx <versão>` em cada
  arquivo de hooks.
- Versões locais que nenhum hook usa são apagadas 24 h depois. `--remove`
  apaga na hora quando nenhum harness usa mais a versão.
- `CLIENT_VERSION` e o estado do heal (`connect-state.json`) passaram para o
  `hook.mjs`, que roda sozinho como cliente local.
- **Instalação troca hooks self-hosted pelos hospedados.** `valorbrain hook`,
  `valorbrain-hook-env hook`, `vbhook` e `clawmem hook` saem dos arquivos de
  hooks que a instalação escreve, comando a comando: hooks de terceiros ficam,
  mesmo no mesmo grupo. O plano lista os nomes (também no `--dry-run`) e fica
  o `.valorbrain-bak`.
  - Kiro: o standalone self-hosted é substituído inteiro. Com
    `--kiro-engine=legacy`, é apagado ao lado do agent config.
  - Até a 0.9, a instalação somava 3 hooks hospedados aos 8 self-hosted do
    Claude Code: contexto duas vezes por prompt e os extratores mais o
    checkpoint no Stop.
  - O self-heal nunca remove hooks self-hosted. Se houver hospedados e
    self-hosted no mesmo arquivo, escreve uma linha por heal em `connect.log`
    com o comando que resolve. `--remove` e `--mcp-only` só mexem nas entradas
    do connect.
- `connect-state.json` é gravado com tmp + rename: um leitor concorrente não
  vê mais arquivo pela metade e não perde `written`/`hook_clients`.
  `hook_clients` é guardado por harness e por caminho, então o mesmo harness em
  dois escopos não apaga a versão do outro.
- O heal roda `npx --no-update-notifier --loglevel=warn -y …@<pin> heal`, sem
  os avisos do npm 12. Ele não usa `--prefer-offline`: logo depois de um bump
  de pin, o packument em cache não tem a versão nova e o npm falharia com
  ETARGET.

## 0.9.0 — 2026-10-12

- `--mcp-only`: grava o servidor MCP e o bloco de instruções, sem hooks — nada é
  enviado a cada turno. Num harness que já tinha hooks, tira as nossas entradas.
  O modo fica em `~/.valorbrain/connect.json` (`mode: "mcp-only"`), aparece em
  `--status` e o self-heal nunca traz os hooks de volta; rodar de novo sem a
  flag instala os hooks. Hook nosso editado à mão segue a regra de edição
  manual (sem terminal, fica): aí o instalador e o `--status` dizem que ele
  continua enviando e apontam `--mcp-only --force`. Aceita também
  `--mcp-only=true|1|yes|on` / `=false|0|no|off`; outro valor sai com código 2.
  Junto com `--prompt`/`--transcript`/`--checkpoint` (que só gravam a escolha
  e saem) não é aplicado, e o stderr avisa.
- Flag desconhecida agora gera aviso no stderr
  (`warning: ignoring unknown flag(s): …`) e a instalação segue. Até a 0.8.1
  ela era ignorada em silêncio (`--mcp-only` na 0.8.1 fazia a instalação
  completa). Nunca vira erro: scripts e docs que passam flags novas continuam
  rodando.
- `--checkpoint on|off`: chave salva por harness em `connect.json`
  (`checkpoint`), como `--prompt`. O hook de Stop segue a mesma precedência do
  prompt: `VALORBRAIN_CHECKPOINT` (off|on, agora nos dois sentidos) > arquivo >
  ligado. É o único desligamento local no Gemini CLI, que roda os hooks sem o
  ambiente.

## 0.8.1 — 2026-10-11

- Confia também na chave reserva dos manifestos (kid `740a7527ff9447c2`); o
  `prepublishOnly` recusa publicar com menos de duas chaves.

## 0.8.0 — 2026-10-11

- Manifesto assinado (ed25519) conferido antes de escrever qualquer arquivo;
  arquivo editado à mão nunca é regravado pelo self-heal; `--prompt off` por
  harness.
