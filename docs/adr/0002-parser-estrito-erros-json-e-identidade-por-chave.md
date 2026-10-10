# ADR 0002 — Parser estrito, erros JSON com código de saída e identidade por chave

- **Status**: aceito
- **Data**: 2026-10-10
- **Substitui em parte**: ADR 0001 (`--agent` deixa de ser alias de `--json`)
- **Fonte viva**: PRD "ValorBrain rumo a 10" (M1, M4, M6) e o contrato de conexão
  (https://valorbrain.com.br/connect.md)

## Contexto
Na 0.1.x, uma flag desconhecida virava texto da memória (`add "x" --colection y`
gravava "x y"), `--agent` era ao mesmo tempo o modo do `init` e alias de `--json`,
erros saíam em texto no stderr mesmo com `--json`, e cada `add` gravava num path
derivado do hash do texto — uma versão nova virava documento novo, sem revisão.
`VALORBRAIN_TOKEN` servia tanto à chave REST quanto ao token MCP.

## Decisão
- Um spec por comando (`lib/args.js`) guia o parser, a validação e o `help --json`.
  Flag desconhecida, valor ausente, enum ou inteiro inválido, flag repetida e
  argumento sobrando são erro de uso. Texto que começa com traço vai depois de `--`.
- Flags globais em qualquer posição: `--json`, `--api-key` (alias `--key`), `--url`.
  Depois de `add`, `--key` é a chave da memória; o crédito REST vai em `--api-key`
  (ou `--key` antes do comando). Valor com prefixo de credencial em `add --key` é recusado.
- `--agent` só existe no `init`.
- Com `--json`, todo erro sai no stdout como `{ ok:false, error, code, exit_code, … }`.
  Códigos de saída: 0 ok · 1 falha do servidor/rede · 2 uso · 3 credencial ausente,
  do tipo errado ou recusada (401/403).
- `add --key <nome>` grava em `cli/key/<slug>`: repetir a chave é revisão
  (`action`, `revision_count`). `--supersedes` declara a supersessão na ingestão;
  `--sensitivity` escolhe a sensibilidade.
- Envs: `VALORBRAIN_API_KEY` (REST), `VALORBRAIN_MCP_TOKEN` (MCP), `VALORBRAIN_API_URL`,
  `VALORBRAIN_MCP_URL`. `VALORBRAIN_TOKEN` (vbm_ → MCP, senão REST),
  `VALORBRAIN_API_TOKEN` e `VALORBRAIN_URL` seguem aceitos com aviso no stderr.
  Um `vbm_` nunca é mandado à API REST.

## Consequências
- Scripts que passavam flags erradas passam a falhar com código 2 em vez de gravar
  lixo — é a intenção.
- Quem usava `--agent` como `--json` fora do `init` recebe erro com a dica.
- `--url` vale só para a execução; não reescreve mais o `engine_url` da config.
