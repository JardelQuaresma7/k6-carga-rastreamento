// Leituras que o painel faz ao abrir (resumo, vendas e tracks), com a sessão de um cliente logado.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE, TOKEN_PAINEL, FREIO, perfil, regressao, limiteDaRegressao, relatorio } from './comum.js';

const PERFIS = {
  fumaca: { executor: 'constant-vus', vus: 2, duration: '30s' },
  degraus: {
    executor: 'ramping-vus', startVUs: 1,
    stages: [{ target: 10, duration: '1m' }, { target: 10, duration: '3m' }, { target: 30, duration: '1m' }, { target: 30, duration: '3m' }, { target: 0, duration: '30s' }],
  },
  regressao: regressao(2, 20),
};
const PERFIL = perfil();
const op = { headers: { Authorization: `Bearer ${TOKEN_PAINEL}` }, tags: { tipo: 'painel' } };

export const options = {
  scenarios: { painel: PERFIS[PERFIL] },
  thresholds: {
    ...FREIO,
    'http_req_duration{tipo:painel}': [PERFIL === 'regressao' ? limiteDaRegressao('painel') : 'p(95)<2000'],
    'http_req_failed{tipo:painel}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  check(http.get(`${BASE}/api/painel/resumo`, op), { 'resumo 200': (r) => r.status === 200 });
  check(http.get(`${BASE}/api/vendas?busca=`, op), { 'vendas 200': (r) => r.status === 200 });
  check(http.get(`${BASE}/api/painel/tracks`, op), { 'tracks 200': (r) => r.status === 200 });
  if (PERFIL !== 'regressao') sleep(1); // tempo de leitura da tela
}

export const handleSummary = relatorio(`painel-${PERFIL}`);
