// Pixel /i com os eventos que o rastreador manda durante a visita (page_view, scroll_depth, page_exit).
// O pixel nunca devolve 429: quando estoura o limite, devolve a imagem e descarta o evento. Por isso
// o teste confere, no fim, se algum evento foi descartado (o 200 sozinho não prova nada).
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { BASE, NAVEGADOR, FREIO, perfil, degraus, regressao, limiteDaRegressao, DEGRAUS_DO_PIXEL, track, ipDoVisitante, relatorio } from './comum.js';

const EVENTOS = ['page_view', 'scroll_depth', 'page_exit'];
const PERFIS = {
  fumaca: { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1s', duration: '30s', preAllocatedVUs: 5 },
  degraus: degraus(DEGRAUS_DO_PIXEL, 300),
  regressao: regressao(DEGRAUS_DO_PIXEL[0], 100),
};
const PERFIL = perfil();

export const options = {
  scenarios: { pixel: PERFIS[PERFIL] },
  thresholds: {
    ...FREIO,
    'http_req_duration{tipo:pixel}': [PERFIL === 'regressao' ? limiteDaRegressao('pixel') : 'p(95)<300'],
    'http_req_failed{tipo:pixel}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return { descartadosAntes: http.get(`${BASE}/api/contadores`).json('pixelDescartado') };
}

export default function () {
  const n = exec.scenario.iterationInTest;
  const url = `${BASE}/i?t=${track(n)}&e=${EVENTOS[n % EVENTOS.length]}&r=${n}`;
  const r = http.get(url, { headers: { 'User-Agent': NAVEGADOR, 'X-Forwarded-For': ipDoVisitante(n) }, tags: { tipo: 'pixel' } });
  check(r, { 'pixel devolveu a imagem': (x) => x.status === 200 && x.headers['Content-Type'] === 'image/gif' });
}

export function teardown({ descartadosAntes }) {
  const depois = http.get(`${BASE}/api/contadores`).json('pixelDescartado');
  check(depois, { 'nenhum evento do pixel foi descartado em silêncio': (d) => d === descartadosAntes });
}

export const handleSummary = relatorio(`pixel-${PERFIL}`);
