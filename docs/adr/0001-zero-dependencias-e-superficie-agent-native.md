# ADR 0001 — Zero dependências e superfície agent-native

- **Status**: aceito (retroativo)
- **Data**: registrada em 2026-09-18
- **Fonte viva**: README do repo ("Zero dependencies… That's the whole signup")

## Contexto
O cliente primário do CLI é um agente de IA rodando em ambiente alheio
(`npx`, sem instalação persistida). Dependências de npm ampliariam superfície
de supply chain e tempo de cold-start do npx; humanos são públicos secundário.

## Decisão
Node >= 18 puro, **zero dependências de runtime**; todo comando aceita
`--json` (alias `--agent`) com saída single-object machine-readable;
`--agent-caller` é sempre self-declared (o sniff do ambiente só sugere, nunca
envia); key em `~/.valorbrain/config.json` com chmod 0600 e nunca logada.

## Consequências
- Cold-start rápido e auditoria de supply chain trivial (código é o repo inteiro).
- Cada feature nova de I/O HTTP é escrita à mão em `lib/api.js` — custo aceito.
- `help --json` cobre a superfície inteira (docs geráveis).
