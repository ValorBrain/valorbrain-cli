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
