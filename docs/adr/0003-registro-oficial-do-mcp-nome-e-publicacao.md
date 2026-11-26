# ADR 0003 — Registro oficial do MCP: nome do servidor e publicação por OIDC

- **Status**: proposto
- **Data**: 2026-11-26
- **Fonte viva**: documentação do registro
  (https://github.com/modelcontextprotocol/registry, pasta `docs/modelcontextprotocol-io`)
  e o contrato de conexão (https://valorbrain.com.br/connect.md)

## Contexto
Em 26/11/2026, `https://registry.modelcontextprotocol.io/v0/servers?search=valorbrain`
devolvia zero servidores e este repositório não tinha `server.json`. O registro
oficial é a lista de onde clientes e outros diretórios de MCP puxam servidores.

O nome de um servidor no registro traz o namespace de quem publica, e o método de
login decide o namespace: `io.github.<org>/*` pelo GitHub, ou o domínio invertido
(`br.com.valorbrain/*`) por um registro TXT no ápice do domínio ou um arquivo em
`/.well-known/mcp-registry-auth`. Uma versão publicada não muda mais.

## Decisão
- Nome: `io.github.ValorBrain/valorbrain`, com a caixa exata da organização (o
  registro compara o prefixo com `repository_owner` sem ignorar maiúsculas).
- Publicação pelo workflow `publish-mcp.yml`, manual, com `mcp-publisher login
  github-oidc`. Não usa segredo, token nem pessoa. O `login github` interativo não
  publica em namespace de organização (modelcontextprotocol/registry#1468).
- O `server.json` descreve só o que existe: o servidor hospedado em
  `https://mcpbrain.valor.digital/mcp` (streamable HTTP), com `Authorization: Bearer
  vbm_…` opcional, porque os clientes que entram por OAuth não mandam o cabeçalho.
- `package.json` passa a ter `mcpName` com o mesmo nome. O registro só aceita um
  pacote npm cujo `package.json` publicado traga esse campo, então a entrada
  `packages` (a ponte stdio `npx -y @valorbrain/cli mcp`) entra no `server.json` na
  primeira versão do CLI publicada no npm depois desta mudança.
- `version` do `server.json` acompanha a versão do CLI.

## Alternativas descartadas
- **Namespace por DNS (`br.com.valorbrain/*`)**: pede uma chave privada guardada
  como segredo e um TXT no ápice de `valorbrain.com.br`. O endpoint fica em
  `valor.digital`, então o nome não ganharia a vantagem de bater com o domínio do
  remoto.
- **Token pessoal com `read:org`**: entrega ao registro um token de dono da
  organização, que publica e sobrescreve qualquer servidor em `io.github.ValorBrain/*`.

## Consequências
- Qualquer workflow de qualquer repositório da organização ValorBrain consegue
  publicar em `io.github.ValorBrain/*`; quem pode escrever num repositório da
  organização pode publicar no registro.
- Para publicar de novo: mudar `version` no `server.json`, merge, rodar o workflow.
  Rodar sem mudar a versão não publica e fica verde.
- `test/server-json.test.js` falha se o nome sair de sincronia com `mcpName`, se a
  descrição passar de 100 caracteres ou se a URL do remoto divergir de
  `DEFAULT_MCP_URL`.

## Ordem de release com `packages` (0.2.3 em diante)
O `server.json` lista a ponte stdio (`npx -y @valorbrain/cli mcp`) em `packages`.
O registro confere no npm que a versão nomeada existe e traz o `mcpName`, então a
ordem é fixa:
1. `npm publish --access public` local do `@valorbrain/cli` na versão do
   `package.json` (o `publish.yml` não publica em runner self-hosted; ver o cabeçalho dele).
2. Conferir `npm view @valorbrain/cli@<versão> mcpName`.
3. Rodar o workflow `publish-mcp` na main e conferir
   `GET https://registry.modelcontextprotocol.io/v0/servers?search=valorbrain`.

Rodar o `publish-mcp` antes do passo 1 falha no registro; nada fica publicado pela metade.
