/*
 * App de Pesagem — PWA
 * Funciona offline: dados ficam no tablet (IndexedDB) e são enviados
 * para a planilha (Google Apps Script) quando houver internet.
 */
'use strict';

const VERSAO_APP = '1.9.4';
const Calc = window.Calc;

/* =========================================================================
 * Armazenamento local (IndexedDB, chave/valor)
 * ========================================================================= */
const DB = (function () {
  let aberto = null;
  function abrir() {
    if (!aberto) {
      aberto = new Promise(function (ok, falha) {
        const req = indexedDB.open('pesagem', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
        req.onsuccess = function () { ok(req.result); };
        req.onerror = function () { falha(req.error); };
      });
    }
    return aberto;
  }
  async function get(k) {
    const db = await abrir();
    return new Promise(function (ok, falha) {
      const r = db.transaction('kv').objectStore('kv').get(k);
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { falha(r.error); };
    });
  }
  async function set(k, v) {
    const db = await abrir();
    return new Promise(function (ok, falha) {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = function () { ok(); };
      tx.onerror = function () { falha(tx.error); };
    });
  }
  return { get: get, set: set };
})();

/* =========================================================================
 * Estado
 * ========================================================================= */
const S = {
  config: null,        // { url, chave, dispositivo }
  dados: null,         // { parceiros, entregas, avisos, sincronizado_em }
  lanc: {},            // "data|id" -> lançamento (com _pendente, _erro, _enviado_em)
  inativacoes: [],     // [{ id_parceiro, em }] ainda não enviadas
  data: null,          // data de entrega selecionada (yyyy-mm-dd)
  ultimoEnvio: null,
  motoristasHist: [],  // [{ nome, ultima_data }] motoristas já usados (qualquer data)
  taras: {},           // { 'aaaa-mm-dd': { caixa, pallet, bag } } pesos de caixa/pallet/bag de cada entrega
  tarasPadrao: {},     // últimos valores usados (sugestão para a próxima entrega)
  // só em memória
  tela: 'lista',
  parceiroId: null,
  form: null,
  filtro: 'todos',
  busca: '',
  enviando: false,
  sincronizando: false,
  erroEnvio: null,     // 'rede' | mensagem do servidor | null
  armazenamentoPersistente: null,
  atualizacaoDisponivel: false,
};

async function salvarEstado() {
  try {
    await DB.set('estado', {
      dados: S.dados, lanc: S.lanc, inativacoes: S.inativacoes, data: S.data, ultimoEnvio: S.ultimoEnvio,
      motoristasHist: S.motoristasHist, taras: S.taras, tarasPadrao: S.tarasPadrao,
    });
  } catch (e) {
    aviso('ERRO ao salvar no tablet! ' + (e && e.message ? e.message : ''), 8000);
    throw e;
  }
}

/* =========================================================================
 * Utilitários
 * ========================================================================= */
const $ = function (sel) { return document.querySelector(sel); };

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pad(n) { return String(n).padStart(2, '0'); }
function hojeISO() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function fmtData(iso) {
  if (!iso) return '';
  const p = iso.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}
function fmtDataHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' às ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtNum(n, casas) {
  return Number(n || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: casas, maximumFractionDigits: casas, useGrouping: false,
  });
}
function fmtKg(n) { return fmtNum(n, 1) + ' kg'; }
function fmtR(n) { return 'R$ ' + fmtNum(n, 2); }
function fmtPct(n) {
  return Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2, useGrouping: false }) + '%';
}
/** Número -> texto para preencher um campo (vírgula decimal, sem zeros forçados). */
function numParaCampo(n) {
  if (n === null || n === undefined || n === '') return '';
  return String(n).replace('.', ',');
}
function chave(data, id) { return data + '|' + id; }
const ICONE_CALC = '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">' +
  '<rect x="4.5" y="2" width="15" height="20" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<rect x="7.5" y="5" width="9" height="4" rx=".8" fill="currentColor"/>' +
  [[9, 12.5], [12, 12.5], [15, 12.5], [9, 15.8], [12, 15.8], [15, 15.8], [9, 19], [12, 19], [15, 19]].map(function (c) {
    return '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="1.15" fill="currentColor"/>';
  }).join('') + '</svg>';
const SETA_VOLTAR = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false">' +
  '<path d="M20 12H5M11 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function semAcento(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizarNome(s) { return String(s || '').trim().replace(/\s+/g, ' '); }

/** Junta nomes ao histórico de motoristas (guarda a data mais recente de cada um). */
function registrarMotoristas(lista) {
  const porChave = {};
  S.motoristasHist.concat(lista).forEach(function (m) {
    const nome = normalizarNome(m && m.nome);
    if (!nome) return;
    const k = semAcento(nome);
    const data = String(m.ultima_data || '');
    if (!porChave[k] || porChave[k].ultima_data < data) porChave[k] = { nome: nome, ultima_data: data };
  });
  S.motoristasHist = Object.values(porChave)
    .sort(function (a, b) { return a.ultima_data < b.ultima_data ? 1 : a.ultima_data > b.ultima_data ? -1 : a.nome.localeCompare(b.nome, 'pt-BR'); })
    .slice(0, 60);
}

/** Motoristas já usados na entrega selecionada (sem repetir, em ordem alfabética). */
function motoristasDoDia() {
  const vistos = {};
  Object.values(S.lanc).forEach(function (r) {
    if (r.data_entrega !== S.data || r.situacao !== 'ENTREGOU') return;
    const m = normalizarNome(r.motorista);
    if (m && !vistos[semAcento(m)]) vistos[semAcento(m)] = m;
  });
  return Object.values(vistos).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
}
function nomeExibicao(p) { return p.apelido || p.nome || p.id_parceiro; }
function textoIE(ie) { return ie === 'SIM' ? 'Sim' : ie === 'NAO' ? 'Não' : 'Outro'; }

let temporizadorAviso = null;
function aviso(msg, ms) {
  const el = $('#aviso-rapido');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(function () { el.hidden = true; }, ms || 2500);
}

function confirmar(texto, txtSim, classeSim, txtNao) {
  return new Promise(function (resolver) {
    const modal = $('#modal');
    const sim = $('#modal-sim');
    const nao = $('#modal-nao');
    $('#modal-texto').textContent = texto;
    sim.textContent = txtSim || 'OK';
    sim.className = 'btn btn-grande ' + (classeSim || 'btn-verde');
    nao.textContent = txtNao || 'Cancelar';
    modal.hidden = false;
    function fim(v) {
      modal.hidden = true;
      sim.onclick = null;
      nao.onclick = null;
      resolver(v);
    }
    sim.onclick = function () { fim(true); };
    nao.onclick = function () { fim(false); };
  });
}

/* =========================================================================
 * Dados derivados
 * ========================================================================= */
function entregaAtual() {
  if (!S.dados || !S.data) return null;
  return S.dados.entregas.find(function (e) { return e.data_entrega === S.data; }) || null;
}

function parceirosVisiveis() {
  if (!S.dados) return [];
  const removidos = new Set(S.inativacoes.map(function (i) { return i.id_parceiro; }));
  return S.dados.parceiros
    .filter(function (p) { return !removidos.has(p.id_parceiro); })
    .slice()
    .sort(function (a, b) {
      const oa = a.ordem === null || a.ordem === undefined ? Infinity : a.ordem;
      const ob = b.ordem === null || b.ordem === undefined ? Infinity : b.ordem;
      if (oa !== ob) return oa - ob;
      return nomeExibicao(a).localeCompare(nomeExibicao(b), 'pt-BR');
    });
}

function parceiroPorId(id) {
  return S.dados ? S.dados.parceiros.find(function (p) { return p.id_parceiro === id; }) : null;
}

function registroDe(id) { return S.data ? S.lanc[chave(S.data, id)] : null; }

function pendencias() {
  const todos = Object.values(S.lanc).filter(function (r) { return r._pendente; });
  return {
    lancamentos: todos.filter(function (r) { return !r._erro; }).length,
    erros: todos.filter(function (r) { return r._erro; }),
    inativacoes: S.inativacoes.length,
  };
}

/* =========================================================================
 * Situação da sincronização: ícone no cabeçalho + faixa temporária (só na tela principal)
 * ========================================================================= */
function estadoSync() {
  const hoje = hojeISO();
  const pend = pendencias();
  const totalPend = pend.lancamentos + pend.inativacoes;
  let sync, nivelSync = 0; // 0 ok · 1 atenção · 2 problema
  if (S.sincronizando) {
    sync = '⟳ Sincronizando com a planilha...';
  } else if (!S.config || !S.config.url) {
    sync = 'App não configurado. Toque em Configurações, no fim da página.'; nivelSync = 2;
  } else if (!S.dados) {
    sync = '✖ Nenhum dado sincronizado. Com internet, toque em Sincronizar antes de ir para o campo.'; nivelSync = 2;
  } else if (!S.dados.entregas.length) {
    sync = '✖ Nenhuma entrega ABERTA na planilha (sincronizado em ' + fmtDataHora(S.dados.sincronizado_em) + ').'; nivelSync = 2;
  } else if (S.data === hoje) {
    sync = '✔ Pronto para a entrega de HOJE (' + fmtData(S.data) + ') · sincronizado em ' + fmtDataHora(S.dados.sincronizado_em);
  } else {
    sync = '⚠ Dados da entrega de ' + fmtData(S.data) + ' — hoje é ' + fmtData(hoje) +
      '. Se a entrega é hoje, sincronize com internet.';
    nivelSync = 1;
  }
  let envio = '', nivelEnvio = 0;
  if (S.enviando) {
    envio = '⟳ Enviando para a planilha...';
  } else if (pend.erros.length) {
    envio = '⚠ ' + pend.erros.length + ' lançamento(s) recusado(s) pela planilha: ' + pend.erros[0]._erro;
    nivelEnvio = 2;
  } else if (totalPend) {
    envio = '⏳ ' + totalPend + (totalPend === 1 ? ' alteração aguardando envio. ' : ' alterações aguardando envio. ') +
      (S.erroEnvio && S.erroEnvio !== 'rede' ? 'Erro: ' + S.erroEnvio : 'Serão enviadas quando houver internet.');
    nivelEnvio = 1;
  } else if (S.ultimoEnvio && Object.keys(S.lanc).length) {
    envio = '✔ Tudo enviado para a planilha (último envio ' + fmtDataHora(S.ultimoEnvio) + ').';
  }
  return {
    sync: sync, envio: envio, nivelSync: nivelSync, nivel: Math.max(nivelSync, nivelEnvio),
    totalPend: totalPend, erros: pend.erros.length,
  };
}

/** Atualiza o ícone de situação no cabeçalho (e o que aparece só na tela principal). */
function renderFaixas() {
  const e = estadoSync();
  const el = $('#status-sync');
  let estado, txt, dica;
  if (S.sincronizando || S.enviando) { estado = 'ocupado'; txt = '⟳'; dica = 'Sincronizando'; }
  else if (e.erros || e.nivelSync === 2) { estado = 'erro'; txt = '⚠'; dica = 'Problema na sincronização'; }
  else if (e.totalPend) { estado = 'pendente'; txt = '⏳ ' + e.totalPend; dica = 'Aguardando envio'; }
  else if (e.nivelSync === 1) { estado = 'aviso'; txt = '⚠'; dica = 'Dados de outra data'; }
  else { estado = 'ok'; txt = '✔'; dica = 'Tudo sincronizado'; }
  el.dataset.estado = estado;
  el.textContent = txt;
  el.setAttribute('aria-label', dica);
  const naLista = S.tela === 'lista';
  el.hidden = !naLista;
  $('#btn-sync').hidden = !naLista;
  $('#btn-sync').disabled = S.sincronizando;
  renderTopoData();
  $('#faixa-atualizacao').hidden = !(naLista && S.atualizacaoDisponivel);
  if (!naLista) esconderStatus();
  else if (!$('#faixa-status').hidden) preencherFaixaStatus(e); // atualiza o texto se estiver aberta
}

/**
 * Data da entrega no cabeçalho. Tela principal: lista para escolher se houver mais de uma entrega aberta
 * (quase sempre há só uma, então aparece só a data). Tela do parceiro: data fixa.
 */
const TELA_PEQUENA = window.matchMedia('(max-width: 600px)');
if (TELA_PEQUENA.addEventListener) TELA_PEQUENA.addEventListener('change', function () { renderTopoData(); });

function renderTopoData() {
  const el = $('#topo-data');
  if (!el) return;
  const ent = entregaAtual();
  if (!ent || S.tela === 'config') { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const ents = S.dados.entregas;
  const curta = TELA_PEQUENA.matches; // celular: data sem o ano
  const chaveAtual = S.tela + '|' + ent.data_entrega + '|' + curta + '|' + ents.map(function (e) { return e.data_entrega; }).join(',');
  if (el.dataset.chave === chaveAtual) return; // nada mudou: não redesenha (não fecha a lista aberta)
  el.dataset.chave = chaveAtual;
  if (S.tela === 'lista' && ents.length > 1) {
    el.innerHTML = '<select id="sel-data" class="sel-data" aria-label="Entrega">' + ents.map(function (e) {
      return '<option value="' + e.data_entrega + '"' + (e.data_entrega === ent.data_entrega ? ' selected' : '') + '>' +
        (curta ? fmtData(e.data_entrega).slice(0, 5) : fmtData(e.data_entrega)) + '</option>';
    }).join('') + '</select>';
  } else {
    const d = fmtData(ent.data_entrega); // dd/mm/aaaa — em telas estreitas o ano some
    el.innerHTML = '<span class="data-fixa" title="Data da entrega">' + d.slice(0, 5) + '<span class="ano">' + d.slice(5) + '</span></span>';
  }
}

let temporizadorFaixa = null;
function preencherFaixaStatus(e) {
  const f = $('#faixa-status');
  const classe = (S.sincronizando || S.enviando) ? 'faixa-azul'
    : e.nivel === 2 ? 'faixa-vermelha' : e.nivel === 1 ? 'faixa-amarela' : 'faixa-verde';
  f.className = 'bolha ' + classe;
  f.innerHTML = '<div>' + esc(e.sync) + (e.envio ? '<small>' + esc(e.envio) + '</small>' : '') + '</div>';
}
/** Mostra a situação completa por alguns segundos (só na tela principal). */
function mostrarStatus(ms) {
  if (S.tela !== 'lista') return;
  const e = estadoSync();
  preencherFaixaStatus(e);
  $('#faixa-status').hidden = false;
  clearTimeout(temporizadorFaixa);
  temporizadorFaixa = setTimeout(esconderStatus, ms || (e.nivel ? 10000 : 6000));
}
function esconderStatus() {
  clearTimeout(temporizadorFaixa);
  const f = $('#faixa-status');
  if (f) f.hidden = true;
}

/* =========================================================================
 * Telas
 * ========================================================================= */
function render() {
  renderFaixas();
  if (S.tela === 'config') renderConfig();
  else if (S.tela === 'parceiro') renderParceiro();
  else renderLista();
}

/* ---------------------------- Lista ---------------------------- */
const RODAPE = '<footer class="rodape"><button class="btn btn-rodape" data-acao="abrir-config">⚙ Configurações</button>' +
  '<span>Versão ' + VERSAO_APP + '</span></footer>';

function renderLista() {
  S.tela = 'lista';
  const tela = $('#tela');
  if (!S.dados || !S.dados.entregas.length) {
    tela.innerHTML = '<div class="vazio">' +
      (!S.config || !S.config.url
        ? 'Toque em <b>Configurações</b>, aqui embaixo, para informar o endereço da planilha.'
        : 'Nenhuma entrega disponível.<br>Com internet, toque em <b>⟳ Sincronizar</b>.') +
      '</div>' + RODAPE;
    return;
  }
  const ent = entregaAtual();
  const ps = parceirosVisiveis();
  let pesados = 0, naoEntregou = 0;
  ps.forEach(function (p) {
    const r = registroDe(p.id_parceiro);
    if (r && r.situacao === 'ENTREGOU') pesados++;
    else if (r && r.situacao === 'NAO_ENTREGOU') naoEntregou++;
  });
  const faltam = ps.length - pesados - naoEntregou;

  let html = '';
  if (ent.observacoes) html += '<div class="obs-fixa">' + esc(ent.observacoes) + '</div>';
  html += '<div class="resumo-dia">' +
    '<div><b>' + pesados + '</b><span>Pesados</span></div>' +
    '<div><b>' + naoEntregou + '</b><span>Não entregaram</span></div>' +
    '<div><b>' + faltam + '</b><span>Faltam</span></div></div>';
  const cargas = {};
  ps.forEach(function (p) {
    const r = registroDe(p.id_parceiro);
    if (!r || r.situacao !== 'ENTREGOU') return;
    const m = normalizarNome(r.motorista) || 'Sem motorista';
    const k = semAcento(m);
    if (!cargas[k]) cargas[k] = { nome: m, qtde: 0, peso: 0 };
    cargas[k].qtde++;
    cargas[k].peso = Calc.arred(cargas[k].peso + (r.peso_total_kg || 0), 1);
  });
  const listaCargas = Object.values(cargas).sort(function (x, y) { return x.nome.localeCompare(y.nome, 'pt-BR'); });
  if (listaCargas.length) {
    html += '<div class="por-motorista">' + listaCargas.map(function (c) {
      return '<span>🚚 <b>' + esc(c.nome) + '</b> · ' + c.qtde + (c.qtde === 1 ? ' parceiro' : ' parceiros') +
        ' · ' + fmtKg(c.peso) + '</span>';
    }).join('') + '</div>';
  }
  html += '<div class="barra-busca">' +
    '<input id="busca" class="entrada entrada-busca" type="search" placeholder="Buscar parceiro" autocomplete="off" value="' + esc(S.busca) + '">' +
    '<div class="filtro">' +
    '<button class="btn' + (S.filtro === 'todos' ? ' ativo' : '') + '" data-acao="filtro" data-valor="todos">Todos</button>' +
    '<button class="btn' + (S.filtro === 'faltam' ? ' ativo' : '') + '" data-acao="filtro" data-valor="faltam">Faltam</button>' +
    '</div></div>';
  html += '<div id="lista" class="lista"></div>' + RODAPE;
  tela.innerHTML = html;
  renderGradeLista();
}

function renderGradeLista() {
  const el = $('#lista');
  if (!el) return;
  const termo = semAcento(S.busca.trim());
  const ps = parceirosVisiveis().filter(function (p) {
    const r = registroDe(p.id_parceiro);
    if (S.filtro === 'faltam' && r) return false;
    if (!termo) return true;
    const alvo = semAcento([p.apelido, p.nome, p.fazenda, p.id_parceiro, r ? r.motorista : ''].join(' '));
    return alvo.indexOf(termo) >= 0;
  });
  if (!ps.length) {
    el.innerHTML = '<div class="vazio">' +
      (S.filtro === 'faltam' && !termo ? 'Todos os parceiros já foram lançados. ✔' : 'Nenhum parceiro encontrado.') + '</div>';
    return;
  }
  // Agrupa por fazenda, na ordem em que cada fazenda aparece primeiro (respeita a coluna "ordem")
  const grupos = [];
  const porFazenda = {};
  ps.forEach(function (p) {
    const nomeFaz = normalizarNome(p.fazenda) || 'Sem fazenda';
    const k = semAcento(nomeFaz);
    if (!porFazenda[k]) { porFazenda[k] = { nome: nomeFaz, parceiros: [] }; grupos.push(porFazenda[k]); }
    porFazenda[k].parceiros.push(p);
  });
  // Contagem por fazenda considera todos os parceiros da fazenda, não só os filtrados
  const todos = parceirosVisiveis();
  el.innerHTML = grupos.map(function (g) {
    const daFazenda = todos.filter(function (p) { return semAcento(normalizarNome(p.fazenda) || 'Sem fazenda') === semAcento(g.nome); });
    const feitos = daFazenda.filter(function (p) { return registroDe(p.id_parceiro); }).length;
    const faltamFaz = daFazenda.length - feitos;
    return '<div class="grupo-fazenda"><h2>' + esc(g.nome) + '</h2>' +
      '<div class="grupo-dir"><span' + (faltamFaz === 0 ? ' class="grupo-completo"' : '') + '>' +
      feitos + ' de ' + daFazenda.length + (faltamFaz === 0 ? ' ✔' : '') + '</span>' +
      (faltamFaz > 0
        ? '<button class="btn btn-fazenda-nao" data-acao="nao-entregou-fazenda" data-fazenda="' + esc(g.nome) + '">' +
          (faltamFaz === 1 ? 'Não entregou' : 'Nenhum entregou') + '</button>'
        : '') +
      '</div></div>' + cartoesDaFazenda(g.parceiros);
  }).join('');
}

/**
 * Cartões de uma fazenda: primeiro os que faltam lançar; depois os que entregaram,
 * agrupados por motorista (caminhão); por último os que não entregaram.
 * Dentro de cada grupo mantém a ordem da coluna "ordem".
 */
function cartoesDaFazenda(parceiros) {
  const faltam = [], naoEntregou = [];
  const porMotorista = {};
  parceiros.forEach(function (p) {
    const r = registroDe(p.id_parceiro);
    if (!r) { faltam.push(p); return; }
    if (r.situacao !== 'ENTREGOU') { naoEntregou.push(p); return; }
    const nome = normalizarNome(r.motorista) || 'Sem motorista';
    const k = semAcento(nome);
    if (!porMotorista[k]) porMotorista[k] = { nome: nome, parceiros: [], peso: 0 };
    porMotorista[k].parceiros.push(p);
    porMotorista[k].peso = Calc.arred(porMotorista[k].peso + (r.peso_total_kg || 0), 1);
  });
  let html = faltam.map(cartaoParceiro).join('');
  Object.values(porMotorista)
    .sort(function (x, y) { return x.nome.localeCompare(y.nome, 'pt-BR'); })
    .forEach(function (m) {
      html += '<div class="subgrupo subgrupo-motorista">🚚 ' + esc(m.nome) +
        '<span>' + m.parceiros.length + (m.parceiros.length === 1 ? ' parceiro' : ' parceiros') +
        ' · ' + fmtKg(m.peso) + '</span></div>' + m.parceiros.map(cartaoParceiro).join('');
    });
  if (naoEntregou.length) {
    html += '<div class="subgrupo subgrupo-nao">Não entregaram</div>' + naoEntregou.map(cartaoParceiro).join('');
  }
  return html;
}

function cartaoParceiro(p) {
  const r = registroDe(p.id_parceiro);
  let classe = 'a-pesar', estado = '<b>A pesar</b>';
  if (r) {
    if (r.situacao === 'ENTREGOU') {
      classe = 'pesado';
      estado = '<b>' + fmtKg(r.peso_total_kg) + '</b>';
    } else {
      classe = 'nao-entregou';
      estado = '<b>Não entregou</b>';
    }
  }
  const sub = p.apelido && p.nome !== p.apelido ? p.nome : '';
  return '<button class="cartao ' + classe + '" data-acao="abrir-parceiro" data-id="' + esc(p.id_parceiro) + '">' +
    '<div class="info"><div class="apelido">' + esc(nomeExibicao(p)) + '</div>' +
    (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>' +
    '<div class="estado">' + estado + '</div></button>';
}

/* ---------------------------- Parceiro ---------------------------- */
function abrirParceiro(id) {
  const p = parceiroPorId(id);
  if (!p || !entregaAtual()) return;
  const r = registroDe(id);
  S.parceiroId = id;
  S.form = {
    peso: r && r.situacao === 'ENTREGOU' ? numParaCampo(r.peso_total_kg) : '',
    pen: r && r.situacao === 'ENTREGOU' ? numParaCampo(r.penalidade_pct) : '0',
    modo: r && r.situacao === 'ENTREGOU' ? (r.desconto_modo || 'NENHUM') : 'NENHUM',
    desc: r && r.desconto_modo === 'VALOR' ? numParaCampo(r.desconto_informado) : '',
    obs: r ? (r.observacoes || '') : '',
    motorista: r && r.situacao === 'ENTREGOU' ? normalizarNome(r.motorista) : '',
    calc: { itens: r && r.situacao === 'ENTREGOU' && Array.isArray(r._calc) ? r._calc.slice() : [], editando: null, editTara: null },
    alterado: false,
  };
  S.tela = 'parceiro';
  history.pushState({ tela: 'parceiro', id: id }, '');
  render();
  window.scrollTo(0, 0);
}

function renderParceiro() {
  const p = parceiroPorId(S.parceiroId);
  const ent = entregaAtual();
  if (!p || !ent || !S.form) { S.tela = 'lista'; renderLista(); return; }
  const r = registroDe(p.id_parceiro);
  const f = S.form;
  const sub = [p.apelido && p.nome !== p.apelido ? p.nome : '', p.fazenda].filter(Boolean).join(' · ');

  let estadoReg = '';
  if (r && r.situacao === 'NAO_ENTREGOU') {
    estadoReg = '<div class="estado-registro" style="background:var(--laranja-claro);color:var(--laranja)">' +
      'Marcado como NÃO ENTREGOU nesta data. Para lançar o peso, preencha e toque em Salvar.</div>';
  } else if (r && r.situacao === 'ENTREGOU') {
    estadoReg = '<div class="estado-registro" style="background:var(--verde-claro);color:var(--verde)">' +
      'Já lançado (' + fmtKg(r.peso_total_kg) + '). Altere o que precisar e toque em Salvar.' +
      (r._erro ? '<br><span style="color:var(--vermelho)">⚠ Recusado pela planilha: ' + esc(r._erro) + '</span>' : '') +
      '</div>';
  }

  $('#tela').innerHTML =
    '<div class="cab-parceiro">' +
    '<button class="btn btn-voltar" data-acao="voltar" aria-label="Voltar">' + SETA_VOLTAR + '</button>' +
    '<div class="nomes"><div class="linha-nome"><h1>' + esc(nomeExibicao(p)) + '</h1>' +
    '<span class="etiqueta">I.E.: ' + textoIE(p.tem_ie) + '</span>' +
    '<span class="etiqueta" title="Participação">Part. ' + fmtPct(p.participacao_pct) + '</span></div>' +
    (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
    '</div></div>' +
    (p.observacoes ? '<div class="obs-fixa">📝 ' + esc(p.observacoes) + '</div>' : '') +
    estadoReg +
    '<div class="form-unica">' +

    '<div class="campo"><label for="f-peso">Peso total</label>' +
    '<div class="com-unidade"><input id="f-peso" class="entrada" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0" value="' + esc(f.peso) + '"><span class="unidade">kg</span>' +
    '<button class="btn btn-calc" data-acao="calc-abrir" aria-label="Calcular peso líquido" title="Calcular peso líquido">' + ICONE_CALC + '</button></div>' +
    '<div class="erro-campo" id="e-peso"></div></div>' +

    '<div class="campo"><span class="rotulo">Motorista (caminhão)</span>' +
    '<div class="motoristas" id="mot-botoes"></div>' +
    '<div class="erro-campo" id="e-mot"></div></div>' +

    '<div class="campo"><span class="rotulo">Penalidade</span>' +
    '<div class="botoes-rapidos sem-margem" id="pen-rapidos">' +
    [0, 1, 2, 3, 4].map(function (v) {
      return '<button class="btn" data-acao="pen" data-valor="' + v + '">' + v + '%</button>';
    }).join('') + '</div>' +
    '<div class="erro-campo" id="e-pen"></div></div>' +

    '<div class="recebe" id="resultado"></div>' +

    '<div class="campo"><label for="f-desc">Desconto em R$</label>' +
    '<div class="com-unidade"><span class="unidade">R$</span><input id="f-desc" class="entrada" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0,00" value="' + esc(f.desc) + '"></div>' +
    '<div class="erro-campo" id="e-desc"></div>' +
    '<div class="botoes-desc" id="botoes-desc">' +
    // em telas pequenas some o "R$" e "Máximo" vira "Máx." (classes so-largo / so-estreito)
    '<button class="btn" data-acao="desc-zerar">Zerar</button>' +
    '<button class="btn" data-acao="desc-somar" data-valor="100">+<span class="so-largo"> R$</span>100</button>' +
    '<button class="btn" data-acao="desc-somar" data-valor="500">+<span class="so-largo"> R$</span>500</button>' +
    '<button class="btn" data-acao="desc-somar" data-valor="1000">+<span class="so-largo"> R$</span>1.000</button>' +
    '<button class="btn btn-desc-max" data-acao="desc-maximo"><span class="so-largo">Máximo</span><span class="so-estreito">Máx.</span></button>' +
    '<button class="btn" data-acao="desc-somar" data-valor="-100">−<span class="so-largo"> R$</span>100</button>' +
    '<button class="btn" data-acao="desc-somar" data-valor="-500">−<span class="so-largo"> R$</span>500</button>' +
    '<button class="btn" data-acao="desc-somar" data-valor="-1000">−<span class="so-largo"> R$</span>1.000</button>' +
    '</div></div>' +

    '<div class="acoes-form">' +
    '<button class="btn btn-grande btn-verde" data-acao="salvar">✔ SALVAR</button>' +
    (r && r.situacao === 'NAO_ENTREGOU' ? '' :
      '<button class="btn btn-grande btn-laranja" data-acao="nao-entregou">Não entregou</button>') +
    '</div>' +

    '<div class="campo"><label for="f-obs">Observações</label>' +
    '<textarea id="f-obs" class="entrada entrada-texto" placeholder="(opcional)">' + esc(f.obs) + '</textarea></div>' +
    '</div>';

  renderMotoristas();
  atualizarBotoesForm();
  atualizarResultado();
}

function renderMotoristas() {
  const el = $('#mot-botoes');
  if (!el || !S.form) return;
  const f = S.form;
  const lista = motoristasDoDia();
  // motorista escolhido na janela "Outro motorista" aparece junto, já marcado
  if (f.motorista && !lista.some(function (m) { return semAcento(m) === semAcento(f.motorista); })) lista.push(f.motorista);
  el.innerHTML = lista.map(function (m) {
    const ativo = semAcento(m) === semAcento(f.motorista);
    return '<button class="btn' + (ativo ? ' ativo' : '') + '" data-acao="mot" data-valor="' + esc(m) + '">🚚 ' + esc(m) + '</button>';
  }).join('') +
    '<button class="btn mot-mais" data-acao="mot-novo">' + (lista.length ? '+ Outro motorista' : '+ Escolher motorista') + '</button>';
}

/* =========================================================================
 * Calculadora de peso líquido (Pallets e Bags)
 *   Pallet: Pesagem − nº Caixas × Peso Caixa − Peso Pallet
 *   Bag:    Pesagem − Peso Bag
 * Os pesos de caixa/pallet/bag ficam guardados no tablet para cada data de entrega.
 * ========================================================================= */
const TARAS = {
  caixa: { rot: 'Peso Caixa', campo: 'caixaT' },
  pallet: { rot: 'Peso Pallet', campo: 'palletT' },
  bag: { rot: 'Peso Bag', campo: 'bagT' },
};
function tarasDoDia() { return (S.taras && S.taras[S.data]) || {}; }
function definirTara(nome, valor) {
  S.taras[S.data] = Object.assign({}, S.taras[S.data]);
  S.taras[S.data][nome] = valor;
  S.tarasPadrao = Object.assign({}, S.tarasPadrao);
  S.tarasPadrao[nome] = valor;
  salvarEstado().catch(function () {});
}
function liquidoItem(it, t) {
  if (it.tipo === 'PALLET') return Calc.arred(it.pesagem - it.caixas * t.caixa - t.pallet, 1);
  return Calc.arred(it.pesagem - t.bag, 1);
}
function totalCalc() {
  const t = tarasDoDia();
  return Calc.arred(S.form.calc.itens.reduce(function (s, it) { return s + liquidoItem(it, t); }, 0), 1);
}
function fmtKgCalc(n) { return fmtNum(n, 1) + ' kg'; }
function fmtTara(n) {
  return n === undefined || n === null ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2, useGrouping: false }) + ' kg';
}

function abrirCalc() {
  S.form.calc.editando = null;
  S.form.calc.editTara = null;
  renderCalc();
  $('#modal-calc').hidden = false;
  history.pushState({ tela: 'parceiro', id: S.parceiroId, modal: 'calc' }, '');
}
function fecharCalc() {
  $('#modal-calc').hidden = true;
  if (history.state && history.state.modal === 'calc') history.back();
}

/** Campos do formulário de um Pallet/Bag (inclui as taras que ainda não foram definidas nesta data). */
function camposDoItem(tipo) {
  const t = tarasDoDia();
  const lista = tipo === 'PALLET' ? ['caixas', 'pesagem'] : ['pesagem'];
  const taras = tipo === 'PALLET' ? ['caixa', 'pallet'] : ['bag'];
  if (S.form.calc.editando && S.form.calc.editando.idx < 0 && taras.some(function (n) { return t[n] === undefined; })) {
    taras.forEach(function (n) { lista.push(TARAS[n].campo); });
  }
  return lista;
}
const ROTULO_CAMPO = { caixas: 'nº Caixas', pesagem: 'Pesagem', caixaT: 'Peso Caixa', palletT: 'Peso Pallet', bagT: 'Peso Bag' };

/** Lê o formulário aberto: valores, erros e o peso líquido. */
function lerItemCalc() {
  const ed = S.form.calc.editando;
  const t = Object.assign({}, tarasDoDia());
  const v = {}, erros = {};
  camposDoItem(ed.tipo).forEach(function (c) {
    const casas = c === 'caixas' ? 0 : c === 'pesagem' ? 1 : 2;
    const l = Calc.lerNumero(ed.campos[c], casas);
    if (!l.ok) erros[c] = l.erro;
    else if (l.vazio) erros[c] = 'Preencha ' + ROTULO_CAMPO[c] + '.';
    else if (c === 'pesagem' && !(l.valor > 0)) erros[c] = 'A pesagem deve ser maior que zero.';
    else v[c] = l.valor;
  });
  if (v.caixaT !== undefined) t.caixa = v.caixaT;
  if (v.palletT !== undefined) t.pallet = v.palletT;
  if (v.bagT !== undefined) t.bag = v.bagT;
  let liquido = null, erroGeral = '';
  if (!Object.keys(erros).length) {
    const it = ed.tipo === 'PALLET' ? { tipo: 'PALLET', caixas: v.caixas, pesagem: v.pesagem } : { tipo: 'BAG', pesagem: v.pesagem };
    liquido = liquidoItem(it, t);
    if (!(liquido > 0)) erroGeral = 'O peso líquido ficou zero ou negativo. Confira os valores.';
  }
  return { v: v, t: t, erros: erros, liquido: liquido, erroGeral: erroGeral };
}

function renderCalc() {
  const c = S.form.calc;
  const t = tarasDoDia();
  const ed = c.editando;
  let h = '<div class="modal-titulo">Calcular peso líquido</div>';

  // pesos de caixa, pallet e bag desta entrega, cada um com botão de editar
  h += '<div class="taras">' + Object.keys(TARAS).map(function (n) {
    if (c.editTara === n) {
      return '<div class="tara editando"><span>' + TARAS[n].rot + '</span>' +
        '<input id="ct-valor" class="entrada entrada-tara" type="text" inputmode="decimal" autocomplete="off" value="' +
        esc(t[n] !== undefined ? numParaCampo(t[n]) : numParaCampo(S.tarasPadrao[n])) + '"><span class="unidade-p">kg</span>' +
        '<button class="btn btn-verde btn-p" data-acao="calc-tara-ok" data-tara="' + n + '">OK</button>' +
        '<button class="btn btn-cinza btn-p" data-acao="calc-tara-cancelar">✕</button></div>';
    }
    return '<div class="tara"><span>' + TARAS[n].rot + ': <b>' + fmtTara(t[n]) + '</b></span>' +
      '<button class="btn btn-editar" data-acao="calc-tara-editar" data-tara="' + n + '" aria-label="Editar ' + TARAS[n].rot + '">✎</button></div>';
  }).join('') + '</div>' +
  '<div class="erro-tara" id="ct-erro"></div>';

  // lista dos pallets e bags já confirmados
  let nP = 0, nB = 0;
  h += '<div class="itens-calc">' + (c.itens.length ? c.itens.map(function (it, i) {
    const num = it.tipo === 'PALLET' ? ++nP : ++nB;
    const desc = it.tipo === 'PALLET'
      ? it.caixas + ' cx · pesagem ' + fmtKgCalc(it.pesagem)
      : 'pesagem ' + fmtKgCalc(it.pesagem);
    return '<button class="item-calc' + (ed && ed.idx === i ? ' ativo' : '') + '" data-acao="calc-editar" data-idx="' + i + '">' +
      '<span class="ic-nome">' + (it.tipo === 'PALLET' ? 'Pallet ' : 'Bag ') + num + '</span>' +
      '<span class="ic-desc">' + desc + '</span>' +
      '<span class="ic-liq">' + fmtKgCalc(liquidoItem(it, t)) + '</span><span class="ic-edit">✎</span></button>';
  }).join('') : '<div class="calc-vazio">Adicione os pallets e bags desta entrega.</div>') + '</div>';

  // formulário do pallet/bag sendo adicionado ou editado
  if (ed) {
    const nome = ed.tipo === 'PALLET' ? 'Pallet' : 'Bag';
    h += '<div class="form-item">' +
      '<div class="fi-titulo">' + (ed.idx < 0 ? 'Novo ' : 'Editar ') + nome + '</div>' +
      '<div class="fi-campos">' + camposDoItem(ed.tipo).map(function (cp) {
        const tara = /T$/.test(cp);
        return '<label class="fi-campo' + (tara ? ' fi-tara' : '') + '"><span>' + ROTULO_CAMPO[cp] + (tara ? ' <small>(vale para toda a entrega)</small>' : '') + '</span>' +
          '<input id="cf-' + cp + '" class="entrada entrada-calc" type="text" inputmode="' + (cp === 'caixas' ? 'numeric' : 'decimal') + '"' +
          ' autocomplete="off" enterkeyhint="next" value="' + esc(ed.campos[cp] || '') + '">' +
          '<span class="fi-erro" id="cfe-' + cp + '"></span></label>';
      }).join('') + '</div>' +
      '<div class="fi-liq" id="cf-liq"></div>' +
      '<div class="fi-botoes">' +
      '<button class="btn btn-grande btn-verde" data-acao="calc-confirmar">✔ Confirmar ' + nome + '</button>' +
      (ed.idx >= 0 ? '<button class="btn btn-grande btn-vermelho" data-acao="calc-excluir">Excluir</button>' : '') +
      '<button class="btn btn-grande btn-cinza" data-acao="calc-cancelar-item">Cancelar</button>' +
      '</div></div>';
  } else {
    h += '<div class="botoes-add">' +
      '<button class="btn btn-grande btn-contorno" data-acao="calc-add" data-tipo="PALLET">+ Pallet</button>' +
      '<button class="btn btn-grande btn-contorno" data-acao="calc-add" data-tipo="BAG">+ Bag</button></div>';
  }

  // total e conclusão
  h += '<div class="calc-total"><span>Peso líquido total</span><b>' + fmtKgCalc(totalCalc()) + '</b></div>' +
    '<div class="fi-botoes">' +
    '<button class="btn btn-grande btn-verde" data-acao="calc-concluir"' + (!c.itens.length || ed ? ' disabled' : '') + '>Usar no Peso Total</button>' +
    '<button class="btn btn-grande btn-cinza" data-acao="calc-fechar">Fechar</button></div>' +
    (ed ? '<div class="calc-aviso">Confirme ou cancele o ' + (ed.tipo === 'PALLET' ? 'pallet' : 'bag') + ' aberto para concluir.</div>' : '');

  $('#modal-calc-caixa').innerHTML = h;
  if (ed) atualizarItemCalc(false);
}

/** Atualiza o peso líquido do formulário enquanto digita. */
function atualizarItemCalc(mostrarErros) {
  const ed = S.form.calc.editando;
  if (!ed) return;
  const r = lerItemCalc();
  camposDoItem(ed.tipo).forEach(function (cp) {
    const e = $('#cfe-' + cp);
    const vazio = !String(ed.campos[cp] || '').trim();
    const msg = r.erros[cp] && (mostrarErros || !vazio) ? r.erros[cp] : '';
    if (e) e.textContent = msg;
    const inp = $('#cf-' + cp);
    if (inp) inp.classList.toggle('invalida', !!msg);
  });
  const el = $('#cf-liq');
  if (r.erroGeral) { el.className = 'fi-liq erro'; el.textContent = r.erroGeral; }
  else if (r.liquido !== null) { el.className = 'fi-liq'; el.innerHTML = 'Peso líquido: <b>' + fmtKgCalc(r.liquido) + '</b>'; }
  else { el.className = 'fi-liq vazio'; el.textContent = 'Preencha os campos para ver o peso líquido.'; }
  return r;
}

function confirmarItemCalc() {
  const c = S.form.calc, ed = c.editando;
  const r = atualizarItemCalc(true);
  if (Object.keys(r.erros).length || r.erroGeral || r.liquido === null) return;
  // taras pedidas no primeiro pallet/bag da entrega ficam guardadas para os próximos
  if (r.v.caixaT !== undefined) definirTara('caixa', r.v.caixaT);
  if (r.v.palletT !== undefined) definirTara('pallet', r.v.palletT);
  if (r.v.bagT !== undefined) definirTara('bag', r.v.bagT);
  const it = ed.tipo === 'PALLET' ? { tipo: 'PALLET', caixas: r.v.caixas, pesagem: r.v.pesagem } : { tipo: 'BAG', pesagem: r.v.pesagem };
  if (ed.idx >= 0) c.itens[ed.idx] = it; else c.itens.push(it);
  c.editando = null;
  S.form.alterado = true;
  renderCalc();
}

/* ---- janela "Outro motorista": digitar ou escolher um dos já usados (mais recentes primeiro) ---- */
function abrirModalMot() {
  const doDia = motoristasDoDia().map(semAcento);
  S.mmLista = S.motoristasHist
    .map(function (m) { return m.nome; })
    .filter(function (n) { return doDia.indexOf(semAcento(n)) < 0; });
  $('#mm-nome').value = '';
  $('#mm-erro').textContent = '';
  renderListaModalMot();
  $('#modal-mot').hidden = false;
  history.pushState({ tela: 'parceiro', id: S.parceiroId, modal: 'mot' }, '');
  if (!S.mmLista.length) setTimeout(function () { $('#mm-nome').focus(); }, 50);
}

function renderListaModalMot() {
  const termo = semAcento($('#mm-nome').value.trim());
  const nomes = (S.mmLista || []).filter(function (n) { return !termo || semAcento(n).indexOf(termo) >= 0; });
  $('#mm-rotulo').hidden = !(S.mmLista || []).length;
  $('#mm-lista').innerHTML = nomes.length
    ? nomes.map(function (n) { return '<button class="btn" data-acao="mm-escolher" data-valor="' + esc(n) + '">🚚 ' + esc(n) + '</button>'; }).join('')
    : ((S.mmLista || []).length ? '<div class="mm-vazio">Nenhum nome parecido. Toque em “Usar” para o nome digitado.</div>' : '');
}

function fecharModalMot(nome) {
  if (nome) {
    S.form.motorista = nome;
    S.form.alterado = true;
    $('#e-mot').textContent = '';
    renderMotoristas();
  }
  $('#modal-mot').hidden = true;
  $('#mm-nome').blur();
  if (history.state && history.state.modal === 'mot') history.back();
}

function usarNomeDigitado() {
  const nome = normalizarNome($('#mm-nome').value);
  if (!nome) { $('#mm-erro').textContent = 'Digite o nome do motorista.'; $('#mm-nome').focus(); return; }
  // mesmo nome com outra grafia: usa o já conhecido
  const conhecido = motoristasDoDia().concat(S.motoristasHist.map(function (m) { return m.nome; }))
    .find(function (n) { return semAcento(n) === semAcento(nome); });
  fecharModalMot(conhecido || nome);
}

function atualizarBotoesForm() {
  const f = S.form;
  const penLido = Calc.lerNumero(f.pen, 2);
  document.querySelectorAll('#pen-rapidos button').forEach(function (b) {
    b.classList.toggle('ativo', penLido.ok && (penLido.valor || 0) === Number(b.dataset.valor));
  });
  const bmax = document.querySelector('.btn-desc-max');
  if (bmax) bmax.classList.toggle('ativo', f.modo === 'MAXIMO');
}

/** Valor do desconto que está valendo agora (o máximo calculado, ou o digitado). */
function descontoAtual() {
  const f = S.form;
  if (f.modo === 'MAXIMO') {
    const p = parceiroPorId(S.parceiroId), ent = entregaAtual();
    return Calc.calcular(lerFormulario().entrada(p, ent)).desconto_maximo || 0;
  }
  const d = Calc.lerNumero(f.desc, 2);
  return d.ok ? (d.valor || 0) : 0;
}

/** Botões + / − : soma ao valor atual, sem passar do máximo nem ficar abaixo de zero. */
function somarDesconto(delta) {
  const p = parceiroPorId(S.parceiroId), ent = entregaAtual();
  const r = Calc.calcular(Object.assign(lerFormulario().entrada(p, ent), { desconto_modo: 'NENHUM' }));
  let novo = Calc.arred(Math.max(0, descontoAtual() + delta), 2);
  if (r.desconto_maximo > 0 && novo > r.desconto_maximo) {
    novo = r.desconto_maximo;
    aviso('Limitado ao máximo: ' + fmtR(novo), 2500);
  }
  definirDesconto(novo > 0 ? 'VALOR' : 'NENHUM', novo);
}

function definirDesconto(modo, valor) {
  const f = S.form;
  f.modo = modo;
  f.desc = modo === 'VALOR' && valor > 0 ? numParaCampo(valor) : '';
  f.alterado = true;
  const campo = $('#f-desc');
  if (campo) campo.value = f.desc;
  atualizarBotoesForm();
  atualizarResultado();
}

/** Lê os campos do formulário; devolve valores e erros por campo. */
function lerFormulario() {
  const f = S.form;
  const peso = Calc.lerNumero(f.peso, 1);
  const pen = Calc.lerNumero(f.pen, 2);
  const desc = f.modo === 'MAXIMO' ? { ok: true, valor: null, vazio: true } : Calc.lerNumero(f.desc, 2);
  return {
    peso: peso, pen: pen, desc: desc,
    entrada: function (p, ent) {
      return {
        peso_total_kg: peso.ok ? peso.valor : null,
        participacao_pct: p.participacao_pct,
        penalidade_pct: pen.ok ? (pen.valor || 0) : 0,
        preco_base: ent.preco_base,
        preco_ajustado: ent.preco_ajustado,
        tem_ie: p.tem_ie,
        desconto_modo: f.modo === 'MAXIMO' ? 'MAXIMO' : (desc.ok && desc.valor > 0 ? 'VALOR' : 'NENHUM'),
        desconto_informado: desc.ok ? (desc.valor || 0) : 0,
      };
    },
  };
}

function marcarCampo(idCampo, idErro, leitura) {
  const campo = $(idCampo);
  const erro = $(idErro);
  if (!campo || !erro) return;
  campo.classList.toggle('invalida', !leitura.ok);
  erro.textContent = leitura.ok ? '' : leitura.erro;
}

function atualizarResultado() {
  const p = parceiroPorId(S.parceiroId);
  const ent = entregaAtual();
  const el = $('#resultado');
  if (!p || !ent || !el) return;
  const lf = lerFormulario();
  marcarCampo('#f-peso', '#e-peso', lf.peso);
  marcarCampo('#f-desc', '#e-desc', lf.desc);

  const r = Calc.calcular(lf.entrada(p, ent));
  // "Máximo": o campo mostra o valor máximo calculado (acompanha peso e penalidade)
  if (S.form.modo === 'MAXIMO') {
    const campo = $('#f-desc');
    if (campo && document.activeElement !== campo) campo.value = r.desconto_maximo > 0 ? numParaCampo(r.desconto_maximo) : '';
  }
  let valor = fmtR(0), dica = '', erro = '';
  if (r.erros.length) {
    erro = r.erros.map(function (x) {
      return /máximo/.test(x) ? 'O desconto passa do máximo possível (' + fmtR(r.desconto_maximo) + ').' : x;
    }).join(' ');
    if (r.valor_bruto_parceiro) valor = fmtR(Math.max(r.valor_parceiro, 0));
  } else if (r.falta_peso || !lf.peso.ok) {
    dica = 'Digite o peso para ver o valor';
  } else {
    valor = fmtR(r.valor_parceiro);
    dica = r.desconto_aplicado > 0 ? 'Já descontados os impostos e o desconto'
      : 'Já descontados os impostos (' + fmtPct(Calc.IMPOSTO_PCT) + ')';
  }
  el.classList.toggle('com-erro', !!erro);
  // linha de baixo: mensagem · preço da entrega
  const preco = 'Preço R$' + fmtNum(ent.preco_ajustado, 2) + '/kg';
  el.innerHTML = '<div class="rot">PARCEIRO RECEBE</div><div class="val">' + valor + '</div>' +
    (erro ? '<div class="recebe-erro">' + esc(erro) + '</div>'
      : '<div class="recebe-dica">' + (dica ? esc(dica) + ' · ' : '') + '<span class="recebe-preco">' + esc(preco) + '</span></div>');
}


function montarRegistro(p, ent, situacao, r, extra) {
  const k = chave(ent.data_entrega, p.id_parceiro);
  const ant = S.lanc[k];
  return {
    data_entrega: ent.data_entrega,
    id_parceiro: p.id_parceiro,
    nome: p.nome,
    apelido: p.apelido,
    fazenda: p.fazenda,
    participacao_pct: p.participacao_pct,
    tem_ie: p.tem_ie,
    preco_base: ent.preco_base,
    preco_ajustado: ent.preco_ajustado,
    situacao: situacao,
    peso_total_kg: extra.peso_total_kg,
    penalidade_pct: extra.penalidade_pct,
    desconto_modo: extra.desconto_modo,
    desconto_informado: extra.desconto_informado,
    desconto_aplicado: r.desconto_aplicado,
    peso_parceiro: r.peso_parceiro,
    peso_nome_proprietario: r.peso_nome_proprietario,
    peso_nome_outro: r.peso_nome_outro,
    peso_proprietario: r.peso_proprietario,
    valor_parceiro: r.valor_parceiro,
    valor_proprietario: r.valor_proprietario,
    imposto_pct: situacao === 'ENTREGOU' ? Calc.IMPOSTO_PCT : 0,
    valor_imposto: r.valor_imposto,
    motorista: extra.motorista || '',
    observacoes: extra.observacoes !== undefined ? extra.observacoes : ((S.form && S.form.obs) || '').trim(),
    atualizado_em: new Date().toISOString(),
    revisao: (ant && ant.revisao ? ant.revisao : 0) + 1,
    dispositivo: (S.config && S.config.dispositivo) || 'tablet',
    _pendente: true,
    _erro: null,
  };
}

async function salvarEntrega() {
  const p = parceiroPorId(S.parceiroId);
  const ent = entregaAtual();
  if (!p || !ent) return;
  const lf = lerFormulario();
  atualizarResultado();
  if (!lf.peso.ok || !lf.pen.ok || !lf.desc.ok) { aviso('Corrija os campos em vermelho.', 3500); return; }
  if (lf.peso.vazio || !(lf.peso.valor > 0)) {
    marcarCampo('#f-peso', '#e-peso', { ok: false, erro: 'Informe o peso total.' });
    $('#f-peso').focus();
    aviso('Informe o peso total.', 3000);
    return;
  }
  const entrada = lf.entrada(p, ent);
  const r = Calc.calcular(entrada);
  if (r.erros.length || r.falta_peso) { aviso(r.erros[0] || 'Confira os dados.', 4000); return; }

  let motorista = normalizarNome(S.form.motorista);
  if (!motorista) {
    $('#e-mot').textContent = 'Escolha o motorista.';
    aviso('Escolha o motorista.', 3000);
    return;
  }
  // Mesmo nome com outra grafia (maiúsculas/acentos) usa o nome já existente
  const existente = motoristasDoDia().find(function (m) { return semAcento(m) === semAcento(motorista); });
  if (existente) motorista = existente;

  let modo = 'MAXIMO';
  let informado = 0;
  if (S.form.modo !== 'MAXIMO') {
    informado = lf.desc.valor || 0;
    modo = informado > 0 ? 'VALOR' : 'NENHUM';
  }
  registrarMotoristas([{ nome: motorista, ultima_data: ent.data_entrega }]);
  const reg = montarRegistro(p, ent, 'ENTREGOU', r, {
    peso_total_kg: lf.peso.valor,
    penalidade_pct: entrada.penalidade_pct,
    desconto_modo: modo,
    desconto_informado: informado,
    motorista: motorista,
  });
  if (S.form.calc && S.form.calc.itens.length) reg._calc = S.form.calc.itens.slice();
  await gravarRegistro(reg, 'Salvo ✔ ' + nomeExibicao(p));
}

async function marcarNaoEntregou() {
  const p = parceiroPorId(S.parceiroId);
  const ent = entregaAtual();
  if (!p || !ent) return;
  const zeros = Calc.calcular({}); // todos os valores zerados
  const reg = montarRegistro(p, ent, 'NAO_ENTREGOU', zeros, {
    peso_total_kg: 0, penalidade_pct: 0, desconto_modo: 'NENHUM', desconto_informado: 0,
  });
  await gravarRegistro(reg, nomeExibicao(p) + ': não entregou');
}

/** Marca como NÃO ENTREGOU todos os parceiros de uma fazenda que ainda não foram lançados. */
async function marcarFazendaNaoEntregou(nomeFazenda) {
  const ent = entregaAtual();
  if (!ent) return;
  const alvo = semAcento(nomeFazenda);
  const restantes = parceirosVisiveis().filter(function (p) {
    return semAcento(normalizarNome(p.fazenda) || 'Sem fazenda') === alvo && !registroDe(p.id_parceiro);
  });
  if (!restantes.length) return;
  const ok = await confirmar(
    (restantes.length === 1
      ? 'Marcar o parceiro que falta de ' + nomeFazenda + ' como NÃO ENTREGOU?'
      : 'Marcar os ' + restantes.length + ' parceiros que faltam de ' + nomeFazenda + ' como NÃO ENTREGOU?') +
    '\n\nQuem já foi lançado não é alterado.',
    'Não entregou', 'btn-laranja');
  if (!ok) return;
  const zeros = Calc.calcular({});
  restantes.forEach(function (p) {
    const reg = montarRegistro(p, ent, 'NAO_ENTREGOU', zeros, {
      peso_total_kg: 0, penalidade_pct: 0, desconto_modo: 'NENHUM', desconto_informado: 0, observacoes: '',
    });
    S.lanc[chave(reg.data_entrega, reg.id_parceiro)] = reg;
  });
  try { await salvarEstado(); } catch (e) { return; }
  aviso(nomeFazenda + ': ' + restantes.length + (restantes.length === 1 ? ' marcado' : ' marcados') + ' como não entregou');
  renderLista();
  enviarPendentes();
}

async function gravarRegistro(reg, mensagem) {
  S.lanc[chave(reg.data_entrega, reg.id_parceiro)] = reg;
  try { await salvarEstado(); } catch (e) { return; }
  S.form.alterado = false;
  aviso(mensagem);
  voltarParaLista();
  enviarPendentes();
}

function voltarParaLista() {
  if (history.state && history.state.tela && history.state.tela !== 'lista') {
    history.back(); // o evento popstate desenha a lista
  } else {
    S.tela = 'lista';
    render();
  }
}

/* ---------------------------- Configurações ---------------------------- */
function abrirConfig() {
  if (S.tela === 'config') return;
  if (S.tela === 'parceiro' && S.form && S.form.alterado) {
    aviso('Salve ou volte da tela do parceiro primeiro.', 3000);
    return;
  }
  S.tela = 'config';
  history.pushState({ tela: 'config' }, '');
  render();
  window.scrollTo(0, 0);
}

function renderConfig() {
  const c = S.config || { url: '', chave: '', dispositivo: 'tablet-1' };
  $('#tela').innerHTML =
    '<div class="config">' +
    '<div class="cab-parceiro">' +
    (S.config ? '<button class="btn btn-voltar" data-acao="voltar" aria-label="Voltar">' + SETA_VOLTAR + '</button>' : '') +
    '<div class="nomes"><h1>Configurações</h1></div></div>' +
    '<div class="campo"><label for="c-url">Endereço do script (App da Web)</label>' +
    '<input id="c-url" class="entrada" type="url" autocomplete="off" placeholder="https://script.google.com/macros/s/.../exec" value="' + esc(c.url) + '">' +
    '<div class="ajuda">Copiado do Apps Script em Implantar › Gerenciar implantações. Termina em /exec.</div></div>' +
    '<div class="campo"><label for="c-chave">Chave de acesso</label>' +
    '<input id="c-chave" class="entrada" type="text" autocomplete="off" autocapitalize="characters" value="' + esc(c.chave) + '">' +
    '<div class="ajuda">Na planilha: menu App de Pesagem › Mostrar chave de acesso.</div></div>' +
    '<div class="campo"><label for="c-disp">Nome deste tablet</label>' +
    '<input id="c-disp" class="entrada" type="text" autocomplete="off" value="' + esc(c.dispositivo) + '"></div>' +
    '<div class="acoes-form">' +
    '<button class="btn btn-grande btn-verde" data-acao="salvar-config">Salvar</button>' +
    '<button class="btn btn-grande btn-contorno" data-acao="testar-conexao">Testar conexão</button>' +
    '</div>' +
    '<div id="config-avisos" style="margin-top:20px"></div>' +
    '<div class="zona-perigo"><button class="btn btn-link-perigo" data-acao="apagar-dados">Apagar dados deste tablet</button></div>' +
    '<div class="info-tec">Versão ' + VERSAO_APP +
    ' · Armazenamento protegido: ' + (S.armazenamentoPersistente === null ? '?' : S.armazenamentoPersistente ? 'sim' : 'não') +
    '</div></div>';
  renderAvisosConfig();
}

function renderAvisosConfig() {
  const el = $('#config-avisos');
  if (!el) return;
  const avisos = (S.dados && S.dados.avisos) || [];
  el.innerHTML = avisos.length
    ? '<b>Avisos da última sincronização (corrija na planilha):</b><ul class="lista-avisos">' +
      avisos.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>'
    : '';
}

function lerCamposConfig() {
  return {
    url: $('#c-url').value.trim(),
    chave: $('#c-chave').value.trim().toUpperCase(),
    dispositivo: $('#c-disp').value.trim() || 'tablet-1',
  };
}

function validarConfig(c) {
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(c.url)) {
    return 'O endereço deve começar com https://script.google.com/ e terminar com /exec';
  }
  if (!c.chave) return 'Digite a chave de acesso.';
  return null;
}

async function salvarConfig() {
  const c = lerCamposConfig();
  const erro = validarConfig(c);
  if (erro) { aviso(erro, 4500); return; }
  S.config = c;
  await DB.set('config', c);
  aviso('Configurações salvas ✔');
  if (!S.dados) {
    S.tela = 'lista';
    history.replaceState({ tela: 'lista' }, '');
    render();
    sincronizar();
  } else {
    voltarParaLista();
  }
}

async function testarConexao() {
  const c = lerCamposConfig();
  const erro = validarConfig(c);
  if (erro) { aviso(erro, 4500); return; }
  aviso('Testando...', 10000);
  try {
    const r = await chamar({ acao: 'ping' }, c, 20000);
    if (r.tipo === 'escritorio') { aviso('Esta é a chave do ESCRITÓRIO. Use a chave do TABLET.', 5000); return; }
    aviso('Conexão OK ✔ Toque em Salvar.', 3500);
  } catch (e) {
    aviso(e.message, 5000);
  }
}

/**
 * Link de configuração: <site>/#url=<endereço do script>&chave=<chave do tablet>[&nome=<nome do tablet>]
 * Lê, salva e tira os dados do endereço (a parte depois de # nunca é enviada ao servidor do site).
 * Devolve true se a configuração mudou.
 */
async function aplicarLinkConfig() {
  const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  if (!h.has('url') && !h.has('chave')) return false;
  history.replaceState(history.state, '', location.pathname + location.search);
  const c = {
    url: (h.get('url') || '').trim(),
    chave: (h.get('chave') || '').trim().toUpperCase(),
    dispositivo: (h.get('nome') || (S.config && S.config.dispositivo) || 'tablet-1').trim(),
  };
  const erro = validarConfig(c);
  if (erro) { aviso('Link de configuração inválido. ' + erro, 8000); return false; }
  if (S.config && S.config.url === c.url && S.config.chave === c.chave) {
    if (c.dispositivo !== S.config.dispositivo) { S.config.dispositivo = c.dispositivo; await DB.set('config', S.config); }
    aviso('Este tablet já está configurado ✔', 3500);
    return false;
  }
  if (S.config && !(await confirmar('Este link traz outra configuração (endereço/chave da planilha).\n\nSubstituir a configuração deste tablet?',
    'Substituir', 'btn-verde', 'Manter a atual'))) return false;
  S.config = c;
  await DB.set('config', c);
  aviso('Tablet configurado pelo link ✔', 4000);
  return true;
}

async function apagarDados() {
  const pend = pendencias();
  if (pend.lancamentos + pend.inativacoes + pend.erros.length > 0) {
    aviso('Há alterações não enviadas. Envie antes de apagar.', 4500);
    return;
  }
  const ok = await confirmar('Apagar os dados deste tablet?\n\nA planilha não é alterada. Será preciso sincronizar de novo.',
    'Apagar', 'btn-vermelho');
  if (!ok) return;
  S.dados = null; S.lanc = {}; S.inativacoes = []; S.data = null; S.ultimoEnvio = null;
  await salvarEstado();
  aviso('Dados apagados.');
  renderConfig();
  renderFaixas();
}

/* =========================================================================
 * Comunicação com a planilha
 * ========================================================================= */
class ErroRede extends Error {}

async function chamar(payload, cfg, tempoMs) {
  cfg = cfg || S.config;
  if (!cfg || !cfg.url) throw new Error('App não configurado.');
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, tempoMs || 45000);
  let resp;
  try {
    resp = await fetch(cfg.url, {
      method: 'POST',
      // text/plain evita a verificação CORS "preflight", que o Apps Script não atende
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({}, payload, { chave: cfg.chave, dispositivo: cfg.dispositivo })),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    // O navegador não diz se foi falta de internet ou bloqueio do Google (permissão/CORS).
    // Testa se o endereço responde de alguma forma: se responder, o problema é a implantação.
    let alcancavel = false;
    try {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(function () { ctrl2.abort(); }, 15000);
      await fetch(cfg.url + '?acao=ping', { mode: 'no-cors', cache: 'no-store', signal: ctrl2.signal });
      clearTimeout(t2);
      alcancavel = true;
    } catch (e2) { /* sem rede de fato */ }
    if (alcancavel) {
      throw new Error('A planilha recusou o acesso. No Apps Script, confira a implantação: ' +
        'Executar como "Eu" e Quem pode acessar "Qualquer pessoa" (depois implante uma Nova versão).');
    }
    throw new ErroRede('Sem conexão com a internet.');
  } finally {
    clearTimeout(t);
  }
  let dados;
  try {
    dados = await resp.json();
  } catch (e) {
    throw new Error('Resposta inválida. Confira o endereço do script e se ele foi implantado para "Qualquer pessoa".');
  }
  if (!dados || !dados.ok) throw new Error((dados && dados.erro) || 'Erro no servidor.');
  return dados;
}

function limparRegistro(r) {
  const o = {};
  Object.keys(r).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = r[k]; });
  return o;
}

async function enviarPendentes(op) {
  op = op || {};
  if (S.enviando || !S.config || !S.config.url) return;
  const lista = Object.values(S.lanc).filter(function (r) { return r._pendente && (op.manual || !r._erro); });
  const inat = S.inativacoes.slice();
  if (!lista.length && !inat.length) return;

  S.enviando = true;
  renderFaixas();
  const versoes = {};
  lista.forEach(function (r) { versoes[chave(r.data_entrega, r.id_parceiro)] = r.atualizado_em; });
  try {
    const resp = await chamar({ acao: 'enviar', lancamentos: lista.map(limparRegistro), inativacoes: inat });
    const agora = new Date().toISOString();
    (resp.aceitos || []).forEach(function (k) {
      const r = S.lanc[k];
      // só marca como enviado se não foi editado enquanto enviava
      if (r && r.atualizado_em === versoes[k]) { r._pendente = false; r._erro = null; r._enviado_em = agora; }
    });
    (resp.rejeitados || []).forEach(function (x) {
      const r = S.lanc[x.chave];
      if (r && r.atualizado_em === versoes[x.chave]) r._erro = x.motivo;
    });
    const ok = new Set(resp.inativados || []);
    S.inativacoes = S.inativacoes.filter(function (i) { return !ok.has(i.id_parceiro); });
    S.ultimoEnvio = agora;
    S.erroEnvio = null;
    await salvarEstado();
  } catch (e) {
    S.erroEnvio = e instanceof ErroRede ? 'rede' : e.message;
    if (op.lancarErro) throw e;
  } finally {
    S.enviando = false;
    renderFaixas();
    if (op.manual && !op.silencioso) mostrarStatus();
  }
}

async function sincronizar() {
  if (S.sincronizando) return;
  if (!S.config || !S.config.url) { abrirConfig(); aviso('Configure o app primeiro.'); return; }
  S.sincronizando = true;
  renderFaixas();
  mostrarStatus(60000);
  try {
    await enviarPendentes({ manual: true, silencioso: true, lancarErro: true });
    const d = await chamar({ acao: 'baixar' });
    aplicarDownload(d);
    await salvarEstado();
    S.sincronizando = false;
    renderFaixas();
    mostrarStatus();
    if (d.avisos && d.avisos.length) aviso('Sincronizado, mas a planilha tem avisos: veja em Configurações.', 5000);
  } catch (e) {
    S.sincronizando = false;
    esconderStatus();
    aviso(e instanceof ErroRede ? 'Sem internet. Não foi possível sincronizar.' : e.message, e instanceof ErroRede ? 5000 : 9000);
  } finally {
    S.sincronizando = false;
    renderFaixas();
    if (S.tela === 'lista') renderLista();
    else if (S.tela === 'config') renderAvisosConfig();
  }
}

function aplicarDownload(d) {
  const entregas = (d.entregas || []).slice().sort(function (a, b) {
    return a.data_entrega < b.data_entrega ? -1 : a.data_entrega > b.data_entrega ? 1 : 0;
  });
  S.dados = {
    parceiros: d.parceiros || [],
    entregas: entregas,
    avisos: d.avisos || [],
    sincronizado_em: new Date().toISOString(),
  };
  const abertas = new Set(entregas.map(function (e) { return e.data_entrega; }));
  registrarMotoristas((d.motoristas || []).concat((d.lancamentos || []).map(function (l) {
    return { nome: l.motorista, ultima_data: l.data_entrega };
  })));
  // Lançamentos da planilha: só substituem os locais que não têm alteração pendente
  (d.lancamentos || []).forEach(function (rs) {
    const k = chave(rs.data_entrega, rs.id_parceiro);
    const loc = S.lanc[k];
    if (!loc || !loc._pendente) {
      const calc = loc && loc._calc && loc.atualizado_em === rs.atualizado_em ? loc._calc : undefined;
      S.lanc[k] = Object.assign({}, rs, { _pendente: false, _erro: null, _enviado_em: rs.atualizado_em, _calc: calc });
    }
  });
  // Descarta lançamentos já enviados de entregas que não estão mais abertas
  Object.keys(S.lanc).forEach(function (k) {
    const r = S.lanc[k];
    if (!r._pendente && !abertas.has(r.data_entrega)) delete S.lanc[k];
  });
  const hoje = hojeISO();
  if (abertas.has(hoje)) S.data = hoje;
  else if (!S.data || !abertas.has(S.data)) S.data = entregas.length ? entregas[entregas.length - 1].data_entrega : null;
}

/* =========================================================================
 * Eventos
 * ========================================================================= */
const ACOES = {
  'sincronizar': sincronizar,
  'abrir-config': abrirConfig,
  'voltar': function () { history.back(); },
  'abrir-parceiro': function (el) { abrirParceiro(el.dataset.id); },
  'data': function (el) {
    S.data = el.dataset.valor; salvarEstado().catch(function () {}); render();
  },
  'filtro': function (el) { S.filtro = el.dataset.valor; renderLista(); },
  'pen': function (el) {
    S.form.pen = el.dataset.valor; S.form.alterado = true;
    atualizarBotoesForm(); atualizarResultado();
  },
  'desc-zerar': function () { definirDesconto('NENHUM', 0); },
  'desc-maximo': function () { definirDesconto('MAXIMO', 0); },
  'desc-somar': function (el) { somarDesconto(Number(el.dataset.valor)); },
  'mot': function (el) {
    S.form.motorista = el.dataset.valor; S.form.alterado = true;
    $('#e-mot').textContent = '';
    renderMotoristas();
  },
  'mot-novo': abrirModalMot,
  'mm-escolher': function (el) { fecharModalMot(el.dataset.valor); },
  'mm-usar': usarNomeDigitado,
  'mm-cancelar': function () { fecharModalMot(null); },
  'calc-abrir': abrirCalc,
  'calc-fechar': fecharCalc,
  'calc-add': function (el) {
    const tipo = el.dataset.tipo;
    const campos = {};
    const t = tarasDoDia();
    // primeiro da entrega: taras já vêm preenchidas com os últimos valores usados
    ['caixa', 'pallet', 'bag'].forEach(function (n) {
      const v = t[n] !== undefined ? t[n] : S.tarasPadrao[n];
      if (v !== undefined) campos[TARAS[n].campo] = numParaCampo(v);
    });
    S.form.calc.editando = { idx: -1, tipo: tipo, campos: campos };
    S.form.calc.editTara = null;
    renderCalc();
    const primeiro = document.querySelector('#modal-calc .entrada-calc');
    if (primeiro) primeiro.focus();
  },
  'calc-editar': function (el) {
    const idx = Number(el.dataset.idx);
    const it = S.form.calc.itens[idx];
    S.form.calc.editando = { idx: idx, tipo: it.tipo, campos: { caixas: it.caixas !== undefined ? String(it.caixas) : '', pesagem: numParaCampo(it.pesagem) } };
    S.form.calc.editTara = null;
    renderCalc();
  },
  'calc-confirmar': confirmarItemCalc,
  'calc-cancelar-item': function () { S.form.calc.editando = null; renderCalc(); },
  'calc-excluir': async function () {
    const c = S.form.calc, idx = c.editando.idx;
    $('#modal-calc').hidden = true;
    const ok = await confirmar('Excluir este ' + (c.itens[idx].tipo === 'PALLET' ? 'pallet' : 'bag') + '?', 'Excluir', 'btn-vermelho');
    $('#modal-calc').hidden = false;
    if (!ok) return;
    c.itens.splice(idx, 1);
    c.editando = null;
    S.form.alterado = true;
    renderCalc();
  },
  'calc-tara-editar': function (el) { S.form.calc.editTara = el.dataset.tara; renderCalc(); $('#ct-valor').focus(); $('#ct-valor').select(); },
  'calc-tara-cancelar': function () { S.form.calc.editTara = null; renderCalc(); },
  'calc-tara-ok': function (el) {
    const l = Calc.lerNumero($('#ct-valor').value, 2);
    if (!l.ok || l.vazio) { $('#ct-erro').textContent = l.ok ? 'Digite o peso.' : l.erro; return; }
    definirTara(el.dataset.tara, l.valor);
    S.form.calc.editTara = null;
    renderCalc();
  },
  'calc-concluir': function () {
    const total = totalCalc();
    if (!(total > 0)) { aviso('O peso líquido total deve ser maior que zero.', 3500); return; }
    S.form.peso = numParaCampo(total);
    S.form.alterado = true;
    $('#f-peso').value = S.form.peso;
    fecharCalc();
    atualizarBotoesForm();
    atualizarResultado();
    aviso('Peso total: ' + fmtKgCalc(total), 2500);
  },
  'salvar': salvarEntrega,
  'nao-entregou': marcarNaoEntregou,
  'nao-entregou-fazenda': function (el) { marcarFazendaNaoEntregou(el.dataset.fazenda); },
  'status': function () {
    mostrarStatus();
    if (estadoSync().totalPend || estadoSync().erros) enviarPendentes({ manual: true });
  },
  'fechar-status': esconderStatus,
  'salvar-config': salvarConfig,
  'testar-conexao': testarConexao,
  'apagar-dados': apagarDados,
  'atualizar-app': function () {
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (reg && reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      else location.reload();
    });
  },
};

document.addEventListener('click', function (ev) {
  const el = ev.target.closest('[data-acao]');
  if (!el || el.disabled) return;
  const fn = ACOES[el.dataset.acao];
  if (fn) fn(el);
});

document.addEventListener('change', function (ev) {
  if (ev.target.id !== 'sel-data') return;
  S.data = ev.target.value;
  salvarEstado().catch(function () {});
  render();
});

document.addEventListener('input', function (ev) {
  const id = ev.target.id;
  if (id === 'busca') { S.busca = ev.target.value; renderGradeLista(); return; }
  if (!S.form) return;
  if (id === 'mm-nome') { $('#mm-erro').textContent = ''; renderListaModalMot(); return; }
  if (id.indexOf('cf-') === 0 && S.form && S.form.calc.editando) {
    S.form.calc.editando.campos[id.slice(3)] = ev.target.value;
    atualizarItemCalc(false);
    return;
  }
  if (id === 'ct-valor') { $('#ct-erro').textContent = ''; return; }
  const mapa = { 'f-peso': 'peso', 'f-desc': 'desc', 'f-obs': 'obs' };
  if (!mapa[id]) return;
  S.form[mapa[id]] = ev.target.value;
  S.form.alterado = true;
  if (id === 'f-desc') {
    // digitar no campo troca para "valor digitado" (ou sem desconto, se vazio/zero)
    const d = Calc.lerNumero(ev.target.value, 2);
    S.form.modo = d.ok && !(d.valor > 0) ? 'NENHUM' : 'VALOR';
  }
  if (id !== 'f-obs') { atualizarBotoesForm(); atualizarResultado(); }
});

// "Enter" no teclado numérico fecha o teclado para mostrar o resultado
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && ev.target.id === 'mm-nome') { ev.preventDefault(); usarNomeDigitado(); return; }
  if (ev.key === 'Enter' && ev.target.classList && ev.target.classList.contains('entrada-calc')) {
    ev.preventDefault();
    const campos = Array.prototype.slice.call(document.querySelectorAll('#modal-calc .entrada-calc'));
    const i = campos.indexOf(ev.target);
    if (i >= 0 && i < campos.length - 1) campos[i + 1].focus();
    else { ev.target.blur(); confirmarItemCalc(); }
    return;
  }
  if (ev.key === 'Enter' && ev.target.id === 'ct-valor') { ev.preventDefault(); const b = document.querySelector('[data-acao="calc-tara-ok"]'); if (b) b.click(); return; }
  if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('input.entrada')) {
    ev.preventDefault();
    ev.target.blur();
  }
});

// Botão "voltar" do Android
window.addEventListener('popstate', async function (ev) {
  const st = ev.state || { tela: 'lista' };
  if (!$('#modal').hidden) { $('#modal-nao').click(); }
  if (!$('#modal-mot').hidden) $('#modal-mot').hidden = true; // "voltar" fecha a janela do motorista
  if (!$('#modal-calc').hidden) $('#modal-calc').hidden = true; // ... e a calculadora (os itens ficam guardados)
  // continua na mesma tela do parceiro (ex.: janela do motorista fechada): nada a redesenhar
  if (S.tela === 'parceiro' && st.tela === 'parceiro' && st.id === S.parceiroId && S.form) return;
  if (S.tela === 'parceiro' && S.form && S.form.alterado && st.tela !== 'parceiro') {
    history.pushState({ tela: 'parceiro', id: S.parceiroId }, '');
    const sair = await confirmar('Sair sem salvar?\n\nO que foi digitado será perdido.',
      'Sair sem salvar', 'btn-vermelho', 'Continuar editando');
    if (sair) { S.form.alterado = false; history.back(); }
    return;
  }
  if (st.tela === 'parceiro' && st.id === S.parceiroId && S.form) S.tela = 'parceiro';
  else if (st.tela === 'config') S.tela = 'config';
  else { S.tela = 'lista'; S.form = null; }
  render();
});

window.addEventListener('online', function () { enviarPendentes(); });
// link de configuração colado com o app já aberto (só muda a parte depois de #)
window.addEventListener('hashchange', async function () {
  if (!/url=|chave=/.test(location.hash)) return;
  if (await aplicarLinkConfig()) { render(); sincronizar(); }
});
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') { renderFaixas(); enviarPendentes(); }
});

/* =========================================================================
 * Service worker (funcionamento offline e atualizações)
 * ========================================================================= */
function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  const tinhaControlador = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(function (reg) {
    // só avisa de atualização se o app já estava instalado (não na primeira abertura)
    const mostrar = function () { if (tinhaControlador) { S.atualizacaoDisponivel = true; renderFaixas(); } };
    if (reg.waiting && navigator.serviceWorker.controller) mostrar();
    reg.addEventListener('updatefound', function () {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', function () {
        if (w.state === 'installed' && navigator.serviceWorker.controller) mostrar();
      });
    });
    setInterval(function () { reg.update().catch(function () {}); }, 60 * 60 * 1000);
  }).catch(function () {});
  let recarregando = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!tinhaControlador || recarregando) return;
    recarregando = true;
    location.reload();
  });
}

/* =========================================================================
 * Início
 * ========================================================================= */
async function iniciar() {
  registrarSW();
  try {
    if (navigator.storage && navigator.storage.persist) {
      S.armazenamentoPersistente = await navigator.storage.persisted() || await navigator.storage.persist();
    }
  } catch (e) { /* sem suporte */ }

  try {
    S.config = (await DB.get('config')) || null;
    const e = await DB.get('estado');
    if (e) {
      S.dados = e.dados || null;
      S.lanc = e.lanc || {};
      S.inativacoes = e.inativacoes || [];
      S.data = e.data || null;
      S.ultimoEnvio = e.ultimoEnvio || null;
      S.motoristasHist = e.motoristasHist || [];
      S.taras = e.taras || {};
      S.tarasPadrao = e.tarasPadrao || {};
    }
  } catch (err) {
    aviso('Não foi possível ler os dados do tablet: ' + (err && err.message ? err.message : err), 10000);
  }

  let configuradoPeloLink = false;
  try { configuradoPeloLink = await aplicarLinkConfig(); } catch (err) { aviso('Erro no link de configuração.', 6000); }

  history.replaceState({ tela: 'lista' }, '');
  if (!S.config) {
    S.tela = 'config';
    history.pushState({ tela: 'config' }, '');
  }
  render();
  if (configuradoPeloLink) sincronizar();
  else mostrarStatus();

  setInterval(function () { enviarPendentes(); }, 2 * 60 * 1000);
  setInterval(renderFaixas, 60 * 1000); // atualiza "hoje" na virada do dia
  enviarPendentes();
}

iniciar();
