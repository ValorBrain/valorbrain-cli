# Contribuir — valorbrain-cli

**Regras completas de organização:** `/www/valorbrain-platform/STANDARDS.md` (canônico, vale para todos os repos).
**Fronteira de repositórios:** `/www/valorbrain-platform/PLATFORM-MAP.md` (cliente → saas · nós → ops · memória → engine · sai para fora → docsexternos).

Resumo imperativo:

1. Raiz limpa: só README, doc-mapa, `adr/` e configs de build.
2. Decisão nova = ADR numerado em `docs/adr/`, com "Fonte viva" apontando o docid no ValorBrain. Nunca renumerar.
3. Relatório/PRD/audit concluído não fica na raiz — vai para a pasta de histórico do repo.
4. Nunca commitar `.env*`, `*.bak*`, `.DS_Store` — o pre-commit bloqueia (bypass consciente: `VALORBRAIN_ALLOW=1`).
5. Segredos vivem fora do repo; backups de env em `/root/backups/env-<repo>/`. `CREDENCIAIS` nunca rastreado.
6. Fez decisão ou aprendeu convenção? Registrar no ValorBrain (decisions/lesson) — o ADR é o snapshot, o brain é a fonte viva.

Em clone novo, ative os hooks:
```sh
git config core.hooksPath .githooks
```
