# Changelog — @valorbrain/connect

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
