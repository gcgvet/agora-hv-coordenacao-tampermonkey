# Ágora HV - Coordenação Tampermonkey

## Script da coordenação

1. No Chrome com o Tampermonkey e a sessão correta do Ciplex, habilite a permissão da extensão para acessar URLs de arquivo.
2. Importe `agora-hv-coordenacao.user.js` pelo painel do Tampermonkey.
3. A pagina `site/imprimir.html` gera e arquiva o PDF diretamente; o userscript nao participa mais dessa etapa.

O userscript 0.5.3 oferece:

- revisão contextual e acompanhamento de pendências das internações;
- busca de consultas e retornos no relatório do Ciplex;
- avaliação de completude, suficiência, coerência e documentação;
- criação e atualização das pendências inadequadas no Apps Script;
- relatório copiável por veterinário e exportação XLS das consultas.
- painel global com filtros, vencidas, reincidências, status e histórico;
- código rastreável, origem e última observação diretamente nos cartões;
- relatório resumido por veterinário, paciente e origem, ou relatório completo com histórico;
- relatórios com código sequencial da pendência e sem exposição de UUIDs internos;
- relatório operacional copiável e exportação CSV sob demanda.

O Apps Script mantém automaticamente um único backup JSON por dia no Drive, atualizado após cada alteração de internação ou pendência.

A impressão normal e o arquivamento são realizados pelo site.

## Script dos veterinários

O arquivo `agora-ciplex-para-internacao.user.js` adiciona o botão **Enviar para internação** ao cadastro do animal no Ciplex. Ele abre a internação ativa já vinculada ao ID Ciplex sem substituir seu conteúdo pelo cadastro do Ciplex; se não houver internação ativa, cria uma ficha preenchida com os dados cadastrais disponíveis. Como no sistema anterior, abrir a ficha atualiza sua data operacional para o dia atual.

1. Instale `agora-ciplex-para-internacao.user.js` no Tampermonkey do perfil do veterinário.
2. Habilite a permissão da extensão para acessar URLs de arquivo.
3. No menu do Tampermonkey, execute **Configurar caminho da ficha de internação**.
4. Informe o caminho completo de `site\index.html` nessa estação, por exemplo `J:\Meu Drive\Tratamento Hospitalar\site\index.html`.

O caminho fica armazenado somente no perfil local do Tampermonkey e pode ser diferente em cada computador. O script não usa Python, localhost ou servidor local.

## Publicação

Os userscripts usam `@updateURL` e `@downloadURL` dos respectivos arquivos Raw na branch `main` do repositório `gcgvet/agora-hv-coordenacao-tampermonkey`.

Ao publicar uma atualização, aumente `@version`. Nunca publique dados clínicos, IDs internos de pacientes, exportações, backups ou credenciais.
