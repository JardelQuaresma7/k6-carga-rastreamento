// Rastreio Demo: um sistema pequeno de rastreamento de visitas e vendas, escrito só para ser o
// alvo dos testes de carga deste repositório. Sem dependências: só o módulo http do Node.
//
// Reproduz, de propósito, o comportamento que importa para a carga numa plataforma de rastreamento:
// - CDN com o script do rastreador (loader.js e tracker.js) atrás de um limitador de taxa;
// - API de eventos com limite por IP + track (429 com Retry-After);
// - pixel /i que não devolve 429 (descarta o evento em silêncio quando estoura);
// - postback de venda que precisa ser idempotente (o mesmo pedido duas vezes = uma venda só);
// - leituras do painel com autenticação;
// - um "banco" com pool de conexões limitado, para a latência crescer com a concorrência.
//
// LIMITADOR_CDN=proxy reproduz o defeito achado no teste real: atrás de um proxy, o limitador
// enxerga o IP do proxy e não o do visitante, então um pico de um lugar só bloqueia todo mundo.
// LIMITADOR_CDN=visitante (padrão) é a correção: a chave é o IP real (X-Forwarded-For).

const http = require('node:http');
const { URL } = require('node:url');

const PORTA = Number(process.env.PORTA || 3333);
const LIMITADOR_CDN = process.env.LIMITADOR_CDN || 'visitante';
const TOKEN_PAINEL = process.env.TOKEN_PAINEL || 'token-demo';
const POOL_DO_BANCO = Number(process.env.POOL_DO_BANCO || 8);

const CDN_LIMITE = 1000; // requisições por janela, por chave
const CDN_JANELA_MS = 15 * 60 * 1000;
const EVENTOS_LIMITE = 60; // por minuto, por IP + track
const PIXEL_LIMITE = 120; // por minuto, por IP + track (sem 429)

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const vendas = new Map(); // pedido -> venda
const eventos = new Map(); // track -> contagem
const contadores = { pixelDescartado: 0, eventos429: 0, cdn429: 0 };
const janelas = new Map(); // chave -> { inicio, total }

// ---------- utilidades ----------
function ipDoVisitante(req) {
  const xff = req.headers['x-forwarded-for'];
  return xff ? String(xff).split(',')[0].trim() : req.socket.remoteAddress;
}

function estourou(chave, limite, janelaMs) {
  const agora = Date.now();
  const j = janelas.get(chave);
  if (!j || agora - j.inicio >= janelaMs) {
    janelas.set(chave, { inicio: agora, total: 1 });
    return false;
  }
  j.total += 1;
  return j.total > limite;
}

// Pool de conexões: no máximo POOL_DO_BANCO consultas ao mesmo tempo; o resto espera na fila.
let ocupadas = 0;
const fila = [];
function consulta(ms) {
  return new Promise((resolve) => {
    const rodar = () => {
      ocupadas += 1;
      setTimeout(() => {
        ocupadas -= 1;
        const proxima = fila.shift();
        if (proxima) proxima();
        resolve();
      }, ms);
    };
    if (ocupadas < POOL_DO_BANCO) rodar();
    else fila.push(rodar);
  });
}
const sorteio = (min, max) => min + Math.random() * (max - min);

function json(res, status, corpo, extras = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extras });
  res.end(JSON.stringify(corpo));
}

function autenticado(req) {
  return req.headers.authorization === `Bearer ${TOKEN_PAINEL}`;
}

function lerCorpo(req) {
  return new Promise((resolve) => {
    let dados = '';
    req.on('data', (c) => (dados += c));
    req.on('end', () => {
      try { resolve(dados ? JSON.parse(dados) : {}); } catch { resolve({}); }
    });
  });
}

// ---------- rotas ----------
async function rotear(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/saude') return json(res, 200, { ok: true, limitadorCdn: LIMITADOR_CDN });

  // CDN: loader.js e tracker.js
  if (p === '/cdn/loader.js' || p === '/cdn/tracker.js') {
    const chave = LIMITADOR_CDN === 'proxy' ? `cdn:${req.socket.remoteAddress}` : `cdn:${ipDoVisitante(req)}`;
    if (estourou(chave, CDN_LIMITE, CDN_JANELA_MS)) {
      contadores.cdn429 += 1;
      // O defeito real: o 429 ainda saía com cache público de 1 hora.
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' });
      return res.end('Too Many Requests');
    }
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300' });
    return res.end(`/* ${p.slice(5)} */ window.__rastreio = true;`);
  }

  // Validação do domínio e dados da track
  let m = p.match(/^\/api\/tracks\/([\w-]+)\/(validate-domain|info)$/);
  if (m && req.method === 'GET') {
    await consulta(sorteio(2, 6));
    return json(res, 200, m[2] === 'info' ? { track: m[1], ativa: true } : { valido: true });
  }

  // Eventos: 60 por minuto por IP + track
  m = p.match(/^\/api\/tracks\/([\w-]+)\/events$/);
  if (m && req.method === 'POST') {
    const chave = `ev:${ipDoVisitante(req)}:${m[1]}`;
    if (estourou(chave, EVENTOS_LIMITE, 60_000)) {
      contadores.eventos429 += 1;
      return json(res, 429, { error: 'rate_limit_exceeded', message: 'Muitos eventos para este track' }, { 'Retry-After': '12' });
    }
    await lerCorpo(req);
    await consulta(sorteio(4, 12));
    eventos.set(m[1], (eventos.get(m[1]) || 0) + 1);
    return json(res, 202, { aceito: true });
  }

  // Pixel: nunca devolve 429; quando estoura, devolve a imagem e descarta o evento
  if (p === '/i' && req.method === 'GET') {
    const track = url.searchParams.get('t') || 'sem-track';
    const chave = `px:${ipDoVisitante(req)}:${track}`;
    if (estourou(chave, PIXEL_LIMITE, 60_000)) contadores.pixelDescartado += 1;
    else {
      await consulta(sorteio(1, 4));
      eventos.set(track, (eventos.get(track) || 0) + 1);
    }
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    return res.end(GIF);
  }

  // Postback de venda: idempotente pelo número do pedido
  if (p === '/postback' && req.method === 'GET') {
    const pedido = url.searchParams.get('pedido');
    if (!pedido) return json(res, 400, { erro: 'pedido obrigatório' });
    await consulta(sorteio(5, 15));
    if (!vendas.has(pedido)) {
      vendas.set(pedido, { pedido, valor: Number(url.searchParams.get('valor') || 0), criadaEm: new Date().toISOString() });
    }
    return json(res, 200, { recebido: true, pedido });
  }

  // Painel (com autenticação)
  if (p.startsWith('/api/painel/') || p.startsWith('/api/vendas')) {
    if (!autenticado(req)) return json(res, 401, { erro: 'não autenticado' });
    if (p === '/api/painel/resumo') {
      await consulta(sorteio(10, 30));
      return json(res, 200, { vendas: vendas.size, eventos: [...eventos.values()].reduce((a, b) => a + b, 0) });
    }
    if (p === '/api/painel/tracks') {
      await consulta(sorteio(8, 20));
      return json(res, 200, { tracks: [...eventos.entries()].slice(0, 50).map(([track, total]) => ({ track, total })) });
    }
    if (p === '/api/vendas' && req.method === 'GET') {
      await consulta(sorteio(8, 25));
      const busca = url.searchParams.get('busca') || '';
      const lista = [...vendas.values()].filter((v) => v.pedido.startsWith(busca));
      return json(res, 200, { total: lista.length, dados: lista.slice(0, 1000) });
    }
    m = p.match(/^\/api\/vendas\/(.+)$/);
    if (m && req.method === 'DELETE') {
      const apagou = vendas.delete(decodeURIComponent(m[1]));
      return json(res, apagou ? 204 : 404, apagou ? {} : { erro: 'venda não encontrada' });
    }
  }

  if (p === '/api/contadores') return json(res, 200, { ...contadores, vendas: vendas.size, filaDoBanco: fila.length });

  return json(res, 404, { erro: 'rota não encontrada' });
}

http
  .createServer((req, res) => {
    rotear(req, res).catch((e) => json(res, 500, { erro: String(e) }));
  })
  .listen(PORTA, () => console.log(`Rastreio Demo em http://localhost:${PORTA} (limitador da CDN: ${LIMITADOR_CDN})`));
