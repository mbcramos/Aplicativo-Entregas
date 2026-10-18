/*
 * Painel do escritório — interface.
 * Lê a planilha pelo mesmo Apps Script do tablet (com a chave do ESCRITÓRIO).
 */
'use strict';

const N = window.Notas;
const CHAVE_CONFIG = 'pesagem-escritorio-config';
const ATUALIZAR_A_CADA_MS = 2 * 60 * 1000;

const S = {
  config: null,     // { url, chave }
  dados: null,      // resposta do relatório
  data: null,       // data selecionada
  resumo: null,     // N.resumir(...)
  carregando: false,
  atualizadoEm: null,
};

/* ----------------------------- utilitários ----------------------------- */
const $ = function (s) { return document.querySelector(s); };
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const kg = N.fmtKg, R$ = N.fmtR, dataBR = N.fmtData;
function kgOuTraco(v) { return v ? kg(v) : '<span class="zero">—</span>'; }
function pad(n) { return String(n).padStart(2, '0'); }
function hora(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function slug(s) { return N.semAcento(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

let tToast = null;
function toast(msg, erro, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (erro ? ' erro' : '');
  el.hidden = false;
  clearTimeout(tToast);
  tToast = setTimeout(function () { el.hidden = true; }, ms || (erro ? 6000 : 3000));
}

function lerConfig() {
  try { return JSON.parse(localStorage.getItem(CHAVE_CONFIG) || 'null'); } catch (e) { return null; }
}
function gravarConfig(c) {
  try { localStorage.setItem(CHAVE_CONFIG, JSON.stringify(c)); } catch (e) { /* navegador sem armazenamento */ }
}

function confirmar(texto, txtSim) {
  return new Promise(function (ok) {
    const d = $('#dlg-confirmar');
    $('#conf-texto').textContent = texto;
    $('#conf-sim').textContent = txtSim || 'OK';
    d.returnValue = '';
    d.addEventListener('close', function f() { d.removeEventListener('close', f); ok(d.returnValue === 'sim'); });
    d.showModal();
  });
}

/* ----------------------------- comunicação ----------------------------- */
async function chamar(payload, cfg) {
  cfg = cfg || S.config;
  if (!cfg || !cfg.url) throw new Error('Painel não configurado.');
  let resp;
  try {
    resp = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita "preflight", que o Apps Script não atende
      body: JSON.stringify(Object.assign({}, payload, { chave: cfg.chave, dispositivo: 'escritório' })),
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch (e) {
    let alcancavel = false;
    try { await fetch(cfg.url + '?acao=ping', { mode: 'no-cors', cache: 'no-store' }); alcancavel = true; } catch (e2) { /* sem rede */ }
    throw new Error(alcancavel
      ? 'A planilha recusou o acesso. Confira a implantação do Apps Script (Executar como "Eu", acesso "Qualquer pessoa").'
      : 'Sem conexão com a internet.');
  }
  let d;
  try { d = await resp.json(); } catch (e) { throw new Error('Resposta inválida. Confira o endereço do script.'); }
  if (!d || !d.ok) throw new Error((d && d.erro) || 'Erro no servidor.');
  return d;
}

async function carregar(data, silencioso) {
  if (S.carregando) return;
  if (!S.config) { abrirConfig(); return; }
  S.carregando = true;
  $('#btn-atualizar').disabled = true;
  if (!silencioso) $('#btn-atualizar').textContent = '⟳ Atualizando…';
  try {
    const d = await chamar({ acao: 'relatorio', data: data || undefined });
    S.dados = d;
    S.data = d.data;
    S.atualizadoEm = new Date();
    renderTudo();
  } catch (e) {
    if (!S.dados) $('#conteudo').innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    toast(e.message, true);
  } finally {
    S.carregando = false;
    $('#btn-atualizar').disabled = false;
    $('#btn-atualizar').textContent = '⟳ Atualizar';
  }
}

/* ----------------------------- interface ----------------------------- */
function entregaAtual() {
  return S.dados ? S.dados.entregas.find(function (e) { return e.data_entrega === S.data; }) : null;
}

function renderTopo() {
  const sel = $('#sel-data');
  const ents = S.dados ? S.dados.entregas : [];
  sel.innerHTML = ents.length
    ? ents.map(function (e) {
      return '<option value="' + e.data_entrega + '"' + (e.data_entrega === S.data ? ' selected' : '') + '>' +
        dataBR(e.data_entrega) + (e.status === 'FECHADA' ? '  · fechada' : '') + '</option>';
    }).join('')
    : '<option>Nenhuma entrega</option>';
  sel.disabled = !ents.length;
  const ent = entregaAtual();
  const pill = $('#pill-status');
  pill.hidden = !ent;
  if (ent) {
    pill.textContent = ent.status === 'FECHADA' ? 'FECHADA' : 'ABERTA';
    pill.className = 'pill ' + (ent.status === 'FECHADA' ? 'pill-fechada' : 'pill-aberta');
  }
  $('#atualizado').textContent = S.atualizadoEm ? 'Atualizado às ' + hora(S.atualizadoEm) : '';
}

function renderTudo() {
  renderTopo();
  const ent = entregaAtual();
  const main = $('#conteudo');
  if (!ent) {
    main.innerHTML = '<div class="vazio">Nenhuma entrega cadastrada na aba Entregas.</div>';
    return;
  }
  const r = N.resumir(ent, S.dados.parceiros, S.dados.lancamentos);
  S.resumo = r;
  main.innerHTML =
    htmlEntrega(ent) +
    htmlIndicadores(r, ent) +
    '<div class="grade-2" style="margin-top:16px">' + htmlFazendas(r) +
    '<div class="pilha">' + htmlTotais(r) + htmlDescontos() + '</div></div>' +
    htmlCaminhoes(r, ent);
}

function campoEntrega(rot, valor, obrig) {
  const vazio = valor === null || valor === undefined || valor === '' || valor === 0;
  return '<div><div class="rot">' + rot + '</div><div class="val' + (vazio && obrig ? ' falta' : '') + '">' +
    (vazio ? (obrig ? 'não preenchido' : '—') : esc(valor)) + '</div></div>';
}

function htmlEntrega(ent) {
  const fechada = ent.status === 'FECHADA';
  const avisos = (S.dados.avisos || []);
  return '<div class="cartao entrega">' +
    campoEntrega('Preço base', ent.preco_base ? N.fmtPreco(ent.preco_base) : '', true) +
    campoEntrega('Preço ajustado', ent.preco_ajustado ? N.fmtPreco(ent.preco_ajustado) : '', false) +
    campoEntrega('Preço cooperativa', ent.preco_cooperativa ? N.fmtPreco(ent.preco_cooperativa) : '', true) +
    campoEntrega('Empresa', ent.nome_empresa, true) +
    campoEntrega('Cooperativa', ent.nome_cooperativa, true) +
    '<div>' + (fechada
      ? '<button class="btn btn-sec" data-acao="reabrir" title="Permite que o tablet volte a enviar lançamentos para esta data">Reabrir entrega</button>'
      : '<button class="btn btn-alerta" data-acao="fechar" title="O tablet deixa de aceitar alterações nesta data">🔒 Fechar entrega</button>') +
    '</div></div>' +
    (ent.observacoes ? '<div class="obs-entrega">📝 ' + esc(ent.observacoes) + '</div>' : '') +
    (avisos.length ? '<ul class="avisos">' + avisos.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>' : '');
}

function htmlIndicadores(r, ent) {
  const t = r.totais, i = r.icms;
  function ind(classe, rot, valor, sub) {
    return '<div class="cartao ind ' + classe + '"><div class="rot">' + rot + '</div><div class="grande">' + valor + '</div>' +
      (sub ? '<small>' + sub + '</small>' : '') + '</div>';
  }
  return '<div class="indicadores">' +
    ind('', 'Parceiros', t.parceiros, 'ativos + com lançamento') +
    ind('ind-ok', 'Entregaram', t.entregaram, '') +
    ind('ind-nao', 'Não entregaram', t.nao_entregaram, '') +
    ind('ind-falta' + (t.faltam ? '' : ' zero'), 'Faltam lançar', t.faltam, t.faltam ? 'veja por fazenda abaixo' : 'tudo lançado ✔') +
    ind('', 'Peso total', kg(t.peso_total), r.caminhoes.length + (r.caminhoes.length === 1 ? ' caminhão' : ' caminhões')) +
    '<div class="cartao ind icms"><div class="rot">ICMS estimado (para o contador)</div>' +
    '<div class="grande">' + R$(i.valor) + '</div>' +
    '<div class="icms-conta">' +
    '<span>Peso total</span><b class="num">' + kg(i.peso_total) + '</b>' +
    '<span>− em nome do proprietário</span><b class="num">' + kg(i.peso_nome_proprietario) + '</b>' +
    '<span>= base</span><b class="num">' + kg(i.base_kg) + '</b>' +
    '<span>× ' + N.fmtNum(i.aliquota * 100, 0) + '% × preço base ' + N.fmtPreco(i.preco_base) + '</span><b class="num">' + R$(i.valor) + '</b>' +
    '</div></div></div>';
}

function htmlFazendas(r) {
  const linhas = r.fazendas.map(function (f) {
    const pOk = f.total ? f.entregaram / f.total * 100 : 0;
    const pNao = f.total ? f.nao_entregaram / f.total * 100 : 0;
    return '<tr><td><b>' + esc(f.nome) + '</b>' +
      '<div class="barra"><i class="b-ok" style="width:' + pOk + '%"></i><i class="b-nao" style="width:' + pNao + '%"></i></div>' +
      (f.faltam_nomes.length ? '<div class="nomes-pend">Faltam: ' + esc(f.faltam_nomes.join(', ')) + '</div>' : '') +
      (f.nao_nomes.length ? '<div class="nomes-nao">Não entregaram: ' + esc(f.nao_nomes.join(', ')) + '</div>' : '') +
      '</td><td>' + esc(f.proprietarios.join(', ') || '—') + '</td>' +
      '<td class="num">' + f.total + '</td>' +
      '<td class="num">' + (f.entregaram || '<span class="zero">0</span>') + '</td>' +
      '<td class="num">' + (f.nao_entregaram || '<span class="zero">0</span>') + '</td>' +
      '<td class="num">' + (f.faltam ? '<b style="color:var(--vermelho)">' + f.faltam + '</b>' : '<span style="color:var(--verde)">✔</span>') + '</td>' +
      '<td class="num">' + kgOuTraco(f.peso) + '</td></tr>';
  }).join('');
  const t = r.totais;
  return '<div class="cartao"><div class="cartao-cab"><h3>Andamento por fazenda</h3></div>' +
    '<div class="tab-rolagem"><table><thead><tr><th>Fazenda</th><th>Proprietário</th><th class="num">Parceiros</th>' +
    '<th class="num">Entregaram</th><th class="num">Não entregaram</th><th class="num">Faltam</th><th class="num">Peso</th></tr></thead>' +
    '<tbody>' + (linhas || '<tr><td colspan="7" class="zero">Nenhum parceiro.</td></tr>') + '</tbody>' +
    '<tfoot><tr><td colspan="2">Total</td><td class="num">' + t.parceiros + '</td><td class="num">' + t.entregaram + '</td>' +
    '<td class="num">' + t.nao_entregaram + '</td><td class="num">' + t.faltam + '</td><td class="num">' + kg(t.peso_total) + '</td></tr></tfoot>' +
    '</table></div></div>';
}

function htmlDescontos() {
  const d = N.listaDescontos(S.dados.lancamentos, S.dados.parceiros);
  S.descontos = d;
  const vazio = !d.itens.length;
  const bloqueio = vazio ? ' disabled title="Nenhum desconto nesta data"' : '';
  return '<div class="cartao descontos"><div class="cartao-cab"><h3>Descontos do dia</h3>' +
    '<span class="chip"><b>' + R$(d.total) + '</b></span></div>' +
    '<div class="cartao-corpo">' +
    (vazio ? '<div class="zero">Nenhum desconto nesta data.</div>'
      : '<div class="lista-descontos">' + d.itens.map(function (x) {
        return '<div class="nota-linha"><span>' + esc(N.rotuloDesconto(x)) +
          '<small>' + esc(x.fazenda) + (x.maximo ? ' · desconto máximo' : '') + '</small></span>' +
          '<span class="num">' + R$(x.valor) + '</span></div>';
      }).join('') + '</div>' +
      '<div class="nota-sub"><span>' + d.itens.length + (d.itens.length === 1 ? ' parceiro' : ' parceiros') + '</span>' +
      '<span class="num"><b>' + R$(d.total) + '</b></span></div>') +
    '<div class="acoes-desc">' +
    '<button class="btn btn-sec" data-acao="desc-texto"' + bloqueio + '>📋 Copiar texto</button>' +
    '<button class="btn btn-pri" data-acao="desc-imagem"' + bloqueio + '>🖼 Copiar imagem</button>' +
    '<button class="btn btn-sec" data-acao="desc-baixar"' + bloqueio + '>⬇ PNG</button>' +
    '</div></div></div>';
}

function htmlTotais(r) {
  const t = r.totais;
  return '<div class="cartao"><div class="cartao-cab"><h3>Totais do dia</h3></div><div class="cartao-corpo lista-totais">' +
    '<span>Notas no nome dos parceiros</span><span class="num">' + kg(t.peso_parceiro) + '</span>' +
    '<span>Parte de parceiros no nome do proprietário</span><span class="num">' + kg(t.peso_nome_proprietario) + '</span>' +
    '<span>Parte de parceiros no nome de outro</span><span class="num">' + kg(t.peso_nome_outro) + '</span>' +
    '<span>Parte do proprietário</span><span class="num">' + kg(t.peso_proprietario) + '</span>' +
    '<hr><span><b>Peso total</b></span><span class="num"><b>' + kg(t.peso_total) + '</b></span>' +
    '<hr><span>A pagar aos parceiros</span><span class="num">' + R$(t.valor_parceiro) + '</span>' +
    '<span>Descontos aplicados</span><span class="num">' + R$(t.desconto) + '</span>' +
    '<span>Impostos retidos dos parceiros</span><span class="num">' + R$(t.imposto) + '</span>' +
    '</div></div>';
}

function htmlCaminhoes(r, ent) {
  let html = '<div class="secao-titulo"><h2>Caminhões</h2><span>' +
    (r.caminhoes.length ? 'notas para o contador, por motorista' : '') + '</span></div>';
  if (!r.caminhoes.length && !r.sem_motorista.length) {
    return html + '<div class="vazio">Nenhuma entrega pesada nesta data ainda.</div>';
  }
  if (r.sem_motorista.length) {
    html += '<div class="cartao caminhao sem-motorista"><div class="cartao-cab"><h3>⚠ Entregas sem motorista</h3>' +
      '<span>Estas pesagens não entram em nenhum caminhão. Corrija no tablet escolhendo o motorista.</span></div>' +
      '<div class="cam-tabela" style="border-right:none">' + tabelaParceiros(r.sem_motorista) + '</div></div>';
  }
  r.caminhoes.forEach(function (c, idx) {
    const n = c.notas;
    const bloqueio = n.ok ? '' : ' disabled title="Corrija os erros antes de exportar"';
    html += '<div class="cartao caminhao" id="cam-' + idx + '">' +
      '<div class="cartao-cab"><h3>🚚 ' + esc(c.motorista) + '</h3>' +
      '<div class="chips"><span class="chip"><b>' + c.qtde + '</b> ' + (c.qtde === 1 ? 'parceiro' : 'parceiros') + '</span>' +
      '<span class="chip"><b>' + kg(c.peso_total) + '</b></span>' +
      '<span class="chip">' + esc(c.fazendas.join(' · ')) + '</span></div>' +
      '<div class="acoes-cam">' +
      '<button class="btn btn-sec" data-acao="copiar-texto" data-cam="' + idx + '"' + bloqueio + '>📋 Copiar texto</button>' +
      '<button class="btn btn-pri" data-acao="copiar-imagem" data-cam="' + idx + '"' + bloqueio + '>🖼 Copiar imagem</button>' +
      '<button class="btn btn-sec" data-acao="baixar-imagem" data-cam="' + idx + '"' + bloqueio + '>⬇ Baixar PNG</button>' +
      '</div></div>' +
      '<div class="cam-corpo"><div class="cam-tabela">' + tabelaParceiros(c.lancs, c) + '</div>' +
      '<div class="cam-notas">' + htmlNotas(n, ent) + '</div></div></div>';
  });
  return html;
}

function tabelaParceiros(lancs, c) {
  const porId = {};
  S.dados.parceiros.forEach(function (p) { porId[p.id_parceiro] = p; });
  const linhas = lancs.map(function (l) {
    const p = porId[l.id_parceiro] || {};
    const ie = l.tem_ie || p.tem_ie || '';
    return '<tr><td><b>' + esc(l.apelido || l.nome) + '</b>' +
      (l.apelido && l.nome && l.apelido !== l.nome ? '<div style="font-size:.8rem;color:var(--suave)">' + esc(l.nome) + '</div>' : '') +
      (l.observacoes ? '<div style="font-size:.8rem;color:var(--suave)">📝 ' + esc(l.observacoes) + '</div>' : '') +
      notaJunto(l, p) +
      '</td><td>' + esc(l.fazenda) + '</td>' +
      '<td><span class="tag tag-' + esc(ie) + '">' + esc(ie === 'NAO' ? 'NÃO' : ie) + '</span></td>' +
      '<td class="num"><b>' + kg(l.peso_total_kg) + '</b></td>' +
      '<td class="num">' + kgOuTraco(l.peso_parceiro) + '</td>' +
      '<td class="num">' + kgOuTraco(l.peso_nome_proprietario) + '</td>' +
      '<td class="num">' + kgOuTraco(l.peso_nome_outro) + '</td>' +
      '<td class="num">' + kgOuTraco(l.peso_proprietario) + '</td>' +
      '<td class="num">' + (l.penalidade_pct ? N.fmtNum(l.penalidade_pct, 0, 2) + '%' : '<span class="zero">—</span>') + '</td>' +
      '<td class="num">' + (l.desconto_aplicado ? R$(l.desconto_aplicado) : '<span class="zero">—</span>') + '</td>' +
      '<td class="num">' + R$(l.valor_parceiro) + '</td></tr>';
  }).join('');
  const pe = function (campo) { return N.arred(lancs.reduce(function (s, l) { return s + (Number(l[campo]) || 0); }, 0), 2); };
  return '<div class="tab-rolagem"><table><thead><tr><th>Parceiro</th><th>Fazenda</th><th>I.E.</th><th class="num">Peso total</th>' +
    '<th class="num" title="Nota no nome do parceiro">Parceiro</th><th class="num" title="Parte do parceiro em nome do proprietário">Nome prop.</th>' +
    '<th class="num" title="Parte do parceiro em nome de outro parceiro">Nome outro</th><th class="num">Proprietário</th>' +
    '<th class="num">Penal.</th><th class="num">Desconto</th><th class="num">Recebe</th></tr></thead>' +
    '<tbody>' + linhas + '</tbody>' +
    '<tfoot><tr><td colspan="3">Total</td><td class="num">' + kg(pe('peso_total_kg')) + '</td><td class="num">' + kg(pe('peso_parceiro')) + '</td>' +
    '<td class="num">' + kg(pe('peso_nome_proprietario')) + '</td><td class="num">' + kg(pe('peso_nome_outro')) + '</td>' +
    '<td class="num">' + kg(pe('peso_proprietario')) + '</td><td></td><td class="num">' + R$(pe('desconto_aplicado')) + '</td>' +
    '<td class="num">' + R$(pe('valor_parceiro')) + '</td></tr></tfoot></table></div>';
}

/** Para quem tem peso em nome de outro: mostra em qual nota ele entra. */
function notaJunto(l, p) {
  if (!(Number(l.peso_nome_outro) > 0) || !p.id_parceiro) return '';
  const m = N.acharParceiroDaNota(p, S.dados.parceiros);
  return m.parceiro
    ? '<div style="font-size:.8rem;color:var(--azul);font-weight:600">↳ nota de ' + esc(m.parceiro.apelido || m.parceiro.nome) + '</div>'
    : '<div style="font-size:.8rem;color:var(--vermelho);font-weight:600">↳ sem parceiro para a nota</div>';
}

function htmlNotas(n, ent) {
  if (!n.ok) {
    return '<div class="erros"><b>Exportação bloqueada</b><ul>' +
      n.erros.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
  }
  let h = '';
  if (n.parceiros.length) {
    h += '<h4>Notas dos parceiros</h4><div class="dest">para <b>' + esc(ent.nome_empresa) + '</b> · ' + N.fmtPreco(ent.preco_base) + '</div>' +
      n.parceiros.map(function (x) {
        return '<div class="nota-linha"><span>' + esc(x.nome) + '</span><span class="num">' + kg(x.peso) + '</span></div>';
      }).join('') +
      '<div class="nota-sub"><span>Subtotal</span><span class="num">' + kg(n.peso_parceiros) + '</span></div>';
  }
  if (n.proprietario.length) {
    h += '<h4>Notas do proprietário</h4><div class="dest">para <b>' + esc(ent.nome_cooperativa) + '</b> · ' + N.fmtPreco(ent.preco_cooperativa) + '</div>' +
      n.proprietario.map(function (x) {
        return '<div class="nota-linha"><span>' + esc(x.nome) + '</span><span class="num">' + kg(x.peso) + '</span></div>';
      }).join('') +
      '<div class="nota-sub"><span>Subtotal</span><span class="num">' + kg(n.peso_proprietario) + '</span></div>';
  }
  h += '<div class="conferencia">✔ Notas somam ' + kg(n.peso_notas) + ' = peso do caminhão</div>';
  return h;
}

/* ----------------------------- exportação ----------------------------- */
function caminhaoDoBotao(el) { return S.resumo.caminhoes[Number(el.dataset.cam)]; }

async function copiarTexto(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

/** Desenha as notas de um caminhão numa imagem (canvas), com tabelas. Colunas se ajustam aos textos. */
function desenharImagem(ent, c) {
  const n = c.notas;
  const ESC = 2, M = 28, PAD = 14, GAP = 36;
  const fonte = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const LIN = 34, CAB_TAB = 30;
  const medidor = document.createElement('canvas').getContext('2d');
  function largura(s, tam, peso) { medidor.font = (peso || 400) + ' ' + tam + 'px ' + fonte; return medidor.measureText(String(s)).width; }

  const secoes = [];
  if (n.parceiros.length) secoes.push({ titulo: 'Notas dos parceiros', linhas: n.parceiros, preco: ent.preco_base,
    destino: N.normalizarNome(ent.nome_empresa), rot: 'EMPRESA', subtotal: n.peso_parceiros });
  if (n.proprietario.length) secoes.push({ titulo: 'Notas do proprietário', linhas: n.proprietario, preco: ent.preco_cooperativa,
    destino: N.normalizarNome(ent.nome_cooperativa), rot: 'COOPERATIVA', subtotal: n.peso_proprietario });

  // larguras das colunas pelo maior texto
  let wNome = largura('NOME', 12, 800), wPeso = largura('PESO', 12, 800), wPreco = largura('PREÇO', 12, 800), wDest = 0;
  secoes.forEach(function (sec) {
    wDest = Math.max(wDest, largura(sec.rot, 12, 800), largura(sec.destino, 15, 500));
    wPreco = Math.max(wPreco, largura(N.fmtPreco(sec.preco), 15, 500));
    wPeso = Math.max(wPeso, largura(kg(sec.subtotal), 16, 800));
    sec.linhas.forEach(function (x) { wNome = Math.max(wNome, largura(x.nome, 16, 600)); wPeso = Math.max(wPeso, largura(kg(x.peso), 16, 800)); });
  });
  wNome = Math.min(wNome, 420); wDest = Math.min(wDest, 380);
  const W = Math.max(860, Math.ceil(2 * M + 2 * PAD + wNome + wPeso + wPreco + wDest + 3 * GAP));
  const xNome = M + PAD;
  const xPeso = W - M - PAD - wDest - GAP - wPreco - GAP;          // alinhado à direita
  const xPreco = W - M - PAD - wDest - GAP;                        // alinhado à direita
  const xDest = W - M - PAD - wDest;

  let h = 96 + 16;
  secoes.forEach(function (sec) { h += 34 + CAB_TAB + sec.linhas.length * LIN + LIN + 18; });
  h += 44 + M;

  const cv = document.createElement('canvas');
  cv.width = W * ESC; cv.height = h * ESC;
  const g = cv.getContext('2d');
  g.scale(ESC, ESC);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, h);

  function txt(s, x, y, tam, peso, cor, alin) {
    g.font = (peso || 400) + ' ' + tam + 'px ' + fonte;
    g.fillStyle = cor || '#1b1d1a';
    g.textAlign = alin || 'left';
    g.textBaseline = 'middle';
    g.fillText(s, x, y);
  }
  function cortar(s, larg, tam, peso) {
    g.font = (peso || 400) + ' ' + tam + 'px ' + fonte;
    if (g.measureText(s).width <= larg + 0.5) return s;
    while (s.length > 1 && g.measureText(s + '…').width > larg) s = s.slice(0, -1);
    return s + '…';
  }

  g.fillStyle = '#1f6b3a'; g.fillRect(0, 0, W, 96);
  txt('NOTAS – ' + dataBR(ent.data_entrega), M, 38, 26, 800, '#ffffff');
  txt('Motorista: ' + c.motorista, M, 72, 18, 600, '#e6f2ea');
  txt(c.qtde + (c.qtde === 1 ? ' parceiro' : ' parceiros') + ' · ' + kg(c.peso_total), W - M, 72, 16, 600, '#e6f2ea', 'right');

  let y = 96 + 16;
  secoes.forEach(function (sec) {
    txt(sec.titulo, M, y + 14, 17, 800, '#1f6b3a');
    y += 34;
    g.fillStyle = '#eef3ef'; g.fillRect(M, y, W - 2 * M, CAB_TAB);
    txt('NOME', xNome, y + CAB_TAB / 2, 12, 800, '#5b6157');
    txt('PESO', xPeso, y + CAB_TAB / 2, 12, 800, '#5b6157', 'right');
    txt('PREÇO', xPreco, y + CAB_TAB / 2, 12, 800, '#5b6157', 'right');
    txt(sec.rot, xDest, y + CAB_TAB / 2, 12, 800, '#5b6157');
    y += CAB_TAB;
    sec.linhas.forEach(function (x, i) {
      if (i % 2 === 1) { g.fillStyle = '#fafbf8'; g.fillRect(M, y, W - 2 * M, LIN); }
      txt(cortar(x.nome, wNome, 16, 600), xNome, y + LIN / 2, 16, 600);
      txt(kg(x.peso), xPeso, y + LIN / 2, 16, 800, '#1b1d1a', 'right');
      txt(N.fmtPreco(sec.preco), xPreco, y + LIN / 2, 15, 500, '#1b1d1a', 'right');
      txt(cortar(sec.destino, wDest, 15, 500), xDest, y + LIN / 2, 15, 500);
      g.fillStyle = '#e4e6df'; g.fillRect(M, y + LIN - 1, W - 2 * M, 1);
      y += LIN;
    });
    txt('Subtotal', xNome, y + LIN / 2, 14, 700, '#5b6157');
    txt(kg(sec.subtotal), xPeso, y + LIN / 2, 15, 800, '#5b6157', 'right');
    y += LIN + 18;
  });

  g.fillStyle = '#1f6b3a'; g.fillRect(M, y, W - 2 * M, 44);
  txt('Total do caminhão', M + PAD, y + 22, 17, 700, '#ffffff');
  txt(kg(n.peso_caminhao), W - M - PAD, y + 22, 20, 800, '#ffffff', 'right');
  return cv;
}

/** Imagem da lista de descontos: Parceiro | Fazenda | Desconto, com total. */
function desenharDescontos(ent, d) {
  const ESC = 2, M = 28, PAD = 14, GAP = 36, LIN = 34, CAB_TAB = 30;
  const fonte = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const med = document.createElement('canvas').getContext('2d');
  function larg(t, tam, peso) { med.font = (peso || 400) + ' ' + tam + 'px ' + fonte; return med.measureText(String(t)).width; }
  let wNome = larg('PARCEIRO', 12, 800), wFaz = larg('FAZENDA', 12, 800), wVal = larg(R$(d.total), 17, 800);
  d.itens.forEach(function (x) {
    wNome = Math.max(wNome, larg(N.rotuloDesconto(x), 16, 600));
    wFaz = Math.max(wFaz, larg(x.fazenda, 15, 500));
    wVal = Math.max(wVal, larg(R$(x.valor), 16, 800));
  });
  wNome = Math.min(wNome, 460); wFaz = Math.min(wFaz, 300);
  const W = Math.max(640, Math.ceil(2 * M + 2 * PAD + wNome + wFaz + wVal + 2 * GAP));
  const xNome = M + PAD, xFaz = W - M - PAD - wVal - GAP - wFaz, xVal = W - M - PAD;
  const h = 96 + 16 + CAB_TAB + d.itens.length * LIN + 16 + 44 + M;

  const cv = document.createElement('canvas');
  cv.width = W * ESC; cv.height = h * ESC;
  const g = cv.getContext('2d');
  g.scale(ESC, ESC);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, h);
  function txt(t, x, y, tam, peso, cor, alin) {
    g.font = (peso || 400) + ' ' + tam + 'px ' + fonte; g.fillStyle = cor || '#1b1d1a';
    g.textAlign = alin || 'left'; g.textBaseline = 'middle'; g.fillText(t, x, y);
  }
  function cortar(t, l, tam, peso) {
    g.font = (peso || 400) + ' ' + tam + 'px ' + fonte;
    if (g.measureText(t).width <= l + 0.5) return t;
    while (t.length > 1 && g.measureText(t + '…').width > l) t = t.slice(0, -1);
    return t + '…';
  }
  g.fillStyle = '#1f6b3a'; g.fillRect(0, 0, W, 96);
  txt('DESCONTOS – ' + dataBR(ent.data_entrega), M, 38, 26, 800, '#ffffff');
  txt('Descontos dos parceiros (R$)', M, 72, 18, 600, '#e6f2ea');
  txt(d.itens.length + (d.itens.length === 1 ? ' parceiro' : ' parceiros'), W - M, 72, 16, 600, '#e6f2ea', 'right');
  let y = 96 + 16;
  g.fillStyle = '#eef3ef'; g.fillRect(M, y, W - 2 * M, CAB_TAB);
  txt('PARCEIRO', xNome, y + CAB_TAB / 2, 12, 800, '#5b6157');
  txt('FAZENDA', xFaz, y + CAB_TAB / 2, 12, 800, '#5b6157');
  txt('DESCONTO', xVal, y + CAB_TAB / 2, 12, 800, '#5b6157', 'right');
  y += CAB_TAB;
  d.itens.forEach(function (x, i) {
    if (i % 2 === 1) { g.fillStyle = '#fafbf8'; g.fillRect(M, y, W - 2 * M, LIN); }
    txt(cortar(N.rotuloDesconto(x), wNome, 16, 600), xNome, y + LIN / 2, 16, 600);
    txt(cortar(x.fazenda, wFaz, 15, 500), xFaz, y + LIN / 2, 15, 500);
    txt(R$(x.valor), xVal, y + LIN / 2, 16, 800, '#1b1d1a', 'right');
    g.fillStyle = '#e4e6df'; g.fillRect(M, y + LIN - 1, W - 2 * M, 1);
    y += LIN;
  });
  y += 16;
  g.fillStyle = '#1f6b3a'; g.fillRect(M, y, W - 2 * M, 44);
  txt('Total de descontos', M + PAD, y + 22, 17, 700, '#ffffff');
  txt(R$(d.total), W - M - PAD, y + 22, 20, 800, '#ffffff', 'right');
  return cv;
}

function nomeArquivo(ent, c) { return 'notas-' + ent.data_entrega + '-' + slug(c.motorista) + '.png'; }

function baixarCanvas(cv, nome) {
  const a = document.createElement('a');
  a.href = cv.toDataURL('image/png');
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copiarImagem(ent, c) {
  await copiarCanvas(desenharImagem(ent, c), nomeArquivo(ent, c));
}

async function copiarCanvas(cv, nome) {
  try {
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error('sem suporte');
    const blob = new Promise(function (ok) { cv.toBlob(ok, 'image/png'); });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Imagem copiada ✔ Cole no WhatsApp com Ctrl+V');
  } catch (e) {
    baixarCanvas(cv, nome);
    toast('Este navegador não deixou copiar a imagem; ela foi baixada como arquivo.', true, 6000);
  }
}

/* ----------------------------- configuração ----------------------------- */
function abrirConfig() {
  const d = $('#dlg-config');
  const c = S.config || {};
  $('#c-url').value = c.url || '';
  $('#c-chave').value = c.chave || '';
  $('#c-msg').textContent = '';
  $('#c-msg').className = 'msg-config';
  $('#c-cancelar').hidden = !S.config;
  $('#c-link').hidden = !S.config;
  if (!d.open) d.showModal();
}
function lerCamposConfig() {
  return { url: $('#c-url').value.trim(), chave: $('#c-chave').value.trim().toUpperCase() };
}
function validarConfig(c) {
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(c.url)) return 'O endereço deve começar com https://script.google.com/ e terminar com /exec';
  if (!c.chave) return 'Digite a chave do escritório.';
  return null;
}
function msgConfig(t, ok) { const m = $('#c-msg'); m.textContent = t; m.className = 'msg-config ' + (ok ? 'ok' : 'erro'); }

async function testarConfig() {
  const c = lerCamposConfig();
  const erro = validarConfig(c);
  if (erro) { msgConfig(erro); return false; }
  msgConfig('Testando…', true);
  try {
    const r = await chamar({ acao: 'ping' }, c);
    if (r.tipo === 'tablet') { msgConfig('Esta é a chave do TABLET. Use a chave do ESCRITÓRIO.'); return false; }
    msgConfig('Conexão OK ✔', true);
    return true;
  } catch (e) { msgConfig(e.message); return false; }
}

/* ----------------------------- eventos ----------------------------- */
const ACOES = {
  atualizar: function () { carregar(S.data); },
  config: abrirConfig,
  'fechar-config': function () { $('#dlg-config').close(); },
  'testar-config': testarConfig,
  'copiar-link': async function () {
    const ok = await copiarTexto(linkDeAcesso(S.config));
    msgConfig(ok ? 'Link copiado ✔ Quem abrir este link já entra no painel configurado.' : 'Não foi possível copiar.', ok);
  },
  fechar: async function () {
    const ent = entregaAtual();
    if (!await confirmar('Fechar a entrega de ' + dataBR(ent.data_entrega) + '?\n\nO tablet deixa de aceitar lançamentos e correções nesta data. ' +
      'Dá para reabrir depois.', 'Fechar entrega')) return;
    try { await chamar({ acao: 'status_entrega', data: ent.data_entrega, status: 'FECHADA' }); toast('Entrega fechada 🔒'); carregar(S.data); }
    catch (e) { toast(e.message, true); }
  },
  reabrir: async function () {
    const ent = entregaAtual();
    if (!await confirmar('Reabrir a entrega de ' + dataBR(ent.data_entrega) + '?\n\nO tablet volta a aceitar lançamentos e correções nesta data.', 'Reabrir')) return;
    try { await chamar({ acao: 'status_entrega', data: ent.data_entrega, status: 'ABERTA' }); toast('Entrega reaberta'); carregar(S.data); }
    catch (e) { toast(e.message, true); }
  },
  'copiar-texto': async function (el) {
    const c = caminhaoDoBotao(el);
    const ok = await copiarTexto(N.textoWhatsApp(entregaAtual(), c));
    toast(ok ? 'Texto copiado ✔ Cole no WhatsApp com Ctrl+V' : 'Não foi possível copiar.', !ok);
  },
  'copiar-imagem': function (el) { copiarImagem(entregaAtual(), caminhaoDoBotao(el)); },
  'desc-texto': async function () {
    const ok = await copiarTexto(N.textoDescontos(entregaAtual(), S.descontos));
    toast(ok ? 'Descontos copiados ✔ Cole no WhatsApp com Ctrl+V' : 'Não foi possível copiar.', !ok);
  },
  'desc-imagem': function () {
    const ent = entregaAtual();
    copiarCanvas(desenharDescontos(ent, S.descontos), 'descontos-' + ent.data_entrega + '.png');
  },
  'desc-baixar': function () {
    const ent = entregaAtual();
    baixarCanvas(desenharDescontos(ent, S.descontos), 'descontos-' + ent.data_entrega + '.png');
  },
  'baixar-imagem': function (el) {
    const ent = entregaAtual(), c = caminhaoDoBotao(el);
    baixarCanvas(desenharImagem(ent, c), nomeArquivo(ent, c));
  },
};

document.addEventListener('click', function (ev) {
  const el = ev.target.closest('[data-acao]');
  if (!el || el.disabled) return;
  const fn = ACOES[el.dataset.acao];
  if (fn) { ev.preventDefault(); fn(el); }
});

$('#sel-data').addEventListener('change', function (ev) { carregar(ev.target.value); });

$('#form-config').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  const c = lerCamposConfig();
  if (!await testarConfig()) return;
  S.config = c;
  gravarConfig(c);
  $('#dlg-config').close();
  S.dados = null;
  carregar();
});
$('#dlg-config').addEventListener('cancel', function (ev) { if (!S.config) ev.preventDefault(); });

// Atualiza sozinho de tempos em tempos (para acompanhar a pesagem durante o dia)
setInterval(function () {
  if (document.visibilityState === 'visible' && S.config && !document.querySelector('dialog[open]')) carregar(S.data, true);
}, ATUALIZAR_A_CADA_MS);

/* ----------------------------- link de acesso ----------------------------- */
/** Link pronto: <site>/escritorio/#url=<endereço do script>&chave=<chave do escritório> */
function linkDeAcesso(c) {
  return location.origin + location.pathname + '#url=' + encodeURIComponent(c.url) + '&chave=' + encodeURIComponent(c.chave);
}

/** Lê a configuração vinda no link, salva e limpa o endereço. Devolve true se mudou. */
async function aplicarLinkConfig() {
  const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  if (!h.has('url') && !h.has('chave')) return false;
  history.replaceState(null, '', location.pathname + location.search);
  const c = { url: (h.get('url') || '').trim(), chave: (h.get('chave') || '').trim().toUpperCase() };
  const erro = validarConfig(c);
  if (erro) { toast('Link de acesso inválido. ' + erro, true, 8000); return false; }
  if (S.config && S.config.url === c.url && S.config.chave === c.chave) return false;
  if (S.config && !(await confirmar('Este link traz outra configuração (endereço/chave da planilha).\n\nSubstituir a configuração deste computador?', 'Substituir'))) return false;
  S.config = c;
  gravarConfig(c);
  toast('Painel configurado pelo link ✔');
  return true;
}

/* ----------------------------- início ----------------------------- */
async function iniciar() {
  S.config = lerConfig();
  await aplicarLinkConfig();
  if (S.config) { carregar(); return; }
  $('#conteudo').innerHTML = '<div class="vazio">Configure o endereço da planilha e a chave do escritório.</div>';
  abrirConfig();
}
iniciar();
// link colado numa aba que já estava aberta (só muda a parte depois de #)
window.addEventListener('hashchange', async function () {
  if (await aplicarLinkConfig()) { S.dados = null; carregar(); }
});
