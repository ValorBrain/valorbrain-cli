# Changelog — @valorbrain/connect

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
