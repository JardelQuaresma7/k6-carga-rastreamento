# Carga de uma plataforma de rastreamento — k6

[![Carga](https://github.com/JardelQuaresma7/k6-carga-rastreamento/actions/workflows/carga.yml/badge.svg)](https://github.com/JardelQuaresma7/k6-carga-rastreamento/actions/workflows/carga.yml)
[![Relatórios](https://img.shields.io/badge/relat%C3%B3rios-GitHub%20Pages-blue)](https://jardelquaresma7.github.io/k6-carga-rastreamento/)
![k6](https://img.shields.io/badge/k6-2.4-7d64ff?logo=k6&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-f7df1e?logo=javascript&logoColor=black)

Testes de carga com **k6** para uma plataforma SaaS de **rastreamento de visitas e vendas**
(o script na página do cliente, a API de eventos, o pixel, os postbacks de venda e o painel).

**De onde vem:** este projeto é uma réplica do teste de carga que eu planejei e executei, como QA,
para uma plataforma real desse tipo. O sistema e o repositório do cliente são privados (sob
sigilo), então aqui estão **a mesma estratégia, os mesmos cenários e as mesmas travas**, rodando
contra o **Rastreio Demo** (`app/`), um sistema pequeno que eu escrevi só para ser o alvo da carga.
Nenhum código, URL, credencial ou dado do cliente está neste repositório.

## O que o teste responde
1. O sistema aguenta o pico real de produção? E 2x e 4x o pico?
2. **O que quebra primeiro** quando a carga sobe, e por quê?
3. Uma entrega nova deixou o sistema mais lento? (regressão de carga semanal)

## Cenários
| Script | O que simula | Fumaça | Degraus (por segundo) |
|---|---|---|---|
| `carga/visitas.js` | Visita numa página rastreada: `loader.js` e `tracker.js` na CDN, validação do domínio, dados da track e `POST /events` | 1 visita/s por 30 s | 25, 50 e 100 (pico, 2x e 4x) |
| `carga/pixel.js` | Pixel `/i` com `page_view`, `scroll_depth` e `page_exit`; confere no fim se algum evento foi **descartado em silêncio** | 1/s por 30 s | 25 e 50 |
| `carga/postbacks.js` | Postback de venda, **cada pedido mandado duas vezes**; confere que nenhum duplicou a venda e apaga as vendas da execução | 10 pedidos | 1 e 5 |
| `carga/painel.js` | Leituras do painel ao abrir (resumo, vendas, tracks), com sessão de cliente | 2 usuários por 30 s | 10 e 30 usuários |

## Decisões de projeto
- **Trava de ambiente:** os scripts recusam qualquer host fora de `HOSTS_PERMITIDOS`. Produção nunca.
- **Trava de perfil:** só a fumaça roda livre. `degraus` e `regressao` exigem `CARGA_LIBERADA=sim`,
  ligada apenas na janela combinada com o time.
- **Freio:** o k6 para a execução inteira se o erro passar de 5% ou o p95 passar de 2 s (avaliados
  depois de 30 s). O primeiro sinal de estresse encerra o teste antes de derrubar o ambiente.
- **Metas por camada:** CDN p95 < 300 ms e erro < 0,1%; backend da visita p95 < 500 ms e erro < 1%;
  postback p95 < 1 s sem venda duplicada; painel p95 < 2 s.
- **Um gerador, muitos visitantes:** o gerador sai de um IP só e a API limita 60 eventos por minuto
  por IP + track. Cada visita simula um visitante (`X-Forwarded-For`) e gira por **120 tracks fixas**,
  para o teste medir o sistema e não o próprio limite.
- **User agent de navegador:** clientes HTTP de biblioteca viram robô no rastreamento.
- **Ausência não prova sozinha:** o pixel sempre devolve 200, então o teste confere o contador de
  eventos descartados; o postback devolve 200 duas vezes, então o teste confere as vendas no painel.
- **Limpeza pela chave exata:** as vendas da carga usam `carga-<execução>-<n>` e o teardown apaga só
  essas, conferindo que nada sobrou.

## O achado
No teste real, a carga de visitas **parou pelo freio** já na subida para 2x o pico: a CDN começou a
devolver **429 para todos os visitantes**. A causa: o limitador de taxa da CDN usava o IP da
requisição, e atrás do proxy da hospedagem esse IP é o do proxy, não o do visitante. Um pico vindo
de um lugar só bloqueava o script de rastreamento para todo mundo por 15 minutos, e o 429 ainda saía
com cache público de 1 hora.

O Rastreio Demo reproduz o defeito com `LIMITADOR_CDN=proxy` e a correção com `LIMITADOR_CDN=visitante`:

| Execução (local, 18/11/2026) | Resultado |
|---|---|
| Visitas 25 → 50 → 100/s, limitador por visitante (corrigido) | **Passou:** 9.754 visitas, 48.770 requisições, 0% de erro, p95 de 18 ms no backend e 0,5 ms na CDN |
| Visitas 25 → 50/s, limitador por IP do proxy (defeito) | **Parou pelo freio:** depois de 1.000 requisições, 26% de 429 na CDN; o backend seguia com 0% de erro |
| Fumaça dos 4 cenários | Passou: checks 100%, nenhum postback duplicado, nenhum evento do pixel descartado, limpeza completa |

## Regressão de carga semanal
Separada do estresse: roda sozinha no **pico real** todo domingo (GitHub Actions, `schedule`) e
**reprova se o p95 passar de 3x a linha de base** da primeira janela (`LINHA_DE_BASE_P95_MS` em
`carga/comum.js`). Pega a entrega que deixou o sistema mais lento antes do cliente sentir.

## Como rodar
Precisa de **Node 20+** e **k6**.
```bash
node app/servidor.js                      # sobe o Rastreio Demo em http://localhost:3333
k6 run carga/visitas.js                   # fumaça (padrão)
k6 run carga/postbacks.js
CARGA_LIBERADA=sim PERFIL=degraus k6 run carga/visitas.js
CARGA_LIBERADA=sim PERFIL=degraus SUBIDA=10s PATAMAR=40s k6 run carga/visitas.js   # degraus curtos
```
Reproduzir o achado:
```bash
PORTA=3334 LIMITADOR_CDN=proxy node app/servidor.js
BASE_URL=http://localhost:3334 HOSTS_PERMITIDOS=localhost:3334 CARGA_LIBERADA=sim PERFIL=degraus DEGRAUS_DE_VISITAS="25 50" k6 run carga/visitas.js
```
Cada execução grava `relatorios/<cenário>-<perfil>.html` e `.json`.

## Pipeline (GitHub Actions)
`.github/workflows/carga.yml`:
- **push e pull request:** sobe o Rastreio Demo, roda a fumaça dos 4 cenários e publica os relatórios no GitHub Pages;
- **domingo às 3h (Brasília):** regressão de carga no pico real;
- **manual:** escolhe o perfil (`fumaca`, `degraus`, `regressao`).

## Estrutura
```
app/servidor.js        Rastreio Demo (alvo da carga, sem dependências)
carga/comum.js         travas, freio, degraus, linha de base e relatório
carga/visitas.js       visita completa (CDN + backend)
carga/pixel.js         pixel /i e eventos descartados
carga/postbacks.js     postback duplicado e limpeza
carga/painel.js        leituras do painel
.github/workflows/     fumaça, regressão semanal e GitHub Pages
```

---
Jardel Silva Lima · QA Engineer · [LinkedIn](https://www.linkedin.com/in/jardel-lima-software-quality)
