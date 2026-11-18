// Postbacks de venda simultâneos. Cada iteração manda o MESMO pedido duas vezes (plataformas de
// pagamento reenviam): a segunda não pode virar outra venda. No fim, o teardown confere que cada
// pedido virou exatamente uma venda e apaga as vendas da execução pela chave exata, conferindo que
// nada sobrou. Chave: carga-<execução>-<iteração>.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { BASE, TOKEN_PAINEL, FREIO, perfil, degraus, regressao, limiteDaRegressao, DEGRAUS_DE_POSTBACKS, idDaExecucao, relatorio } from './comum.js';

const PERFIS = {
  fumaca: { executor: 'per-vu-iterations', vus: 1, iterations: 10, maxDuration: '2m' },
  degraus: degraus(DEGRAUS_DE_POSTBACKS, 200),
  regressao: regressao(DEGRAUS_DE_POSTBACKS[0], 20),
};
const PERFIL = perfil();
const PAINEL = { headers: { Authorization: `Bearer ${TOKEN_PAINEL}` }, tags: { tipo: 'conferencia' } };

export const options = {
  scenarios: { postbacks: PERFIS[PERFIL] },
  teardownTimeout: '5m',
  thresholds: {
    ...FREIO,
    'http_req_duration{tipo:postback}': [PERFIL === 'regressao' ? limiteDaRegressao('postback') : 'p(95)<1000'],
    'http_req_failed{tipo:postback}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

// O prefixo sai do setup: cada VU e o teardown executam o código de início separadamente.
export function setup() {
  return { prefixo: `carga-${idDaExecucao()}` };
}

export default function ({ prefixo }) {
  const pedido = `${prefixo}-${exec.scenario.iterationInTest}`;
  const url = `${BASE}/postback?pedido=${pedido}&valor=97.00&status=aprovado`;
  const op = { tags: { tipo: 'postback' } };
  check(http.get(url, op), { 'postback aceito': (r) => r.status === 200 });
  check(http.get(url, op), { 'postback repetido aceito': (r) => r.status === 200 });
}

export function teardown({ prefixo }) {
  const vendas = http.get(`${BASE}/api/vendas?busca=${prefixo}-`, PAINEL).json('dados') || [];
  const pedidos = new Set(vendas.map((v) => v.pedido));
  check(vendas, { 'pedido repetido não duplicou a venda': () => vendas.length === pedidos.size && vendas.length > 0 });

  let apagadas = 0;
  for (const v of vendas) {
    const r = http.del(`${BASE}/api/vendas/${encodeURIComponent(v.pedido)}`, null, PAINEL);
    if (r.status === 204) apagadas++;
  }
  const sobraram = (http.get(`${BASE}/api/vendas?busca=${prefixo}-`, PAINEL).json('dados') || []).length;
  console.log(`limpeza: ${vendas.length} vendas da execução, ${apagadas} apagadas, ${sobraram} sobraram`);
  check(sobraram, { 'limpeza apagou todas as vendas da execução': (s) => s === 0 && apagadas === vendas.length });
}

export const handleSummary = relatorio(`postbacks-${PERFIL}`);
