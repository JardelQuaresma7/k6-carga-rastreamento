// Base dos cenários de carga. Concentra as travas e as decisões que valem para todos:
//  - Trava de endereço: só roda contra hosts da lista (o Rastreio Demo local ou de homologação).
//    Produção nunca.
//  - Trava de perfil: fora a fumaça (o volume de um QA), os perfis pesados só rodam com
//    CARGA_LIBERADA=sim, ligada apenas na janela combinada com o time.
//  - Freio: o k6 para a execução inteira no primeiro sinal de estresse (erro > 5% ou p95 > 2 s),
//    para o teste não derrubar o ambiente.
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/2.4.0/dist/bundle.js';

export const BASE = (__ENV.BASE_URL || 'http://localhost:3333').replace(/\/$/, '');
const HOSTS_PERMITIDOS = (__ENV.HOSTS_PERMITIDOS || 'localhost:3333,127.0.0.1:3333').split(',');

const host = BASE.replace(/^https?:\/\//, '').split('/')[0];
if (!HOSTS_PERMITIDOS.includes(host)) {
  throw new Error(`Trava da carga: ${host} não está na lista de ambientes permitidos. Produção nunca.`);
}

export const TOKEN_PAINEL = __ENV.TOKEN_PAINEL || 'token-demo';

export function perfil() {
  const p = __ENV.PERFIL || 'fumaca';
  if (!['fumaca', 'degraus', 'regressao'].includes(p)) throw new Error(`Perfil desconhecido: ${p}`);
  if (p !== 'fumaca' && __ENV.CARGA_LIBERADA !== 'sim') {
    throw new Error(`Trava da carga: o perfil ${p} só roda com CARGA_LIBERADA=sim (janela combinada).`);
  }
  return p;
}

// Degraus sobre o pico real de produção (exemplo: ~25 visitas/s e ~0,3 postback/s).
// Visitas no pico, 2x e 4x; postbacks em ~3x e ~15x. Tudo em variável para ajustar sem mexer no código.
const taxas = (t) => String(t).trim().split(/\s+/).map(Number).filter((n) => n > 0);
export const DEGRAUS_DE_VISITAS = taxas(__ENV.DEGRAUS_DE_VISITAS || '25 50 100');
export const DEGRAUS_DE_POSTBACKS = taxas(__ENV.DEGRAUS_DE_POSTBACKS || '1 5');
export const DEGRAUS_DO_PIXEL = taxas(__ENV.DEGRAUS_DO_PIXEL || '25 50');
const SUBIDA = __ENV.SUBIDA || '1m';
const PATAMAR = __ENV.PATAMAR || '5m';

// User agent de navegador: clientes HTTP de biblioteca (curl, python-requests) costumam virar robô
// no rastreamento e distorcer o resultado.
export const NAVEGADOR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// O gerador sai de um IP só. Para não esbarrar no limite por IP + track (que um cliente real, com
// milhares de visitantes, nunca sente), cada visita simula um visitante e gira por várias tracks.
export const TRACKS = Array.from({ length: Number(__ENV.TRACKS || 120) }, (_, i) => `carga-fixa-${String(i + 1).padStart(3, '0')}`);
export const track = (n) => TRACKS[n % TRACKS.length];
export const ipDoVisitante = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

export const FREIO = {
  http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }],
  http_req_duration: [{ threshold: 'p(95)<2000', abortOnFail: true, delayAbortEval: '30s' }],
};

/** Degraus por taxa (por segundo): sobe em SUBIDA e fica PATAMAR em cada um. */
export function degraus(taxasPorSegundo, maxVUs) {
  const stages = [];
  for (const t of taxasPorSegundo) stages.push({ target: t, duration: SUBIDA }, { target: t, duration: PATAMAR });
  stages.push({ target: 0, duration: '30s' });
  return { executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1s', preAllocatedVUs: Math.min(100, maxVUs), maxVUs, stages };
}

/**
 * Regressão de carga semanal: roda sozinha no pico real e reprova (sem parar) se o p95 passar de
 * 3x a linha de base medida na primeira janela. Pega a entrega que deixou o sistema mais lento.
 */
export const LINHA_DE_BASE_P95_MS = { visita: 60, pixel: 40, postback: 60, painel: 120 };
export const limiteDaRegressao = (tipo) => `p(95)<${LINHA_DE_BASE_P95_MS[tipo] * 3}`;
export function regressao(taxa, maxVUs) {
  return {
    executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1s', preAllocatedVUs: Math.min(50, maxVUs), maxVUs,
    stages: [{ target: taxa, duration: '1m' }, { target: taxa, duration: '4m' }, { target: 0, duration: '30s' }],
  };
}

export const idDaExecucao = () => __ENV.EXECUCAO || String(Date.now());

/** Relatório HTML e JSON por cenário, em relatorios/, mais o resumo no terminal. */
export function relatorio(nome) {
  return (data) => ({
    [`relatorios/${nome}.html`]: htmlReport(data, { title: `Carga: ${nome}` }),
    [`relatorios/${nome}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  });
}
