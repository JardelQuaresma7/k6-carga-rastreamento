// Visita numa página rastreada, do jeito que o navegador do visitante faz:
// baixa loader.js e tracker.js da CDN, valida o domínio, lê a track e manda o evento de visita.
// Cada iteração simula um visitante diferente (X-Forwarded-For) e gira pelas tracks fixas de carga.
import http from 'k6/http';
import { check, group } from 'k6';
import exec from 'k6/execution';
import { BASE, NAVEGADOR, FREIO, perfil, degraus, regressao, limiteDaRegressao, DEGRAUS_DE_VISITAS, track, ipDoVisitante, relatorio } from './comum.js';

const PERFIS = {
  fumaca: { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1s', duration: '30s', preAllocatedVUs: 5 },
  degraus: degraus(DEGRAUS_DE_VISITAS, 400),
  regressao: regressao(DEGRAUS_DE_VISITAS[0], 100),
};
const PERFIL = perfil();

export const options = {
  scenarios: { visitas: PERFIS[PERFIL] },
  thresholds: {
    ...FREIO,
    'http_req_duration{camada:cdn}': ['p(95)<300'],
    'http_req_duration{camada:backend}': [PERFIL === 'regressao' ? limiteDaRegressao('visita') : 'p(95)<500'],
    'http_req_failed{camada:cdn}': ['rate<0.001'],
    'http_req_failed{camada:backend}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const n = exec.scenario.iterationInTest;
  const t = track(n);
  const headers = { 'User-Agent': NAVEGADOR, 'X-Forwarded-For': ipDoVisitante(n) };
  const cdn = { headers, tags: { camada: 'cdn' } };
  const backend = { headers, tags: { camada: 'backend' } };

  group('CDN', () => {
    check(http.get(`${BASE}/cdn/loader.js`, cdn), { 'loader.js 200': (r) => r.status === 200 });
    check(http.get(`${BASE}/cdn/tracker.js`, cdn), { 'tracker.js 200': (r) => r.status === 200 });
  });
  group('Backend', () => {
    check(http.get(`${BASE}/api/tracks/${t}/validate-domain`, backend), { 'domínio válido': (r) => r.status === 200 });
    check(http.get(`${BASE}/api/tracks/${t}/info`, backend), { 'track lida': (r) => r.status === 200 });
    const corpo = JSON.stringify({ tipo: 'page_view', url: 'https://loja-demo.test/produto', em: Date.now() });
    const r = http.post(`${BASE}/api/tracks/${t}/events`, corpo, { ...backend, headers: { ...headers, 'Content-Type': 'application/json' } });
    check(r, { 'evento aceito (sem 429)': (x) => x.status === 202 });
  });
}

export const handleSummary = relatorio(`visitas-${PERFIL}`);
