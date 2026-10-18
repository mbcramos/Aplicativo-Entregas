/*
 * Painel do escritório — cálculos (sem interface), testáveis com: node testes/teste-notas.js
 *
 * resumir(entrega, parceiros, lancamentos) -> andamento, totais, ICMS e caminhões (com as notas)
 * montarNotas(...)                           -> linhas das notas de um caminhão (ou erros)
 * textoWhatsApp(...)                         -> texto pronto para colar no WhatsApp
 */
(function (raiz) {
  'use strict';

  const ALIQUOTA_ICMS = 0.12;

  function arred(x, casas) {
    if (!isFinite(x)) return 0;
    const y = Number(Number(x).toFixed(8));
    if (Math.abs(y) < 1e-9) return 0;
    return Number(Math.round(Number(y + 'e' + casas)) + 'e-' + casas);
  }
  function semAcento(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function normalizarNome(s) { return String(s || '').trim().replace(/\s+/g, ' '); }
  function chaveNome(s) { return semAcento(normalizarNome(s)); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ------------------------------ formatação pt-BR ------------------------------ */
  function fmtNum(n, min, max) {
    return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max === undefined ? min : max });
  }
  function fmtKg(n) { return fmtNum(n, 1) + ' kg'; }
  function fmtR(n) { return 'R$ ' + fmtNum(n, 2); }
  function fmtPreco(n) { return 'R$ ' + fmtNum(n, 2, 4); }
  function fmtData(iso) { const p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso || ''); }

  /* ------------------------------ ordenação ------------------------------ */
  function ordemParceiro(a, b) {
    const oa = a.ordem === null || a.ordem === undefined || a.ordem === '' ? Infinity : Number(a.ordem);
    const ob = b.ordem === null || b.ordem === undefined || b.ordem === '' ? Infinity : Number(b.ordem);
    if (oa !== ob) return oa - ob;
    return (a.apelido || a.nome || '').localeCompare(b.apelido || b.nome || '', 'pt-BR');
  }

  /**
   * Para um parceiro com I.E. OUTRO: procura nas observações dele o apelido (palavra inteira)
   * de um parceiro com I.E. SIM. Devolve {parceiro} ou {erro}.
   */
  function acharParceiroDaNota(p, parceiros) {
    const obs = chaveNome(p.observacoes);
    const rotulo = (p.apelido || p.nome) + ' (I.E. OUTRO)';
    if (!obs) return { erro: rotulo + ': as observações do parceiro estão vazias; não há apelido de quem emite a nota.' };
    const achados = parceiros.filter(function (c) {
      if (c.id_parceiro === p.id_parceiro || c.tem_ie !== 'SIM') return false;
      const ap = chaveNome(c.apelido);
      if (!ap) return false;
      return new RegExp('(^|[^a-z0-9])' + escRegex(ap) + '([^a-z0-9]|$)').test(obs);
    });
    // "Zé" dentro de "Zé do Brejo": fica só o apelido mais completo
    const finais = achados.filter(function (c) {
      const ap = chaveNome(c.apelido);
      return !achados.some(function (o) {
        const ao = chaveNome(o.apelido);
        return ao !== ap && ao.length > ap.length &&
          new RegExp('(^|[^a-z0-9])' + escRegex(ap) + '([^a-z0-9]|$)').test(ao);
      });
    });
    if (finais.length === 1) return { parceiro: finais[0] };
    if (!finais.length) {
      return { erro: rotulo + ': nenhum parceiro com I.E. SIM encontrado nas observações ("' +
        normalizarNome(p.observacoes) + '").' };
    }
    return { erro: rotulo + ': as observações citam mais de um parceiro com I.E. SIM (' +
      finais.map(function (c) { return c.apelido; }).join(', ') + ').' };
  }

  /**
   * Notas de um caminhão.
   * - Parceiros (I.E. SIM): peso_parceiro, no nome do parceiro, para nome_empresa, a preco_base.
   * - I.E. OUTRO: peso_nome_outro vai para a nota do parceiro (I.E. SIM) citado nas observações,
   *   neste mesmo caminhão (soma se ele já tiver nota aqui; senão cria uma nota no nome dele).
   * - Proprietário: peso_proprietario + peso_nome_proprietario, agrupados por nome_proprietario,
   *   para nome_cooperativa, a preco_cooperativa.
   */
  function montarNotas(lancs, entrega, parceiros) {
    const porId = {};
    parceiros.forEach(function (p) { porId[p.id_parceiro] = p; });
    const erros = [];
    const linhasP = {}; // id -> {id, nome, peso}
    const linhasD = {}; // chave do nome -> {nome, peso}
    let total = 0;

    function addParceiro(p, peso) {
      if (!linhasP[p.id_parceiro]) linhasP[p.id_parceiro] = { id_parceiro: p.id_parceiro, nome: normalizarNome(p.nome) || p.id_parceiro, peso: 0 };
      linhasP[p.id_parceiro].peso = arred(linhasP[p.id_parceiro].peso + peso, 1);
    }

    lancs.forEach(function (l) {
      const p = porId[l.id_parceiro];
      const rotulo = (l.apelido || l.nome || l.id_parceiro);
      total = arred(total + num(l.peso_total_kg), 1);
      if (!p) { erros.push(rotulo + ': parceiro ' + l.id_parceiro + ' não existe mais na aba Parceiros.'); return; }
      const pp = num(l.peso_parceiro), po = num(l.peso_nome_outro);
      const pd = arred(num(l.peso_proprietario) + num(l.peso_nome_proprietario), 1);
      if (pp > 0) addParceiro(p, pp);
      if (po > 0) {
        const m = acharParceiroDaNota(p, parceiros);
        if (m.erro) erros.push(m.erro);
        else addParceiro(m.parceiro, po);
      }
      if (pd > 0) {
        const dono = normalizarNome(p.nome_proprietario);
        if (!dono) { erros.push((p.apelido || p.nome) + ': falta nome_proprietario na aba Parceiros.'); return; }
        const k = chaveNome(dono);
        if (!linhasD[k]) linhasD[k] = { nome: dono, peso: 0 };
        linhasD[k].peso = arred(linhasD[k].peso + pd, 1);
      }
    });

    const notasParceiros = Object.values(linhasP).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    const notasProprietario = Object.values(linhasD).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    if (notasParceiros.length) {
      if (!normalizarNome(entrega.nome_empresa)) erros.push('Falta nome_empresa na aba Entregas para esta data.');
      if (!(num(entrega.preco_base) > 0)) erros.push('Falta preco_base na aba Entregas para esta data.');
    }
    if (notasProprietario.length) {
      if (!normalizarNome(entrega.nome_cooperativa)) erros.push('Falta nome_cooperativa na aba Entregas para esta data.');
      if (!(num(entrega.preco_cooperativa) > 0)) erros.push('Falta preco_cooperativa na aba Entregas para esta data.');
    }
    const somaP = arred(notasParceiros.reduce(function (s, x) { return s + x.peso; }, 0), 1);
    const somaD = arred(notasProprietario.reduce(function (s, x) { return s + x.peso; }, 0), 1);
    const somaNotas = arred(somaP + somaD, 1);
    const confere = !erros.length && Math.abs(somaNotas - total) < 0.05;
    if (!erros.length && !confere) {
      erros.push('Conferência: as notas somam ' + fmtKg(somaNotas) + ', mas o caminhão tem ' + fmtKg(total) + '.');
    }
    return {
      ok: erros.length === 0,
      erros: erros,
      parceiros: notasParceiros,
      proprietario: notasProprietario,
      peso_parceiros: somaP,
      peso_proprietario: somaD,
      peso_notas: somaNotas,
      peso_caminhao: total,
    };
  }

  /** Andamento por fazenda, totais do dia, ICMS e caminhões. */
  function resumir(entrega, parceiros, lancamentos) {
    const porId = {};
    parceiros.forEach(function (p) { porId[p.id_parceiro] = p; });
    const lancPorId = {};
    lancamentos.forEach(function (l) { lancPorId[l.id_parceiro] = l; });

    // ---- andamento por fazenda (ativos + quem tem lançamento na data)
    const lista = parceiros.filter(function (p) { return p.ativo !== 'NAO' || lancPorId[p.id_parceiro]; })
      .slice().sort(ordemParceiro);
    lancamentos.forEach(function (l) {
      if (!porId[l.id_parceiro]) lista.push({ id_parceiro: l.id_parceiro, nome: l.nome, apelido: l.apelido, fazenda: l.fazenda });
    });
    const fazendas = [];
    const fazPorChave = {};
    lista.forEach(function (p) {
      const l = lancPorId[p.id_parceiro];
      const nomeFaz = normalizarNome((l && l.fazenda) || p.fazenda) || 'Sem fazenda';
      const k = chaveNome(nomeFaz);
      if (!fazPorChave[k]) {
        fazPorChave[k] = { nome: nomeFaz, proprietarios: [], total: 0, entregaram: 0, nao_entregaram: 0, faltam: 0,
          faltam_nomes: [], nao_nomes: [], peso: 0 };
        fazendas.push(fazPorChave[k]);
      }
      const f = fazPorChave[k];
      const dono = normalizarNome(p.nome_proprietario);
      if (dono && f.proprietarios.indexOf(dono) < 0) f.proprietarios.push(dono);
      f.total++;
      const apelido = p.apelido || p.nome || p.id_parceiro;
      if (!l) { f.faltam++; f.faltam_nomes.push(apelido); }
      else if (l.situacao === 'ENTREGOU') { f.entregaram++; f.peso = arred(f.peso + num(l.peso_total_kg), 1); }
      else { f.nao_entregaram++; f.nao_nomes.push(apelido); }
    });

    // ---- totais do dia
    const entregues = lancamentos.filter(function (l) { return l.situacao === 'ENTREGOU'; });
    function soma(arr, campo) { return arred(arr.reduce(function (s, l) { return s + num(l[campo]); }, 0), 2); }
    const tot = {
      parceiros: lista.length,
      entregaram: entregues.length,
      nao_entregaram: lancamentos.length - entregues.length,
      faltam: fazendas.reduce(function (s, f) { return s + f.faltam; }, 0),
      peso_total: arred(soma(entregues, 'peso_total_kg'), 1),
      peso_parceiro: arred(soma(entregues, 'peso_parceiro'), 1),
      peso_nome_proprietario: arred(soma(entregues, 'peso_nome_proprietario'), 1),
      peso_nome_outro: arred(soma(entregues, 'peso_nome_outro'), 1),
      peso_proprietario: arred(soma(entregues, 'peso_proprietario'), 1),
      valor_parceiro: soma(entregues, 'valor_parceiro'),
      desconto: soma(entregues, 'desconto_aplicado'),
      imposto: soma(entregues, 'valor_imposto'),
    };

    // ---- ICMS estimado: (peso total − peso em nome do proprietário) × 12% × preço base
    const emNomeDono = arred(tot.peso_proprietario + tot.peso_nome_proprietario, 1);
    const baseKg = arred(tot.peso_total - emNomeDono, 1);
    const icms = {
      peso_total: tot.peso_total,
      peso_nome_proprietario: emNomeDono,
      base_kg: baseKg,
      preco_base: num(entrega.preco_base),
      aliquota: ALIQUOTA_ICMS,
      valor: arred(baseKg * ALIQUOTA_ICMS * num(entrega.preco_base), 2),
    };

    // ---- caminhões
    const porMotorista = {};
    const semMotorista = [];
    entregues.forEach(function (l) {
      const m = normalizarNome(l.motorista);
      if (!m) { semMotorista.push(l); return; }
      const k = chaveNome(m);
      if (!porMotorista[k]) porMotorista[k] = { motorista: m, lancs: [] };
      porMotorista[k].lancs.push(l);
    });
    const caminhoes = Object.values(porMotorista)
      .sort(function (a, b) { return a.motorista.localeCompare(b.motorista, 'pt-BR'); })
      .map(function (c) {
        c.lancs.sort(function (a, b) {
          const pa = porId[a.id_parceiro] || a, pb = porId[b.id_parceiro] || b;
          const fa = chaveNome(a.fazenda), fb = chaveNome(b.fazenda);
          if (fa !== fb) return fa.localeCompare(fb, 'pt-BR');
          return ordemParceiro(pa, pb);
        });
        const fazs = [];
        c.lancs.forEach(function (l) { const f = normalizarNome(l.fazenda); if (f && fazs.indexOf(f) < 0) fazs.push(f); });
        return {
          motorista: c.motorista,
          lancs: c.lancs,
          fazendas: fazs,
          qtde: c.lancs.length,
          peso_total: arred(soma(c.lancs, 'peso_total_kg'), 1),
          peso_parceiro: arred(soma(c.lancs, 'peso_parceiro'), 1),
          peso_nome_proprietario: arred(soma(c.lancs, 'peso_nome_proprietario'), 1),
          peso_nome_outro: arred(soma(c.lancs, 'peso_nome_outro'), 1),
          peso_proprietario: arred(soma(c.lancs, 'peso_proprietario'), 1),
          valor_parceiro: soma(c.lancs, 'valor_parceiro'),
          desconto: soma(c.lancs, 'desconto_aplicado'),
          imposto: soma(c.lancs, 'valor_imposto'),
          notas: montarNotas(c.lancs, entrega, parceiros),
        };
      });

    return { fazendas: fazendas, totais: tot, icms: icms, caminhoes: caminhoes, sem_motorista: semMotorista };
  }

  /** Texto para o WhatsApp (*negrito*, uma nota por linha, sem tabelas largas). */
  function textoWhatsApp(entrega, caminhao) {
    const n = caminhao.notas;
    const L = [];
    L.push('*NOTAS – ' + fmtData(entrega.data_entrega) + '*');
    L.push('🚚 Motorista: *' + caminhao.motorista + '*');
    if (n.parceiros.length) {
      L.push('');
      L.push('*NOTAS DOS PARCEIROS*');
      L.push('Empresa: *' + normalizarNome(entrega.nome_empresa) + '*');
      L.push('Preço: *' + fmtPreco(entrega.preco_base) + '*');
      n.parceiros.forEach(function (x) { L.push('• ' + x.nome + ': *' + fmtKg(x.peso) + '*'); });
      L.push('Subtotal: ' + fmtKg(n.peso_parceiros));
    }
    if (n.proprietario.length) {
      L.push('');
      L.push('*NOTAS DO PROPRIETÁRIO*');
      L.push('Cooperativa: *' + normalizarNome(entrega.nome_cooperativa) + '*');
      L.push('Preço: *' + fmtPreco(entrega.preco_cooperativa) + '*');
      n.proprietario.forEach(function (x) { L.push('• ' + x.nome + ': *' + fmtKg(x.peso) + '*'); });
      L.push('Subtotal: ' + fmtKg(n.peso_proprietario));
    }
    L.push('');
    L.push('*Total do caminhão: ' + fmtKg(n.peso_caminhao) + '*');
    return L.join('\n');
  }

  /** Descontos (R$) da data: parceiros que entregaram com desconto aplicado, em ordem alfabética. */
  function listaDescontos(lancamentos, parceiros) {
    const porId = {};
    (parceiros || []).forEach(function (p) { porId[p.id_parceiro] = p; });
    const itens = lancamentos
      .filter(function (l) { return l.situacao === 'ENTREGOU' && num(l.desconto_aplicado) > 0; })
      .map(function (l) {
        const p = porId[l.id_parceiro] || {};
        return {
          id_parceiro: l.id_parceiro,
          nome: normalizarNome(p.nome || l.nome) || l.id_parceiro,
          apelido: normalizarNome(p.apelido || l.apelido),
          fazenda: normalizarNome(l.fazenda || p.fazenda),
          valor: arred(num(l.desconto_aplicado), 2),
          maximo: l.desconto_modo === 'MAXIMO',
        };
      })
      .sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    return { itens: itens, total: arred(itens.reduce(function (s, x) { return s + x.valor; }, 0), 2) };
  }
  function rotuloDesconto(x) {
    return x.nome + (x.apelido && chaveNome(x.apelido) !== chaveNome(x.nome) ? ' (' + x.apelido + ')' : '');
  }

  /** Texto dos descontos para o WhatsApp. */
  function textoDescontos(entrega, lista) {
    const L = ['*DESCONTOS DOS PARCEIROS – ' + fmtData(entrega.data_entrega) + '*', ''];
    lista.itens.forEach(function (x) {
      L.push('• ' + rotuloDesconto(x) + (x.fazenda ? ' – ' + x.fazenda : '') + ': *' + fmtR(x.valor) + '*');
    });
    L.push('');
    L.push('*Total: ' + fmtR(lista.total) + '*' + ' (' + lista.itens.length + (lista.itens.length === 1 ? ' parceiro)' : ' parceiros)'));
    return L.join('\n');
  }

  /**
   * Pagamentos de parceiros com nota em nome de outro (peso_nome_outro > 0): apelido do parceiro,
   * apelido de quem está na nota e o valor que ele deve receber. Ordenado por quem está na nota.
   */
  function listaOutros(lancamentos, parceiros) {
    const porId = {};
    (parceiros || []).forEach(function (p) { porId[p.id_parceiro] = p; });
    const erros = [];
    const itens = [];
    lancamentos.forEach(function (l) {
      if (l.situacao !== 'ENTREGOU' || !(num(l.peso_nome_outro) > 0)) return;
      const p = porId[l.id_parceiro];
      const apelido = normalizarNome((p && p.apelido) || l.apelido || (p && p.nome) || l.nome) || l.id_parceiro;
      let nota = '';
      if (!p) erros.push(apelido + ': parceiro ' + l.id_parceiro + ' não existe mais na aba Parceiros.');
      else {
        const m = acharParceiroDaNota(p, parceiros);
        if (m.erro) erros.push(m.erro);
        else nota = normalizarNome(m.parceiro.apelido || m.parceiro.nome);
      }
      itens.push({ id_parceiro: l.id_parceiro, apelido: apelido, nota: nota, motorista: normalizarNome(l.motorista),
        valor: arred(num(l.valor_parceiro), 2) });
    });
    itens.sort(function (a, b) {
      if (!a.nota !== !b.nota) return a.nota ? -1 : 1; // sem parceiro encontrado: no fim
      return a.nota.localeCompare(b.nota, 'pt-BR') || a.apelido.localeCompare(b.apelido, 'pt-BR');
    });
    return { itens: itens, erros: erros, ok: erros.length === 0,
      total: arred(itens.reduce(function (s, x) { return s + x.valor; }, 0), 2) };
  }

  /** Texto (WhatsApp) dos pagamentos em nome de outro. */
  function textoOutros(entrega, lista) {
    const L = ['*PAGAMENTOS COM NOTA EM NOME DE OUTRO – ' + fmtData(entrega.data_entrega) + '*', ''];
    lista.itens.forEach(function (x) {
      L.push('• *' + x.apelido + '* → nota de *' + x.nota + '*: ' + fmtR(x.valor));
    });
    L.push('');
    L.push('Total: ' + fmtR(lista.total) + ' (' + lista.itens.length + (lista.itens.length === 1 ? ' parceiro)' : ' parceiros)'));
    return L.join('\n');
  }

  const api = {
    ALIQUOTA_ICMS: ALIQUOTA_ICMS, arred: arred, semAcento: semAcento, normalizarNome: normalizarNome,
    fmtNum: fmtNum, fmtKg: fmtKg, fmtR: fmtR, fmtPreco: fmtPreco, fmtData: fmtData,
    acharParceiroDaNota: acharParceiroDaNota, montarNotas: montarNotas, resumir: resumir, textoWhatsApp: textoWhatsApp,
    listaOutros: listaOutros, textoOutros: textoOutros,
    listaDescontos: listaDescontos, rotuloDesconto: rotuloDesconto, textoDescontos: textoDescontos,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Notas = api;
})(typeof self !== 'undefined' ? self : this);
