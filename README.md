# Ágora HV - Coordenação Tampermonkey

## Instalação de teste

1. No Chrome com o Tampermonkey e a sessão correta do Ciplex, habilite a permissão da extensão para acessar URLs de arquivo.
2. Importe `agora-hv-coordenacao.user.js` pelo painel do Tampermonkey.
3. A pagina `site/imprimir.html` gera e arquiva o PDF diretamente; o userscript nao participa mais dessa etapa.

O userscript 0.5.1 oferece:

- revisão contextual e acompanhamento de pendências das internações;
- busca de consultas e retornos no relatório do Ciplex;
- avaliação de completude, suficiência, coerência e documentação;
- criação e atualização das pendências inadequadas no Apps Script;
- relatório copiável por veterinário e exportação XLS das consultas.
- painel global com filtros, vencidas, reincidências, status e histórico;
- relatório operacional copiável e exportação CSV sob demanda.

O Apps Script mantém automaticamente um único backup JSON por dia no Drive, atualizado após cada alteração de internação ou pendência.

A impressão normal e o arquivamento são realizados pelo site.

## Publicação

O userscript usa `@updateURL` e `@downloadURL` do arquivo Raw na branch `main` do repositório `gcgvet/agora-hv-coordenacao-tampermonkey`.

Ao publicar uma atualização, aumente `@version`. Nunca publique dados clínicos, IDs internos de pacientes, exportações, backups ou credenciais.
